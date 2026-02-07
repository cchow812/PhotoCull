
import { ImageItem, Decision } from '../types';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'cr2', 'nef', 'arw', 'dng', 'orf']);

export async function scanDirectory(
  directoryHandle: FileSystemDirectoryHandle,
  onProgress?: (count: number) => void
): Promise<{ images: ImageItem[], rootName: string }> {
  const images: ImageItem[] = [];
  const rootName = directoryHandle.name;
  let count = 0;

  async function walk(handle: FileSystemDirectoryHandle, path: string = '') {
    for await (const entry of handle.values()) {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      
      if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, entryPath);
      } else if (entry.kind === 'file') {
        const file = entry as FileSystemFileHandle;
        const extension = file.name.split('.').pop()?.toLowerCase() || '';
        
        if (IMAGE_EXTENSIONS.has(extension)) {
          images.push({
            id: Math.random().toString(36).substr(2, 9),
            name: file.name,
            relativePath: entryPath,
            handle: file,
            url: null,
            decision: 'pending'
          });
          count++;
          if (onProgress) onProgress(count);
        }
      }
    }
  }

  await walk(directoryHandle);
  return { images, rootName };
}

export async function getImageUrl(fileHandle: FileSystemFileHandle): Promise<string> {
  const file = await fileHandle.getFile();
  const ext = file.name.split('.').pop()?.toLowerCase();
  const webFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'];
  if (ext && webFormats.includes(ext)) {
    return URL.createObjectURL(file);
  }
  throw new Error("Format not natively supported by browser");
}

export async function getFileDataUrl(fileHandle: FileSystemFileHandle): Promise<string> {
  const file = await fileHandle.getFile();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function revokeImageUrl(url: string) {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

/**
 * Directly removes a file from the disk. 
 * Requires 'readwrite' permission on the directory handle.
 */
export async function deleteFile(fileHandle: FileSystemFileHandle): Promise<void> {
  // @ts-ignore - remove is supported in modern browsers on FileSystemFileHandle
  if (typeof fileHandle.remove === 'function') {
    // @ts-ignore
    await fileHandle.remove();
  } else {
    throw new Error("Deletion not supported in this browser version.");
  }
}

/**
 * Generates a batch/sh script text for mass deletion based on full qualified paths.
 */
export function generateDeletionScript(images: ImageItem[], rootPath: string, platform: 'win' | 'unix'): string {
  const toDelete = images.filter(img => img.decision === 'delete');
  
  if (platform === 'win') {
    let script = "@echo off\necho PhotoCull Pro: Deleting " + toDelete.length + " files...\n";
    toDelete.forEach(img => {
      // Use backslashes for Windows, construct full path
      const fullPath = `${rootPath}/${img.relativePath}`.replace(/\//g, '\\');
      script += `del /f /q "${fullPath}"\n`;
    });
    script += "echo Cleanup complete.\npause";
    return script;
  } else {
    let script = "#!/bin/bash\necho \"PhotoCull Pro: Deleting " + toDelete.length + " files...\"\n";
    toDelete.forEach(img => {
      const fullPath = `${rootPath}/${img.relativePath}`;
      script += `rm -f "${fullPath}"\n`;
    });
    script += "echo \"Cleanup complete.\"";
    return script;
  }
}
