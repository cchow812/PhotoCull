
import PocketBase from 'pocketbase';
import { Decision, CullSession } from '../types';

const PB_URL = 'http://127.0.0.1:8090';
const IDB_NAME = 'PhotoCullLocalHandles';
const IDB_STORE = 'handles';

export interface ImageDecision {
  directoryName: string;
  relativePath: string;
  decision: Decision;
}

export class DBService {
  private pb: PocketBase;
  private idb: IDBDatabase | null = null;

  constructor() {
    this.pb = new PocketBase(PB_URL);
  }

  async init(): Promise<void> {
    // 1. Check PocketBase
    try {
      await fetch(`${PB_URL}/api/health`);
    } catch (e) {
      console.warn("PocketBase unreachable. Ensure it is running at http://127.0.0.1:8090");
    }

    // 2. Init Local IndexedDB for FileSystemHandles
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        db.createObjectStore(IDB_STORE);
      };
      request.onsuccess = (e) => {
        this.idb = (e.target as IDBOpenDBRequest).result;
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Local Handle Management
  async storeHandleLocally(directoryName: string, handle: FileSystemDirectoryHandle): Promise<void> {
    if (!this.idb) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.idb!.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const request = store.put(handle, directoryName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getHandleLocally(directoryName: string): Promise<FileSystemDirectoryHandle | null> {
    if (!this.idb) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.idb!.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const request = store.get(directoryName);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  // PocketBase Operations
  async saveSession(session: CullSession): Promise<void> {
    try {
      const existing = await this.pb.collection('sessions').getFirstListItem(`directoryName="${session.directoryName}"`).catch(() => null);
      const data = {
        directoryName: session.directoryName,
        lastIndex: session.lastIndex,
        totalImages: session.totalImages,
        isDone: session.isDone,
        updatedAt: new Date(session.updatedAt).toISOString(),
      };

      if (existing) {
        await this.pb.collection('sessions').update(existing.id, data);
      } else {
        await this.pb.collection('sessions').create(data);
      }

      // If we have a handle in memory, store it locally for resume support
      if (session.handle) {
        await this.storeHandleLocally(session.directoryName, session.handle);
      }
    } catch (err) {
      console.error("PocketBase saveSession error:", err);
    }
  }

  async getAllSessions(): Promise<CullSession[]> {
    try {
      const records = await this.pb.collection('sessions').getFullList({ sort: '-updatedAt' });
      return records.map(r => ({
        directoryName: r.directoryName,
        lastIndex: r.lastIndex,
        totalImages: r.totalImages,
        updatedAt: new Date(r.updatedAt).getTime(),
        isDone: r.isDone,
      }));
    } catch (err) {
      return [];
    }
  }

  async getSession(directoryName: string): Promise<CullSession | null> {
    try {
      const record = await this.pb.collection('sessions').getFirstListItem(`directoryName="${directoryName}"`).catch(() => null);
      if (!record) return null;
      return {
        directoryName: record.directoryName,
        lastIndex: record.lastIndex,
        totalImages: record.totalImages,
        updatedAt: new Date(record.updatedAt).getTime(),
        isDone: record.isDone,
      };
    } catch (err) {
      return null;
    }
  }

  async saveDecision(decision: ImageDecision): Promise<void> {
    try {
      const filter = `directoryName="${decision.directoryName}" && relativePath="${decision.relativePath}"`;
      const existing = await this.pb.collection('decisions').getFirstListItem(filter).catch(() => null);
      const data = {
        directoryName: decision.directoryName,
        relativePath: decision.relativePath,
        decision: decision.decision,
      };

      if (existing) {
        await this.pb.collection('decisions').update(existing.id, data);
      } else {
        await this.pb.collection('decisions').create(data);
      }
    } catch (err) {
      console.error("PocketBase saveDecision error:", err);
    }
  }

  async getDecisionsForDirectory(directoryName: string): Promise<Record<string, Decision>> {
    try {
      const records = await this.pb.collection('decisions').getFullList({ filter: `directoryName="${directoryName}"` });
      const map: Record<string, Decision> = {};
      records.forEach(r => { map[r.relativePath] = r.decision as Decision; });
      return map;
    } catch (err) {
      return {};
    }
  }
}

export const dbService = new DBService();
