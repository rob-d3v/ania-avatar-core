// IndexedDB-backed avatar cache. Stores decrypted avatar data keyed by URL with
// a 7-day TTL. Degrades gracefully (no-op) where IndexedDB is unavailable.
// Ported from the Chrome extension's `lib/utils/avatar-cache.ts`.

import type { AniaAvatarData } from '../types';

const DB_NAME = 'ania-avatar-cache';
const DB_VERSION = 1;
const STORE_NAME = 'avatars';
const CACHE_EXPIRY_DAYS = 7;

let db: IDBDatabase | null = null;

interface CacheEntry {
  url: string;
  data: AniaAvatarData;
  isEncrypted: boolean;
  timestamp: number;
  hash: string;
}

const hasIndexedDB = (): boolean =>
  typeof indexedDB !== 'undefined' && indexedDB !== null;

const initDB = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    if (db) {
      resolve(db);
      return;
    }
    if (!hasIndexedDB()) {
      resolve(null);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => resolve(null);
    request.onsuccess = (event) => {
      db = (event.target as IDBOpenDBRequest).result;
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'url' });
      }
    };
  });

const hashUrl = (url: string): string => {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash << 5) - hash + url.charCodeAt(i);
    hash = hash & hash;
  }
  return hash.toString(36);
};

export const getCachedAvatar = async (url: string): Promise<AniaAvatarData | null> => {
  try {
    const database = await initDB();
    if (!database) return null;

    return await new Promise((resolve) => {
      const tx = database.transaction([STORE_NAME], 'readonly');
      const request = tx.objectStore(STORE_NAME).get(url);
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const result = request.result as CacheEntry | undefined;
        if (!result) {
          resolve(null);
          return;
        }
        const age = Date.now() - result.timestamp;
        const maxAge = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
        if (age > maxAge) {
          void deleteCachedAvatar(url);
          resolve(null);
          return;
        }
        resolve(result.data);
      };
    });
  } catch {
    return null;
  }
};

export const setCachedAvatar = async (
  url: string,
  data: AniaAvatarData,
  isEncrypted = false
): Promise<void> => {
  try {
    const database = await initDB();
    if (!database) return;
    const tx = database.transaction([STORE_NAME], 'readwrite');
    tx.objectStore(STORE_NAME).put({
      url,
      data,
      isEncrypted,
      timestamp: Date.now(),
      hash: hashUrl(url),
    } satisfies CacheEntry);
  } catch {
    /* ignore */
  }
};

export const deleteCachedAvatar = async (url: string): Promise<void> => {
  try {
    const database = await initDB();
    if (!database) return;
    const tx = database.transaction([STORE_NAME], 'readwrite');
    tx.objectStore(STORE_NAME).delete(url);
  } catch {
    /* ignore */
  }
};

export const clearAvatarCache = async (): Promise<void> => {
  try {
    const database = await initDB();
    if (!database) return;
    const tx = database.transaction([STORE_NAME], 'readwrite');
    tx.objectStore(STORE_NAME).clear();
  } catch {
    /* ignore */
  }
};

export interface CacheStats {
  count: number;
  size: number;
  sizeFormatted: string;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

export const getCacheStats = async (): Promise<CacheStats> => {
  try {
    const database = await initDB();
    if (!database) return { count: 0, size: 0, sizeFormatted: '0 Bytes' };

    return await new Promise((resolve) => {
      const tx = database.transaction([STORE_NAME], 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        const entries = (request.result || []) as CacheEntry[];
        let totalSize = 0;
        for (const entry of entries) {
          if (typeof entry.data === 'object') totalSize += JSON.stringify(entry.data).length;
        }
        resolve({ count: entries.length, size: totalSize, sizeFormatted: formatBytes(totalSize) });
      };
      request.onerror = () => resolve({ count: 0, size: 0, sizeFormatted: '0 Bytes' });
    });
  } catch {
    return { count: 0, size: 0, sizeFormatted: '0 Bytes' };
  }
};

/** A namespaced object exposing the whole cache API (re-exported as `AvatarCache`). */
export const AvatarCache = {
  get: getCachedAvatar,
  set: setCachedAvatar,
  delete: deleteCachedAvatar,
  clear: clearAvatarCache,
  stats: getCacheStats,
} as const;
