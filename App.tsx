
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { 
  FolderOpen, Download, RotateCcw, Image as ImageIcon, 
  BarChart3, Smartphone, X, SmartphoneNfc,
  Check, X as XIcon, Globe, Save, Database, HardDrive, AlertCircle, RefreshCw,
  CheckCircle2, Home, ArrowLeft, Layers, History, Clock, ChevronRight,
  Loader2, Settings, Link, Trash2, FileCode, ShieldAlert, Terminal
} from 'lucide-react';
import Peer, { DataConnection } from 'peerjs';
import { QRCodeSVG } from 'qrcode.react';
import { ImageItem, Decision, PeerMessage, CullSession } from './types';
import { scanDirectory, getImageUrl, getFileDataUrl, deleteFile, generateDeletionScript } from './services/fileService';
import { dbService } from './services/dbService';
import { ImageCard } from './components/ImageCard';
import { Thumbnail } from './components/Thumbnail';

const App: React.FC = () => {
  // Navigation & Config State
  const [view, setView] = useState<'landing' | 'culling' | 'summary'>('landing');
  const [recentSessions, setRecentSessions] = useState<CullSession[]>([]);
  const [showPathPrompt, setShowPathPrompt] = useState<{ handle: FileSystemDirectoryHandle, relinkFrom?: string } | null>(null);
  const [customPath, setCustomPath] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [hostIp, setHostIp] = useState(localStorage.getItem('photocull_host_ip') || window.location.hostname);
  const [showCleanupOverlay, setShowCleanupOverlay] = useState(false);
  
  // Action State
  const [isRelinking, setIsRelinking] = useState(false);
  const [relinkProgress, setRelinkProgress] = useState({ current: 0, total: 0 });
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState({ current: 0, total: 0 });
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);

  // Culling State
  const [isScanning, setIsScanning] = useState(false);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [rootFolderName, setRootFolderName] = useState<string>('');
  const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [scanCount, setScanCount] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  
  // Remote State
  const [peer, setPeer] = useState<Peer | null>(null);
  const [peerId, setPeerId] = useState<string>('');
  const [connection, setConnection] = useState<DataConnection | null>(null);
  const [isRemote, setIsRemote] = useState(false);
  const [showRemotePanel, setShowRemotePanel] = useState(false);
  const [remoteImageCache, setRemoteImageCache] = useState<{ [index: number]: { dataUrl: string, name: string } }>({});

  const currentIndexRef = useRef(currentIndex);
  const historyRef = useRef<number[]>([]);

  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { historyRef.current = history; }, [history]);
  
  const remoteUrl = useMemo(() => {
    const protocol = window.location.protocol;
    const port = window.location.port ? `:${window.location.port}` : '';
    return `${protocol}//${hostIp}${port}/?peer=${peerId}`;
  }, [peerId, hostIp]);

  useEffect(() => {
    dbService.init();
  }, []);

  const saveHostIp = (ip: string) => {
    setHostIp(ip);
    localStorage.setItem('photocull_host_ip', ip);
  };

  useEffect(() => {
    if (images.length > 0 && !isRemote && view === 'culling') {
      const allDecided = images.every(img => img.decision !== 'pending');
      if (allDecided) {
        setView('summary');
      }
    }
  }, [images, isRemote, view]);

  const loadProjects = useCallback(async () => {
    const sessions = await dbService.getAllSessions();
    setRecentSessions(sessions.sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);

  useEffect(() => {
    if (view === 'landing') loadProjects();
  }, [view, loadProjects]);

  const stats = useMemo(() => {
    const kept = images.filter(img => img.decision === 'keep').length;
    const deleted = images.filter(img => img.decision === 'delete').length;
    const pending = images.filter(img => img.decision === 'pending').length;
    return {
      total: images.length,
      kept,
      deleted,
      pending,
      progress: images.length > 0 ? Math.round(((kept + deleted) / images.length) * 100) : 0
    };
  }, [images]);

  const performSave = useCallback(async (newImages: ImageItem[], newIndex: number) => {
    if (isRemote || !rootHandle) return;
    setIsSaving(true);
    try {
      const session: CullSession = {
        directoryName: rootFolderName,
        lastIndex: newIndex,
        totalImages: newImages.length,
        updatedAt: Date.now(),
        isDone: newImages.every(img => img.decision !== 'pending'),
        handle: rootHandle
      };
      await dbService.saveSession(session);

      const lastIndex = historyRef.current[historyRef.current.length - 1];
      if (lastIndex !== undefined) {
        await dbService.saveDecision({
          directoryName: rootFolderName,
          relativePath: newImages[lastIndex].relativePath,
          decision: newImages[lastIndex].decision
        });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  }, [rootHandle, rootFolderName, isRemote]);

  const makeDecision = useCallback(async (decision: Decision, specificIndex?: number) => {
    const targetIndex = specificIndex !== undefined ? specificIndex : currentIndexRef.current;
    if (targetIndex >= images.length) return;

    if (!isRemote) {
      const updatedImages = [...images];
      updatedImages[targetIndex] = { ...updatedImages[targetIndex], decision };
      setImages(updatedImages);
      setHistory(prev => [...prev, targetIndex]);
      
      const nextPendingIndex = updatedImages.findIndex((img, idx) => idx > targetIndex && img.decision === 'pending');
      const finalNextIndex = nextPendingIndex !== -1 ? nextPendingIndex : updatedImages.findIndex(img => img.decision === 'pending');
      
      const newIdx = finalNextIndex !== -1 ? finalNextIndex : targetIndex + 1;
      setCurrentIndex(newIdx);
      await performSave(updatedImages, newIdx);
      
      if (connection) connection.send({ type: 'DECISION_ACK', index: targetIndex } as PeerMessage);
    } else if (connection) {
      connection.send({ type: 'DECISION', decision, index: targetIndex } as PeerMessage);
    }
  }, [images, isRemote, connection, performSave]);

  const undoLast = useCallback(async () => {
    if (isRemote) {
      if (connection) connection.send({ type: 'UNDO' } as PeerMessage);
      return;
    }

    const currentHist = historyRef.current;
    if (currentHist.length === 0) return;

    const lastIndex = currentHist[currentHist.length - 1];
    const updatedImages = [...images];
    updatedImages[lastIndex] = { ...updatedImages[lastIndex], decision: 'pending' };
    
    setImages(updatedImages);
    setHistory(prev => prev.slice(0, -1));
    setCurrentIndex(lastIndex);
    
    await dbService.saveDecision({
      directoryName: rootFolderName,
      relativePath: updatedImages[lastIndex].relativePath,
      decision: 'pending'
    });
    
    await dbService.saveSession({
      directoryName: rootFolderName,
      lastIndex: lastIndex,
      totalImages: images.length,
      updatedAt: Date.now(),
      isDone: false,
      handle: rootHandle!
    });
  }, [images, isRemote, connection, rootFolderName, rootHandle]);

  const handlePeerMessage = useCallback((msg: PeerMessage) => {
    switch (msg.type) {
      case 'INIT_SYNC':
        setImages(msg.images.map(sim => ({ ...sim, handle: {} as FileSystemFileHandle, url: null })));
        setCurrentIndex(msg.currentIndex);
        setRootFolderName(msg.rootFolderName);
        setView(msg.view as any);
        break;
      case 'IMAGE_DATA':
        setRemoteImageCache(prev => ({ ...prev, [msg.index]: { dataUrl: msg.dataUrl, name: msg.name } }));
        break;
      case 'DECISION':
        makeDecision(msg.decision, msg.index);
        break;
      case 'DECISION_ACK':
        if (isRemote) setIsSaving(false);
        break;
      case 'UNDO':
        if (!isRemote) undoLast();
        break;
      case 'NAVIGATE':
        setView(msg.view);
        if (msg.index !== undefined) setCurrentIndex(msg.index);
        break;
    }
  }, [makeDecision, undoLast, isRemote]);

  const handlePeerMessageRef = useRef(handlePeerMessage);
  useEffect(() => { handlePeerMessageRef.current = handlePeerMessage; }, [handlePeerMessage]);

  const setupConnection = useCallback((conn: DataConnection) => {
    conn.on('open', () => { setConnection(conn); });
    conn.on('data', (data: any) => { handlePeerMessageRef.current(data as PeerMessage); });
    conn.on('close', () => { setConnection(null); });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const remoteId = params.get('peer');
    const newPeer = new Peer();
    newPeer.on('open', (id) => {
      setPeerId(id);
      if (remoteId) {
        setIsRemote(true);
        const conn = newPeer.connect(remoteId);
        setupConnection(conn);
      }
    });
    newPeer.on('connection', setupConnection);
    setPeer(newPeer);
    return () => newPeer.destroy();
  }, [setupConnection]);

  useEffect(() => {
    if (!isRemote && connection) {
      connection.send({ type: 'NAVIGATE', view, index: currentIndex });
    }
  }, [view, currentIndex, isRemote, connection]);

  useEffect(() => {
    if (!isRemote && connection && images.length > 0) {
      connection.send({ 
        type: 'INIT_SYNC', 
        images: images.map(img => ({ id: img.id, name: img.name, relativePath: img.relativePath, decision: img.decision })), 
        currentIndex, 
        rootFolderName,
        stats,
        view
      } as PeerMessage);

      const sendImage = async (index: number) => {
        if (index >= 0 && index < images.length && !remoteImageCache[index]) {
          try {
            const dataUrl = await getFileDataUrl(images[index].handle);
            connection.send({ type: 'IMAGE_DATA', index, id: images[index].id, name: images[index].name, dataUrl } as PeerMessage);
          } catch (e) {}
        }
      };
      sendImage(currentIndex);
      sendImage(currentIndex + 1);
      sendImage(currentIndex + 2);
    }
  }, [currentIndex, connection, isRemote, images.length, view, rootFolderName, stats]);

  const loadFolder = async (handle: FileSystemDirectoryHandle, overrideName?: string) => {
    setIsScanning(true);
    setScanCount(0);
    try {
      const { images: foundImages, rootName: defaultName } = await scanDirectory(handle, (c) => setScanCount(c));
      const targetName = overrideName || defaultName;
      const browserDecisions = await dbService.getDecisionsForDirectory(targetName);
      
      foundImages.forEach(img => {
        if (browserDecisions[img.relativePath]) img.decision = browserDecisions[img.relativePath];
      });

      const firstUndecidedIndex = foundImages.findIndex(img => img.decision === 'pending');
      const startIndex = firstUndecidedIndex !== -1 ? firstUndecidedIndex : 0;
      const allDone = firstUndecidedIndex === -1 && foundImages.length > 0;

      await dbService.storeHandleLocally(targetName, handle);

      setImages(foundImages);
      setRootFolderName(targetName);
      setRootHandle(handle);
      setCurrentIndex(startIndex);
      setHistory([]);
      setView(allDone ? 'summary' : 'culling');
    } catch (e) {
      console.error(e);
    } finally {
      setIsScanning(false);
    }
  };

  const handlePickDirectory = async (relinkFrom?: string) => {
    try {
      // @ts-ignore
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      setCustomPath(handle.name);
      setShowPathPrompt({ handle, relinkFrom });
    } catch (err) {
      setIsScanning(false);
    }
  };

  const confirmPathSelection = async () => {
    if (!showPathPrompt) return;

    if (showPathPrompt.relinkFrom) {
      setIsRelinking(true);
      try {
        await dbService.relinkSession(
          showPathPrompt.relinkFrom, 
          customPath, 
          showPathPrompt.handle,
          (count, total) => setRelinkProgress({ current: count, total })
        );
        await loadFolder(showPathPrompt.handle, customPath);
        await loadProjects();
      } catch (e) {
        console.error("Relink failed", e);
      } finally {
        setIsRelinking(false);
        setShowPathPrompt(null);
      }
    } else {
      await loadFolder(showPathPrompt.handle, customPath);
      setShowPathPrompt(null);
    }
  };

  const handleResumeProject = async (session: CullSession) => {
    const localHandle = await dbService.getHandleLocally(session.directoryName);
    if (localHandle) {
      try {
        if (await (localHandle as any).queryPermission({ mode: 'read' }) !== 'granted') {
          await (localHandle as any).requestPermission({ mode: 'read' });
        }
        await loadFolder(localHandle, session.directoryName);
      } catch (e) {
        handlePickDirectory(session.directoryName);
      }
    } else {
      handlePickDirectory(session.directoryName);
    }
  };

  const executeLiveDeletion = async () => {
    if (!rootHandle) return;
    
    // @ts-ignore
    const permission = await rootHandle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      alert("Permission denied. Deletion cannot proceed.");
      return;
    }

    // TRACK CURRENT IMAGE to avoid jumping after array shift
    const targetImgId = images[currentIndex]?.id;

    setIsDeleting(true);
    const toDelete = images.filter(img => img.decision === 'delete');
    setDeleteProgress({ current: 0, total: toDelete.length });

    let currentCount = 0;
    const updatedImages = [...images];

    for (const img of toDelete) {
      try {
        await deleteFile(img.handle);
        const idx = updatedImages.findIndex(i => i.id === img.id);
        if (idx !== -1) updatedImages.splice(idx, 1);
        
        await dbService.saveDecision({ directoryName: rootFolderName, relativePath: img.relativePath, decision: 'pending' });
      } catch (e) {
        console.error("Failed to delete", img.name, e);
      }
      currentCount++;
      setDeleteProgress({ current: currentCount, total: toDelete.length });
    }

    // Recalculate index
    let newIndex = 0;
    if (targetImgId) {
      const foundIdx = updatedImages.findIndex(i => i.id === targetImgId);
      if (foundIdx !== -1) {
        newIndex = foundIdx;
      } else {
        // Find next pending
        const pendingIdx = updatedImages.findIndex(i => i.decision === 'pending');
        newIndex = pendingIdx !== -1 ? pendingIdx : 0;
      }
    }

    setImages(updatedImages);
    setCurrentIndex(newIndex);
    setHistory([]); // Reset history because indices shifted
    setIsDeleting(false);
    setShowCleanupConfirm(false);
    setShowCleanupOverlay(false);
  };

  const downloadScript = (platform: 'win' | 'unix') => {
    const script = generateDeletionScript(images, rootFolderName, platform);
    const blob = new Blob([script], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = platform === 'win' ? 'delete_images.bat' : 'delete_images.sh';
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportResults = useCallback(() => {
    if (images.length === 0) return;
    const data = images.map(img => ({
      filename: img.name,
      relativePath: img.relativePath,
      fullPathLabel: `${rootFolderName}/${img.relativePath}`,
      decision: img.decision
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cull-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [images, rootFolderName]);

  // Shared Cleanup Component
  const CleanupHub = ({ isOverlay }: { isOverlay: boolean }) => (
    <div className={`${isOverlay ? 'p-10 space-y-10' : 'space-y-10'}`}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-blue-500 mb-2">
          <Trash2 size={24} />
          <h2 className="text-xl font-black uppercase italic tracking-tighter text-white">Cleanup Hub</h2>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">Choose how to process your rejected files. Direct deletion requires high-level browser permissions.</p>
      </div>

      <div className="space-y-6">
        <div className="p-6 bg-slate-950/50 border border-slate-800 rounded-[2rem] space-y-4">
          <div className="flex items-center gap-3">
             <div className="p-2 bg-red-500/10 rounded-xl"><ShieldAlert size={20} className="text-red-500" /></div>
             <h3 className="text-xs font-black text-white uppercase tracking-widest">Live Delete</h3>
          </div>
          <p className="text-[10px] text-slate-500 font-medium">Permanently removes {stats.deleted} files from your disk. Irreversible.</p>
          <button 
            onClick={() => setShowCleanupConfirm(true)}
            disabled={stats.deleted === 0 || isDeleting}
            className="w-full py-4 bg-red-600 hover:bg-red-500 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all shadow-xl disabled:opacity-30 flex items-center justify-center gap-2"
          >
            {isDeleting ? <RefreshCw className="animate-spin" size={14} /> : <Trash2 size={14} />} 
            {isDeleting ? "Deleting..." : "Execute Destruction"}
          </button>
          {isDeleting && (
            <div className="space-y-2 mt-4">
              <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-red-500 transition-all" style={{ width: `${(deleteProgress.current / deleteProgress.total) * 100}%` }} />
              </div>
              <p className="text-[9px] font-bold text-slate-600 text-right uppercase tracking-widest">{deleteProgress.current} / {deleteProgress.total}</p>
            </div>
          )}
        </div>

        <div className="p-6 bg-slate-950/50 border border-slate-800 rounded-[2rem] space-y-4">
          <div className="flex items-center gap-3">
             <div className="p-2 bg-blue-500/10 rounded-xl"><Terminal size={20} className="text-blue-500" /></div>
             <h3 className="text-xs font-black text-white uppercase tracking-widest">Dev / Scripting</h3>
          </div>
          <p className="text-[10px] text-slate-500 font-medium">Generate a safe script to execute locally on your machine.</p>
          <div className="grid grid-cols-2 gap-3">
            <button 
              onClick={() => downloadScript('win')}
              className="py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-bold text-[10px] uppercase tracking-widest transition-all flex flex-col items-center gap-1"
            >
              <FileCode size={14} /> WINDOWS (.bat)
            </button>
            <button 
              onClick={() => downloadScript('unix')}
              className="py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-bold text-[10px] uppercase tracking-widest transition-all flex flex-col items-center gap-1"
            >
              <FileCode size={14} /> UNIX (.sh)
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // View: Landing
  if (view === 'landing' && !isRemote) {
    return (
      <div className="min-h-[100dvh] flex flex-col bg-[#0f172a] p-8 overflow-y-auto custom-scrollbar">
        <div className="max-w-5xl w-full mx-auto space-y-12 py-10">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
            <div className="flex-1">
              <div className="flex items-center gap-4 mb-2">
                <h1 className="text-7xl font-black text-white italic tracking-tighter">PHOTOCULL<span className="text-blue-500 font-sans not-italic ml-2">PRO</span></h1>
                <button 
                  onClick={() => setShowSettings(true)}
                  className="p-3 bg-slate-800 rounded-2xl text-slate-400 hover:text-white transition-all hover:bg-slate-700"
                >
                  <Settings size={24} />
                </button>
              </div>
              <p className="text-slate-400 text-lg italic opacity-80">Sync decisions to PocketBase and cleanup locally.</p>
            </div>
            <button 
              onClick={() => handlePickDirectory()}
              disabled={isScanning}
              className="bg-blue-600 hover:bg-blue-500 text-white font-black px-8 py-5 rounded-[2rem] flex items-center gap-3 transition-all active:scale-95 shadow-2xl shadow-blue-900/20 whitespace-nowrap"
            >
              <FolderOpen size={24} />
              {isScanning ? `Indexing ${scanCount}...` : "START NEW PROJECT"}
            </button>
          </div>

          <div className="space-y-6">
            <div className="flex items-center gap-3 text-slate-500 font-black text-xs uppercase tracking-widest">
              <History size={16} /> 
              Recent Projects
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {recentSessions.length === 0 ? (
                <div className="col-span-full py-20 border-2 border-dashed border-slate-800 rounded-[3rem] flex flex-col items-center text-slate-600">
                  <Layers size={48} className="mb-4 opacity-20" />
                  <p className="font-bold">No projects available.</p>
                </div>
              ) : (
                recentSessions.map(session => (
                  <div 
                    key={session.directoryName}
                    className="group bg-slate-900/50 border border-slate-800 p-6 rounded-[2.5rem] text-left hover:bg-slate-800/80 transition-all hover:border-blue-500/50 relative overflow-hidden"
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div className="p-3 bg-slate-800 rounded-2xl group-hover:bg-blue-500/20 transition-colors">
                        <ImageIcon size={24} className="text-slate-400 group-hover:text-blue-500" />
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={(e) => { e.stopPropagation(); handlePickDirectory(session.directoryName); }}
                          title="Relink to different folder (e.g. drive letter change)"
                          className="p-2 hover:bg-slate-700 rounded-lg text-slate-500 hover:text-white transition-all"
                        >
                          <Link size={16} />
                        </button>
                        {session.isDone && <CheckCircle2 className="text-green-500" size={20} />}
                      </div>
                    </div>
                    
                    <button onClick={() => handleResumeProject(session)} className="w-full text-left outline-none group">
                      <h3 className="text-xs font-black text-white truncate mb-1 break-all leading-tight opacity-90 group-hover:text-blue-400 transition-colors" title={session.directoryName}>
                        {session.directoryName}
                      </h3>
                      <div className="flex items-center gap-4 text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-2">
                        <span className="flex items-center gap-1"><Clock size={12}/> {new Date(session.updatedAt).toLocaleDateString()}</span>
                        <span>{session.totalImages} Photos</span>
                      </div>
                      <div className="mt-6 flex items-center justify-between">
                        <div className="flex-1 h-1.5 bg-slate-800 rounded-full mr-4 overflow-hidden">
                          <div className="h-full bg-blue-500" style={{ width: `${Math.round((session.lastIndex / session.totalImages) * 100)}%` }} />
                        </div>
                        <span className="text-[10px] font-black text-white">{Math.round((session.lastIndex / session.totalImages) * 100)}%</span>
                      </div>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-2xl z-[150] flex items-center justify-center p-6">
            <div className="bg-slate-900 border border-slate-800 rounded-[3rem] p-10 max-w-xl w-full shadow-2xl">
              <div className="flex items-center gap-3 mb-4">
                <Settings className="text-blue-500" size={32} />
                <h2 className="text-2xl font-black text-white uppercase italic tracking-tighter">Host Configuration</h2>
              </div>
              <p className="text-slate-400 text-sm mb-6 leading-relaxed">Configure how mobile devices find this machine on your local network.</p>
              <div className="space-y-6">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-500 mb-2 block">Host Machine IP (for QR Code)</label>
                  <input 
                    type="text" 
                    value={hostIp} 
                    onChange={(e) => saveHostIp(e.target.value)}
                    placeholder="192.168.1.XX"
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl p-5 text-white font-mono text-sm focus:border-blue-500 outline-none transition-colors"
                  />
                </div>
              </div>
              <div className="mt-10 flex gap-4">
                <button onClick={() => setShowSettings(false)} className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-blue-500 shadow-xl transition-all">Save & Close</button>
              </div>
            </div>
          </div>
        )}

        {/* Relink Dialog */}
        {showPathPrompt && (
          <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-2xl z-[100] flex items-center justify-center p-6">
            <div className="bg-slate-900 border border-slate-800 rounded-[3rem] p-10 max-w-xl w-full shadow-2xl">
              <div className="flex items-center gap-3 mb-4">
                <HardDrive className="text-blue-500" size={32} />
                <h2 className="text-2xl font-black text-white uppercase italic tracking-tighter">{showPathPrompt.relinkFrom ? 'Relink Project' : 'Verify Path'}</h2>
              </div>
              <input 
                autoFocus type="text" value={customPath} onChange={(e) => setCustomPath(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl p-5 text-white font-mono text-sm mb-8 focus:border-blue-500 outline-none"
              />
              <div className="flex gap-4">
                <button onClick={() => setShowPathPrompt(null)} className="flex-1 py-4 bg-slate-800 text-slate-400 rounded-2xl font-bold">Cancel</button>
                <button onClick={confirmPathSelection} className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-black">{isRelinking ? 'Relinking...' : 'Confirm'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // View: Remote Handset (Mobile UI)
  if (isRemote) {
    return (
      <div className="h-[100dvh] bg-slate-950 flex flex-col items-center p-4 overflow-hidden relative">
        {!connection ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6 z-10">
            <SmartphoneNfc size={80} className="text-blue-500 animate-pulse" />
            <h1 className="text-2xl font-bold tracking-tighter">Connecting...</h1>
          </div>
        ) : (
          <div className="w-full h-full flex flex-col z-10">
            <header className="flex justify-between items-center py-3 border-b border-slate-800">
              <div className="flex flex-col overflow-hidden max-w-[60%]">
                <span className="text-[10px] font-bold uppercase tracking-widest text-blue-500">Handset Mode</span>
                <span className="text-[9px] text-slate-500 font-mono truncate">{rootFolderName}</span>
              </div>
              <div className="flex items-center gap-2">
                 <button onClick={() => undoLast()} className="p-2 bg-slate-800 rounded-lg text-slate-300 active:bg-blue-500/20"><RotateCcw size={18}/></button>
                 <button onClick={() => connection.send({ type: 'NAVIGATE', view: 'landing' })} className="p-2 bg-slate-800 rounded-lg text-slate-300"><Home size={18}/></button>
              </div>
            </header>
            <main className="flex-1 relative my-4 overflow-hidden">
               {view === 'summary' ? (
                 <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
                    <CheckCircle2 size={48} className="text-blue-500" />
                    <h2 className="font-bold text-white uppercase italic">Batch Complete</h2>
                 </div>
               ) : (currentIndex < images.length && remoteImageCache[currentIndex]) ? (
                  <ImageCard 
                    key={currentIndex}
                    image={{ ...images[currentIndex], name: remoteImageCache[currentIndex].name }}
                    onDecision={(d) => makeDecision(d as Decision)}
                    isFront={true}
                    remoteDataUrl={remoteImageCache[currentIndex].dataUrl}
                  />
               ) : (
                 <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-3">
                   <Loader2 className="animate-spin text-blue-500" size={32} />
                   <p className="text-[10px] uppercase font-bold tracking-widest animate-pulse">Buffering Preview</p>
                 </div>
               )}
            </main>
          </div>
        )}
      </div>
    );
  }

  // View: Summary Dashboard
  if (view === 'summary') {
    return (
      <div className="h-[100dvh] flex flex-col bg-[#0f172a] overflow-hidden">
        <header className="px-8 py-6 flex items-center justify-between border-b border-slate-800 bg-slate-900/50 backdrop-blur-xl z-50">
          <div className="flex items-center gap-4">
            <button onClick={() => setView('landing')} className="p-3 bg-slate-800 rounded-2xl text-slate-400 hover:text-white transition-all"><ArrowLeft size={20}/></button>
            <div className="max-w-[40vw]">
               <h1 className="text-xl font-black text-white italic truncate" title={rootFolderName}>SUMMARY <span className="text-slate-500 font-sans not-italic text-sm ml-2">{rootFolderName}</span></h1>
               <div className="flex items-center gap-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">
                 <span className="text-green-500">{stats.kept} Kept</span>
                 <span className="text-red-500">{stats.deleted} Deleted</span>
                 <span className="text-slate-400">{stats.pending} Unsorted</span>
               </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={() => { setCurrentIndex(0); setView('culling'); }} className="px-6 py-3 bg-slate-800 text-white rounded-2xl font-black text-xs uppercase tracking-widest flex items-center gap-2 hover:bg-slate-700 transition-colors"><RotateCcw size={16}/> RESTART</button>
            <button onClick={exportResults} className="bg-slate-100 hover:bg-white text-slate-900 px-8 py-3 rounded-2xl font-black text-xs transition-all uppercase flex items-center gap-2 shadow-xl"><Download size={18} /> Export JSON</button>
          </div>
        </header>

        <main className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-4">
          <div className="lg:col-span-3 overflow-y-auto p-8 custom-scrollbar bg-slate-950/20">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-6">
              {images.map((img, idx) => (
                <Thumbnail 
                  key={img.id} 
                  image={img} 
                  onClick={() => { setCurrentIndex(idx); setView('culling'); }} 
                />
              ))}
            </div>
          </div>

          <aside className="border-l border-slate-800 bg-slate-900/40 overflow-y-auto custom-scrollbar">
            <CleanupHub isOverlay={false} />
          </aside>
        </main>
        
        {showCleanupConfirm && (
          <div className="fixed inset-0 bg-slate-950/98 backdrop-blur-3xl z-[200] flex items-center justify-center p-6">
            <div className="bg-slate-900 border border-red-500/20 rounded-[3rem] p-12 max-w-lg w-full text-center space-y-8 shadow-2xl">
              <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto"><ShieldAlert size={48} className="text-red-500" /></div>
              <div className="space-y-4">
                <h2 className="text-3xl font-black text-white uppercase italic tracking-tighter">Confirm Destruction</h2>
                <p className="text-slate-400 text-sm leading-relaxed">Delete <span className="text-red-500 font-black">{stats.deleted} files</span> permanently from storage?</p>
              </div>
              <div className="flex gap-4 pt-4">
                <button onClick={() => setShowCleanupConfirm(false)} className="flex-1 py-5 bg-slate-800 text-slate-400 rounded-2xl font-black uppercase tracking-widest">Cancel</button>
                <button onClick={executeLiveDeletion} className="flex-1 py-5 bg-red-600 text-white rounded-2xl font-black uppercase tracking-widest shadow-xl">CONFIRM DELETE</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // View: Main Culling UI
  return (
    <div className="h-[100dvh] flex flex-col bg-slate-950 overflow-hidden relative">
      <header className="px-6 py-4 flex items-center justify-between border-b border-slate-800 bg-slate-900/50 backdrop-blur-md z-50">
        <div className="flex items-center gap-4">
          <button onClick={() => setView('landing')} className="p-2.5 bg-slate-800 rounded-xl text-slate-400 hover:text-white transition-all"><Home size={20}/></button>
          <div className="max-w-[150px] md:max-w-md">
            <h1 className="text-sm font-black text-white uppercase tracking-widest">PhotoCull Pro</h1>
            <div className="flex items-center gap-2 overflow-hidden text-[9px]">
               <div className="flex items-center gap-1 font-bold uppercase text-blue-500 shrink-0"><Database size={10} /> PB SYNC</div>
               <span className="text-slate-800 shrink-0">•</span>
               <span className="text-slate-500 font-mono uppercase truncate" title={rootFolderName}>{rootFolderName}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => undoLast()} disabled={history.length === 0} className="p-2.5 bg-slate-800 rounded-xl text-slate-400 hover:text-white disabled:opacity-20"><RotateCcw size={20}/></button>
          <button onClick={() => setShowRemotePanel(true)} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black transition-all ${connection ? 'bg-green-600 text-white' : 'bg-slate-800 text-slate-300'}`}><Smartphone size={16} /> REMOTE</button>
          <button onClick={() => setView('summary')} className="p-2.5 bg-slate-800 rounded-xl text-slate-400 hover:text-white hover:bg-blue-500/10"><BarChart3 size={20}/></button>
          <button onClick={exportResults} className="bg-white text-slate-950 px-5 py-2.5 rounded-xl font-black text-xs hover:bg-slate-200 transition-all uppercase shadow-lg"><Download size={18} /> Export</button>
        </div>
      </header>

      <div className="h-1.5 w-full bg-slate-800/50">
        <div className="h-full bg-blue-500 transition-all duration-700" style={{ width: `${stats.progress}%` }} />
      </div>

      <main className="flex-1 relative flex items-center justify-center p-6 overflow-hidden bg-slate-950">
        {currentIndex < images.length ? (
          <div className="w-full max-w-2xl aspect-[4/5] relative h-full max-h-[75vh] z-10">
            {isSaving && (
               <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[60] bg-slate-900/95 px-5 py-2.5 rounded-full border border-slate-700 flex items-center gap-3 shadow-2xl backdrop-blur-sm">
                 <RefreshCw size={14} className="animate-spin text-blue-500" />
                 <span className="text-[10px] font-black uppercase text-white tracking-widest">PB Syncing</span>
               </div>
            )}
            <ImageCard key={images[currentIndex].id} image={images[currentIndex]} onDecision={(d) => makeDecision(d as Decision)} isFront={true} />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-6 text-center animate-in fade-in zoom-in duration-500">
             <div className="p-8 bg-slate-900 rounded-[3rem] border border-slate-800 shadow-2xl">
                <CheckCircle2 size={80} className="text-green-500 mx-auto mb-6" />
                <h2 className="text-4xl font-black text-white italic tracking-tighter uppercase">Batch Complete</h2>
                <button onClick={() => setView('summary')} className="mt-8 bg-blue-600 hover:bg-blue-500 text-white px-10 py-4 rounded-2xl font-black uppercase tracking-widest">View Summary</button>
             </div>
          </div>
        )}
      </main>

      <footer className="px-6 py-4 bg-slate-900/80 border-t border-slate-800 flex justify-between text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] backdrop-blur-sm relative z-[110]">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2"><Database size={12} className="text-blue-500"/> PocketBase :8090</span>
          <span className="hidden md:flex items-center gap-2"><ImageIcon size={12} className="text-slate-600"/> {stats.pending} Undecided</span>
          {stats.deleted > 0 && (
            <button 
              onClick={() => setShowCleanupOverlay(true)}
              className="flex items-center gap-2 bg-red-600/20 text-red-500 px-4 py-1.5 rounded-full border border-red-500/20 hover:bg-red-500 hover:text-white transition-all animate-pulse"
            >
              <Trash2 size={12} /> {stats.deleted} IN TRASH • CLEANUP NOW
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono">
           <span className="text-white">{images.length - stats.pending}</span> / <span className="opacity-50">{images.length}</span>
        </div>
      </footer>

      {showCleanupOverlay && (
        <div className="fixed inset-0 bg-slate-950/98 backdrop-blur-3xl z-[150] flex items-center justify-center p-6 animate-in fade-in zoom-in duration-300">
           <div className="bg-slate-900 border border-slate-800 rounded-[3rem] max-w-2xl w-full relative shadow-2xl overflow-hidden">
             <button onClick={() => setShowCleanupOverlay(false)} className="absolute top-8 right-8 text-slate-400 hover:text-white transition-colors z-[160]"><X size={28}/></button>
             <CleanupHub isOverlay={true} />
           </div>
        </div>
      )}

      {showRemotePanel && (
        <div className="fixed inset-0 bg-slate-950/98 backdrop-blur-3xl z-[100] flex items-center justify-center p-6">
          <div className="bg-slate-900 border border-slate-800 rounded-[3rem] p-12 max-w-lg w-full relative">
            <button onClick={() => setShowRemotePanel(false)} className="absolute top-8 right-8 text-slate-400 hover:text-white transition-colors"><X size={28}/></button>
            <div className="text-center space-y-8">
              <h2 className="text-3xl font-black text-white uppercase italic tracking-tighter">Remote Link</h2>
              <div className="bg-white p-6 rounded-[2.5rem] inline-block mx-auto"><QRCodeSVG value={remoteUrl} size={240} level="H" /></div>
              <p className="text-slate-500 text-[10px] uppercase tracking-widest font-black pt-2">Scan to cull from mobile</p>
              <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800 text-[10px] font-mono text-blue-500 break-all">{remoteUrl}</div>
              {connection && <div className="bg-green-500/10 text-green-500 py-4 rounded-2xl font-black text-xs tracking-widest animate-pulse border border-green-500/20 flex items-center justify-center gap-2"><Smartphone size={16} /> MOBILE LINK ACTIVE</div>}
            </div>
          </div>
        </div>
      )}

      {showCleanupConfirm && (
        <div className="fixed inset-0 bg-slate-950/98 backdrop-blur-3xl z-[200] flex items-center justify-center p-6">
          <div className="bg-slate-900 border border-red-500/20 rounded-[3rem] p-12 max-w-lg w-full text-center space-y-8 shadow-2xl">
            <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto"><ShieldAlert size={48} className="text-red-500" /></div>
            <div className="space-y-4">
              <h2 className="text-3xl font-black text-white uppercase italic tracking-tighter">Confirm Destruction</h2>
              <p className="text-slate-400 text-sm leading-relaxed">Permanently delete <span className="text-red-500 font-black">{stats.deleted} files</span>?</p>
            </div>
            <div className="flex gap-4 pt-4">
              <button onClick={() => setShowCleanupConfirm(false)} className="flex-1 py-5 bg-slate-800 text-slate-400 rounded-2xl font-black uppercase tracking-widest hover:text-white transition-all">Cancel</button>
              <button onClick={executeLiveDeletion} className="flex-1 py-5 bg-red-600 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-red-500 shadow-xl transition-all">CONFIRM DELETE</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
