
import React, { useState, useEffect, useRef } from 'react';
import { ImageItem } from '../types';
import { getImageUrl, revokeImageUrl } from '../services/fileService';
import { ImageIcon, Loader2 } from 'lucide-react';

interface ThumbnailProps {
  image: ImageItem;
  onClick: () => void;
}

export const Thumbnail: React.FC<ThumbnailProps> = ({ image, onClick }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible || url) return;

    let currentUrl: string | null = null;
    const load = async () => {
      setLoading(true);
      try {
        currentUrl = await getImageUrl(image.handle);
        setUrl(currentUrl);
      } catch (e) {
        // Fallback for non-renderable
      } finally {
        setLoading(false);
      }
    };

    load();
    return () => {
      if (currentUrl) revokeImageUrl(currentUrl);
    };
  }, [isVisible, image.handle, url]);

  return (
    <div 
      ref={containerRef}
      onClick={onClick}
      className={`group aspect-square relative rounded-2xl overflow-hidden border-4 transition-all hover:scale-105 active:scale-95 cursor-pointer shadow-lg
        ${image.decision === 'keep' ? 'border-green-500' : image.decision === 'delete' ? 'border-red-500' : 'border-slate-800'}`}
    >
      <div className="absolute inset-0 bg-slate-900 flex items-center justify-center">
        {loading ? (
          <Loader2 className="animate-spin text-slate-700" size={20} />
        ) : !url ? (
          <ImageIcon className="text-slate-800" size={32} />
        ) : (
          <img 
            src={url} 
            alt={image.name} 
            className="w-full h-full object-cover select-none pointer-events-none" 
          />
        )}
      </div>
      
      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
        <span className="text-[10px] font-black text-white uppercase tracking-widest bg-black/60 px-3 py-1 rounded-full">Adjust</span>
      </div>

      <div className={`absolute bottom-0 left-0 right-0 h-1.5 ${image.decision === 'keep' ? 'bg-green-500' : image.decision === 'delete' ? 'bg-red-500' : 'bg-transparent'}`} />
    </div>
  );
};
