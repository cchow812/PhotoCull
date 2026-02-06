
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { 
  FolderOpen, Download, RotateCcw, Image as ImageIcon, 
  BarChart3, Smartphone, X, SmartphoneNfc,
  Check, X as XIcon, Globe, Save, Database, HardDrive, AlertCircle, RefreshCw,
  CheckCircle2, Home, ArrowLeft, Layers, History, Clock, ChevronRight,
  Loader2
} from 'lucide-react';
import Peer, { DataConnection } from 'peerjs';
import { QRCodeSVG } from 'qrcode.react';
import { ImageItem, Decision, PeerMessage, CullSession } from './types';
import { scanDirectory, getImageUrl, getFileDataUrl } from './services/fileService';
import { dbService } from './services/dbService';
import { ImageCard } from './components/ImageCard';
import { Thumbnail } from './components/Thumbnail';

const App: React.FC = () => {
  // Navigation State
  const [view, setView] = useState<'landing' | 'culling' | 'summary'>('landing');
  const [recentSessions, setRecentSessions] = useState<CullSession[]>([]);
  const [showPathPrompt, setShowPathPrompt] = useState<{ handle: FileSystemDirectoryHandle } | null>(null);
  const [customPath, setCustomPath] = useState('');

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

  // Update refs to avoid closure staleness
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { historyRef.current = history; }, [history]);
  
  // IP Override for QR
  const remoteUrl = useMemo(() => {
    // Note: In a real local setup, this should be the host IP
    return `http://192.168.50.229:3000/?peer=${peerId}`;
  }, [peerId]);

  useEffect(() => {
    dbService.init();
  }, []);

  useEffect(() => {
    if (images.length > 0 && currentIndex >= images.length && view !== 'summary' && !isRemote) {
      setView('summary');
    }
  }, [currentIndex, images.length, view, isRemote]);

  useEffect(() => {
    const loadProjects = async () => {
      const sessions = await dbService.getAllSessions();
      setRecentSessions(sessions.sort((a, b) => b.updatedAt - a.updatedAt));
    };
    if (view === 'landing') loadProjects();
  }, [view]);

  const stats = useMemo(() => {
    const kept = images.filter(img => img.decision === 'keep').length;
    const deleted = images.filter(img => img.decision === 'delete').length;
    return {
      total: images.length,
      kept,
      deleted,
      remaining: images.length - (kept + deleted),
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
        isDone: newIndex >= newImages.length,
        handle: rootHandle
      };
      await dbService.saveSession(session);

      // Save the specific decision for the item that was just processed
      // If we are moving forward, it's newIndex - 1. If we are undoing, the item is now pending.
      if (newIndex >= 0 && newIndex <= newImages.length) {
        const lastDecidedIndex = historyRef.current[historyRef.current.length - 1];
        if (lastDecidedIndex !== undefined) {
          await dbService.saveDecision({
            directoryName: rootFolderName,
            relativePath: newImages[lastDecidedIndex].relativePath,
            decision: newImages[lastDecidedIndex].decision
          });
        }
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
      const nextIndex = targetIndex + 1;
      setCurrentIndex(nextIndex);
      await performSave(updatedImages, nextIndex);
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
    
    // We update the record in DB for that index to be pending again
    await dbService.saveDecision({
      directoryName: rootFolderName,
      relativePath: updatedImages[lastIndex].relativePath,
      decision: 'pending'
    });
    
    // Save session progress
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
        if (isRemote) {
          setCurrentIndex(msg.index + 1);
          setIsSaving(false);
        }
        break;
      case 'UNDO':
        if (!isRemote) {
          undoLast();
        }
        // Remote (Mobile) doesn't decrement manually here; it trusts the subsequent NAVIGATE from host.
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

  // Sync index and view from Host to Remote
  useEffect(() => {
    if (!isRemote && connection) {
      connection.send({ type: 'NAVIGATE', view, index: currentIndex });
    }
  }, [view, currentIndex, isRemote, connection]);

  // Push images to remote cache for pre-loading
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
      // Send current and next 2 for smooth swiping
      sendImage(currentIndex);
      sendImage(currentIndex + 1);
      sendImage(currentIndex + 2);
    }
  }, [currentIndex, connection, isRemote, images.length, view, rootFolderName]);

  const loadFolder = async (handle: FileSystemDirectoryHandle, overrideName?: string) => {
    setIsScanning(true);
    setScanCount(0);
    try {
      const { images: foundImages, rootName: defaultName } = await scanDirectory(handle, (c) => setScanCount(c));
      const targetName = overrideName || defaultName;
      
      const browserSession = await dbService.getSession(targetName);
      const browserDecisions = await dbService.getDecisionsForDirectory(targetName);
      
      let startIndex = browserSession?.lastIndex || 0;
      foundImages.forEach(img => {
        if (browserDecisions[img.relativePath]) img.decision = browserDecisions[img.relativePath];
      });

      await dbService.storeHandleLocally(targetName, handle);

      setImages(foundImages);
      setRootFolderName(targetName);
      setRootHandle(handle);
      setCurrentIndex(startIndex >= foundImages.length ? 0 : startIndex);
      setHistory([]);
      setView(startIndex >= foundImages.length ? 'summary' : 'culling');
    } catch (e) {
      console.error(e);
    } finally {
      setIsScanning(false);
    }
  };

  const handlePickDirectory = async () => {
    try {
      // @ts-ignore
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      // Default to what the user expects: showing a suggested full path prompt
      setCustomPath(handle.name);
      setShowPathPrompt({ handle });
    } catch (err) {
      setIsScanning(false);
    }
  };

  const confirmPathSelection = async () => {
    if (showPathPrompt) {
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
        handlePickDirectory();
      }
    } else {
      handlePickDirectory();
    }
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

  // View: Landing
  if (view === 'landing' && !isRemote) {
    return (
      <div className="min-h-[100dvh] flex flex-col bg-[#0f172a] p-8 overflow-y-auto custom-scrollbar">
        <div className="max-w-5xl w-full mx-auto space-y-12 py-10">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
            <div>
              <h1 className="text-7xl font-black text-white italic tracking-tighter">PHOTOCULL<span className="text-blue-500 font-sans not-italic ml-2">PRO</span></h1>
              <p className="text-slate-400 mt-2 text-lg">Local path persistence via PocketBase + Browser Handles.</p>
            </div>
            <button 
              onClick={handlePickDirectory}
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
                  <p className="font-bold">No projects available. Connect your storage to begin.</p>
                </div>
              ) : (
                recentSessions.map(session => (
                  <button 
                    key={session.directoryName}
                    onClick={() => handleResumeProject(session)}
                    className="group bg-slate-900/50 border border-slate-800 p-6 rounded-[2.5rem] text-left hover:bg-slate-800/80 transition-all hover:border-blue-500/50 relative overflow-hidden"
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div className="p-3 bg-slate-800 rounded-2xl group-hover:bg-blue-500/20 transition-colors">
                        <ImageIcon size={24} className="text-slate-400 group-hover:text-blue-500" />
                      </div>
                      {session.isDone && <CheckCircle2 className="text-green-500" size={20} />}
                    </div>
                    <h3 className="text-xs font-black text-white truncate mb-1 break-all leading-tight opacity-90" title={session.directoryName}>
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
                ))
              )}
            </div>
          </div>
        </div>

        {/* Full Path Label Prompt */}
        {showPathPrompt && (
          <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-2xl z-[100] flex items-center justify-center p-6">
            <div className="bg-slate-900 border border-slate-800 rounded-[3rem] p-10 max-w-xl w-full shadow-2xl">
              <div className="flex items-center gap-3 mb-4">
                <HardDrive className="text-blue-500" size={32} />
                <h2 className="text-2xl font-black text-white uppercase italic tracking-tighter">Enter Full Qualified Path</h2>
              </div>
              <p className="text-slate-400 text-sm mb-6 leading-relaxed">To ensure correct culling records, enter the full local OS path for this directory (e.g. <span className="text-white font-mono">F:\Photos\NAS\2024</span>).</p>
              <input 
                autoFocus
                type="text" 
                value={customPath} 
                onChange={(e) => setCustomPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && confirmPathSelection()}
                placeholder="E:\MyPhotos\ProjectX"
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl p-5 text-white font-mono text-sm mb-8 focus:border-blue-500 outline-none transition-colors"
              />
              <div className="flex gap-4">
                <button onClick={() => setShowPathPrompt(null)} className="flex-1 py-4 bg-slate-800 text-slate-400 rounded-2xl font-bold hover:text-white transition-all uppercase text-xs tracking-widest">Cancel</button>
                <button onClick={confirmPathSelection} className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-blue-500 shadow-xl transition-all">Start Scanning</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // View: Remote Sync (Mobile UI)
  if (isRemote) {
    return (
      <div className="h-[100dvh] bg-slate-950 flex flex-col items-center p-4 overflow-hidden relative">
        {!connection ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6 z-10">
            <SmartphoneNfc size={80} className="text-blue-500 animate-pulse" />
            <h1 className="text-2xl font-bold tracking-tighter">Connecting...</h1>
            <p className="text-slate-500 text-xs">Waiting for host response</p>
          </div>
        ) : (
          <div className="w-full h-full flex flex-col z-10">
            <header className="flex justify-between items-center py-3 border-b border-slate-800">
              <div className="flex flex-col overflow-hidden max-w-[60%]">
                <span className="text-[10px] font-bold uppercase tracking-widest text-blue-500">Remote Handset</span>
                <span className="text-[9px] text-slate-500 font-mono truncate">{rootFolderName || 'Awaiting Project...'}</span>
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
                    <h2 className="font-bold">Project Summary</h2>
                    <p className="text-xs text-slate-500">Viewing finished state on host</p>
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
            <button onClick={() => setView('landing')} className="p-3 bg-slate-800 rounded-2xl text-slate-400 hover:text-white"><ArrowLeft size={20}/></button>
            <div className="max-w-[40vw]">
               <h1 className="text-xl font-black text-white italic truncate" title={rootFolderName}>SUMMARY <span className="text-slate-500 font-sans not-italic text-sm ml-2">{rootFolderName}</span></h1>
               <div className="flex items-center gap-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">
                 <span className="text-green-500">{stats.kept} Kept</span>
                 <span className="text-red-500">{stats.deleted} Deleted</span>
                 <span className="text-slate-400">{stats.remaining} Unsorted</span>
               </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={() => { setCurrentIndex(0); setView('culling'); }} className="px-6 py-3 bg-slate-800 text-white rounded-2xl font-black text-xs uppercase tracking-widest flex items-center gap-2 hover:bg-slate-700 transition-colors"><RotateCcw size={16}/> RESTART</button>
            <button onClick={exportResults} className="bg-blue-600 hover:bg-blue-500 text-white px-8 py-3 rounded-2xl font-black text-xs transition-all uppercase flex items-center gap-2 shadow-xl"><Download size={18} /> Export Results</button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-slate-950/20">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-6">
            {images.map((img, idx) => (
              <Thumbnail 
                key={img.id} 
                image={img} 
                onClick={() => { setCurrentIndex(idx); setView('culling'); }} 
              />
            ))}
          </div>
        </main>
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
            <div className="flex items-center gap-2 overflow-hidden">
               <div className={`flex items-center gap-1 text-[9px] font-bold uppercase text-blue-500 shrink-0`}>
                 <Database size={10} /> PB SYNC
               </div>
               <span className="text-slate-800 shrink-0">•</span>
               <span className="text-[9px] text-slate-500 font-mono uppercase truncate" title={rootFolderName}>{rootFolderName}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={() => undoLast()} 
            disabled={history.length === 0}
            title="Undo Selection (Ctrl+Z)"
            className="p-2.5 bg-slate-800 rounded-xl text-slate-400 hover:text-white transition-all disabled:opacity-20 hover:bg-blue-500/10"
          >
            <RotateCcw size={20}/>
          </button>
          <button 
            onClick={() => setShowRemotePanel(true)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black transition-all ${connection ? 'bg-green-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            <Smartphone size={16} /> REMOTE
          </button>
          <button onClick={() => setView('summary')} className="p-2.5 bg-slate-800 rounded-xl text-slate-400 hover:text-white hover:bg-blue-500/10"><BarChart3 size={20}/></button>
          <button onClick={exportResults} className="bg-white text-slate-950 px-5 py-2.5 rounded-xl font-black text-xs hover:bg-slate-200 transition-all uppercase shadow-lg"><Download size={18} /> Export</button>
        </div>
      </header>

      <div className="h-1.5 w-full bg-slate-800/50">
        <div className="h-full bg-blue-500 transition-all duration-700 shadow-[0_0_10px_rgba(59,130,246,0.5)]" style={{ width: `${stats.progress}%` }} />
      </div>

      <main className="flex-1 relative flex items-center justify-center p-6 overflow-hidden bg-slate-950">
        {currentIndex < images.length ? (
          <div className="w-full max-w-2xl aspect-[4/5] relative h-full max-h-[75vh] z-10">
            {isSaving && (
               <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[60] bg-slate-900/95 px-5 py-2.5 rounded-full border border-slate-700 flex items-center gap-3 shadow-2xl backdrop-blur-sm">
                 <RefreshCw size={14} className="animate-spin text-blue-500" />
                 <span className="text-[10px] font-black uppercase text-white tracking-widest">PocketBase Sync</span>
               </div>
            )}
            <ImageCard 
              key={images[currentIndex].id} 
              image={images[currentIndex]} 
              onDecision={(d) => makeDecision(d as Decision)} 
              isFront={true} 
            />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-6 text-center animate-in fade-in zoom-in duration-500">
             <div className="p-8 bg-slate-900 rounded-[3rem] border border-slate-800 shadow-2xl">
                <CheckCircle2 size={80} className="text-green-500 mx-auto mb-6" />
                <h2 className="text-4xl font-black text-white italic tracking-tighter uppercase">Batch Complete</h2>
                <p className="text-slate-400 mt-2 max-w-xs mx-auto">You have successfully culled all photos in this session.</p>
                <button 
                  onClick={() => setView('summary')}
                  className="mt-8 bg-blue-600 hover:bg-blue-500 text-white px-10 py-4 rounded-2xl font-black uppercase tracking-widest transition-all shadow-xl"
                >
                  View Final Results
                </button>
             </div>
          </div>
        )}
      </main>

      {showRemotePanel && (
        <div className="fixed inset-0 bg-slate-950/98 backdrop-blur-3xl z-[100] flex items-center justify-center p-6">
          <div className="bg-slate-900 border border-slate-800 rounded-[3rem] p-12 max-w-lg w-full relative shadow-[0_0_100px_rgba(0,0,0,0.5)]">
            <button onClick={() => setShowRemotePanel(false)} className="absolute top-8 right-8 text-slate-400 hover:text-white transition-colors"><X size={28}/></button>
            <div className="text-center space-y-8">
              <h2 className="text-3xl font-black text-white uppercase italic tracking-tighter">Remote Cull</h2>
              <div className="bg-white p-6 rounded-[2.5rem] inline-block mx-auto shadow-[0_0_40px_rgba(255,255,255,0.1)]">
                <QRCodeSVG value={remoteUrl} size={240} level="H" />
              </div>
              <div className="space-y-3">
                <p className="text-slate-300 font-mono text-xs bg-black/40 py-3 px-4 rounded-xl border border-slate-800 break-all">{remoteUrl}</p>
                <p className="text-slate-500 text-[10px] uppercase tracking-widest font-black pt-2">Scan to sort from your mobile device</p>
              </div>
              {connection && (
                <div className="bg-green-500/10 text-green-500 py-4 rounded-2xl font-black text-xs tracking-widest animate-pulse border border-green-500/20 flex items-center justify-center gap-2">
                  <Smartphone size={16} /> MOBILE LINK ACTIVE
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <footer className="px-6 py-4 bg-slate-900/80 border-t border-slate-800 flex justify-between text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] backdrop-blur-sm">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2"><Database size={12} className="text-blue-500"/> PocketBase :8090</span>
          <span className="hidden md:flex items-center gap-2"><ImageIcon size={12} className="text-slate-600"/> {images.length} Loaded</span>
        </div>
        <div className="flex items-center gap-2">
           <span className="text-white">{currentIndex}</span> / <span className="opacity-50">{images.length}</span> SORTED
        </div>
      </footer>
    </div>
  );
};

export default App;
