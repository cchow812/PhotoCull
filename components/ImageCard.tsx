
import React, { useState, useEffect } from 'react';
import { motion, useMotionValue, useTransform, PanInfo } from 'framer-motion';
import { Check, X, Info, Eye, Camera, Loader2 } from 'lucide-react';
import { ImageItem } from '../types';
import { getImageUrl, revokeImageUrl, getFileDataUrl } from '../services/fileService';
import { GoogleGenAI } from "@google/genai";

interface ImageCardProps {
  image: ImageItem;
  onDecision: (decision: 'keep' | 'delete') => void;
  isFront: boolean;
  remoteDataUrl?: string;
}

export const ImageCard: React.FC<ImageCardProps> = ({ image, onDecision, isFront, remoteDataUrl }) => {
  const [url, setUrl] = useState<string | null>(remoteDataUrl || null);
  const [loading, setLoading] = useState(!remoteDataUrl);
  const [isRaw, setIsRaw] = useState(false);
  const [aiDescription, setAiDescription] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-15, 15]);
  const opacity = useTransform(x, [-250, -180, 0, 180, 250], [0, 1, 1, 1, 0]);
  
  const keepOpacity = useTransform(x, [5, 60], [0, 1]);
  const deleteOpacity = useTransform(x, [-60, -5], [1, 0]);
  const keepBgOpacity = useTransform(x, [0, 100], [0, 0.6]);
  const deleteBgOpacity = useTransform(x, [-100, 0], [0.6, 0]);
  const labelScale = useTransform(x, [-150, -60, 0, 60, 150], [1.2, 1, 0.8, 1, 1.2]);

  const rawExtensions = ['cr2', 'nef', 'arw', 'dng', 'orf'];

  useEffect(() => {
    const ext = image.name.split('.').pop()?.toLowerCase() || '';
    const isRawFormat = rawExtensions.includes(ext);
    setIsRaw(isRawFormat);

    if (remoteDataUrl) {
      setUrl(remoteDataUrl);
      setLoading(false);
      return;
    }

    let currentUrl: string | null = null;
    const load = async () => {
      try {
        if (isRawFormat) {
          setLoading(false);
          fetchAiDescription();
          return;
        }
        const newUrl = await getImageUrl(image.handle);
        setUrl(newUrl);
        currentUrl = newUrl;
        setLoading(false);
      } catch (err) {
        console.warn("Natively unrenderable format:", image.name);
        setLoading(false);
        fetchAiDescription();
      }
    };

    const fetchAiDescription = async () => {
      setAiLoading(true);
      try {
        const dataUrl = await getFileDataUrl(image.handle);
        const base64Data = dataUrl.split(',')[1];
        
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: {
            parts: [
              { inlineData: { data: base64Data, mimeType: 'application/octet-stream' } },
              { text: "Describe this professional RAW photograph in 10 words or less. Focus on the subject and lighting." }
            ]
          }
        });
        
        setAiDescription(response.text || "Unidentified image content");
      } catch (e) {
        setAiDescription("Preview unavailable for this format");
      } finally {
        setAiLoading(false);
      }
    };

    load();
    return () => {
      if (currentUrl) revokeImageUrl(currentUrl);
    };
  }, [image.handle, remoteDataUrl, image.name]);

  const handleDragEnd = (_: any, info: PanInfo) => {
    const threshold = window.innerWidth < 768 ? 50 : 100;
    if (info.offset.x > threshold) {
      onDecision('keep');
    } else if (info.offset.x < -threshold) {
      onDecision('delete');
    }
  };

  if (!isFront) {
    return (
      <div className="absolute inset-0 w-full h-full bg-slate-800 rounded-3xl border border-slate-700 shadow-2xl flex items-center justify-center">
        <div className="animate-pulse flex flex-col items-center">
          <div className="w-10 h-10 bg-slate-700 rounded-full mb-3"></div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      style={{ x, rotate, opacity }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      onDragEnd={handleDragEnd}
      className="absolute inset-0 w-full h-full bg-slate-900 rounded-3xl border border-slate-700 shadow-2xl cursor-grab active:cursor-grabbing overflow-hidden flex flex-col touch-none"
      whileTap={{ scale: 0.98 }}
    >
      <motion.div style={{ opacity: keepBgOpacity }} className="absolute inset-0 bg-green-600 z-10 pointer-events-none" />
      <motion.div style={{ opacity: deleteBgOpacity }} className="absolute inset-0 bg-red-600 z-10 pointer-events-none" />

      <motion.div style={{ opacity: keepOpacity, scale: labelScale }} className="absolute top-12 right-8 z-30 bg-green-500 text-white px-6 py-3 rounded-2xl font-black text-2xl border-4 border-white/60 transform rotate-12 pointer-events-none shadow-2xl flex items-center gap-2">
        <Check size={28} strokeWidth={4} /> KEEP
      </motion.div>
      <motion.div style={{ opacity: deleteOpacity, scale: labelScale }} className="absolute top-12 left-8 z-30 bg-red-500 text-white px-6 py-3 rounded-2xl font-black text-2xl border-4 border-white/40 transform -rotate-12 pointer-events-none shadow-2xl flex items-center gap-2">
        <X size={28} strokeWidth={4} /> DELETE
      </motion.div>

      <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
        {isRaw && (
          <div className="absolute top-4 right-4 z-20 bg-amber-500 text-black px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest shadow-lg">
            RAW FORMAT
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center text-slate-500">
            <Loader2 className="w-8 h-8 animate-spin mb-3" />
            <p className="text-[10px] uppercase font-bold tracking-widest">Reading File</p>
          </div>
        ) : url ? (
          <img 
            src={url} 
            alt={image.name} 
            className="max-w-full max-h-full object-contain select-none pointer-events-none transition-opacity duration-300 ease-in"
            onLoad={(e) => (e.currentTarget.style.opacity = '1')}
            style={{ opacity: 0 }}
          />
        ) : (
          <div className="text-slate-400 flex flex-col items-center p-12 text-center max-w-sm">
            <div className="w-20 h-20 bg-slate-800 rounded-3xl flex items-center justify-center mb-6 border border-slate-700">
               <Camera size={40} className="opacity-40" />
            </div>
            <h4 className="text-sm font-black text-white uppercase tracking-widest mb-2">Native Preview Unavailable</h4>
            
            <div className="w-full bg-slate-950 border border-slate-800 p-4 rounded-2xl">
               <div className="flex items-center gap-2 mb-2">
                  <Eye size={14} className="text-blue-500" />
                  <span className="text-[9px] font-black text-blue-500 uppercase tracking-widest">AI Visualization</span>
               </div>
               {aiLoading ? (
                 <div className="flex items-center gap-2 text-[10px] text-slate-500 py-2">
                   <Loader2 size={12} className="animate-spin" />
                   Processing RAW metadata...
                 </div>
               ) : (
                 <p className="text-xs text-slate-300 italic font-medium leading-relaxed">
                   "{aiDescription || "Extracting visual summary..."}"
                 </p>
               )}
            </div>
          </div>
        )}
      </div>

      <div className="p-4 md:p-6 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 z-20">
        <div className="space-y-1">
          <h3 className="text-sm md:text-base font-bold text-white truncate">{image.name}</h3>
          <p className="text-[9px] md:text-[10px] text-slate-500 font-mono truncate uppercase tracking-tighter">
            {image.relativePath || 'Root Folder'}
          </p>
        </div>
        
        <div className="flex justify-between mt-4 gap-3">
          <button 
            onClick={(e) => { e.stopPropagation(); onDecision('delete'); }}
            className="flex-1 flex items-center justify-center gap-2 bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white py-4 rounded-2xl transition-all font-bold border border-red-500/20 active:scale-95 text-sm"
          >
            <X size={18} /> Delete
          </button>
          <button 
            onClick={(e) => { e.stopPropagation(); onDecision('keep'); }}
            className="flex-1 flex items-center justify-center gap-2 bg-green-500/10 hover:bg-green-500 text-green-500 hover:text-white py-4 rounded-2xl transition-all font-bold border border-green-500/20 active:scale-95 text-sm"
          >
            <Check size={18} /> Keep
          </button>
        </div>
      </div>
    </motion.div>
  );
};
