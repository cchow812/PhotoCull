
export type Decision = 'keep' | 'delete' | 'pending';

export interface ImageItem {
  id: string;
  name: string;
  relativePath: string;
  handle: FileSystemFileHandle;
  url: string | null;
  decision: Decision;
}

export interface SimplifiedImage {
  id: string;
  name: string;
  relativePath: string;
  decision: Decision;
}

export interface CullSession {
  directoryName: string;
  lastIndex: number;
  totalImages: number;
  updatedAt: number;
  isDone: boolean;
  handle?: FileSystemDirectoryHandle;
}

export type PeerMessage = 
  | { type: 'INIT_SYNC', images: SimplifiedImage[], currentIndex: number, rootFolderName: string, stats: any, view: string }
  | { type: 'IMAGE_DATA', id: string, name: string, dataUrl: string, index: number }
  | { type: 'DECISION', decision: Decision, index: number }
  | { type: 'DECISION_ACK', index: number }
  | { type: 'UNDO' }
  | { type: 'NAVIGATE', view: 'landing' | 'culling' | 'summary', index?: number }
  | { type: 'SYNC_INDEX', index: number, stats: any };
