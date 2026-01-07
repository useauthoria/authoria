import { useQuery, useMutation, useQueryClient, type UseQueryResult, type UseMutationResult } from '@tanstack/react-query';
import { storeApi, postsApi, type BlogPost } from './api-client';

type CacheStrategy = 'ttl' | 'lru' | 'lfu' | 'fifo' | 'custom';

type CachePartition = 'global' | 'user' | 'session' | 'tenant';

interface CacheConfig {
  readonly strategy?: CacheStrategy;
  readonly enablePersistence?: boolean;
  readonly enableCompression?: boolean;
  readonly enableEncryption?: boolean;
  readonly enableVersioning?: boolean;
  readonly enableAnalytics?: boolean;
  readonly enablePrefetching?: boolean;
  readonly enableCrossTab?: boolean;
  readonly enableSWR?: boolean;
  readonly enablePartitioning?: boolean;
  readonly enableMiddleware?: boolean;
  readonly maxCacheSize?: number;
  readonly compressionThreshold?: number;
  readonly encryptionKey?: string;
  readonly version?: string;
  readonly partition?: CachePartition;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly tenantId?: string;
}

interface CacheEntry<T = unknown> {
  readonly data: T;
  readonly timestamp: number;
  readonly expiresAt: number;
  readonly accessCount: number;
  readonly lastAccessed: number;
  readonly size: number;
  readonly version: string;
  readonly compressed?: boolean;
  readonly encrypted?: boolean;
  readonly partition?: CachePartition;
  readonly dependencies?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface CacheMetrics {
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly totalSize: number;
  readonly entryCount: number;
  readonly evictions: number;
  readonly compressions: number;
  readonly prefetches: number;
  readonly invalidations: number;
  readonly performance: {
    readonly averageAccessTime: number;
    readonly averageCompressionTime: number;
    readonly averageDecompressionTime: number;
  };
}

interface CacheMiddleware {
  readonly name: string;
  readonly beforeGet?: (key: string) => string | null;
  readonly afterGet?: (key: string, data: unknown) => unknown;
  readonly beforeSet?: (key: string, data: unknown) => { readonly key: string; readonly data: unknown } | null;
  readonly afterSet?: (key: string, data: unknown) => void;
  readonly beforeInvalidate?: (key: string) => boolean;
  readonly afterInvalidate?: (key: string) => void;
}

export interface PrefetchConfig {
  readonly enabled: boolean;
  readonly patterns: readonly {
    readonly condition: (currentKey: string) => boolean;
    readonly prefetchKeys: (currentKey: string) => readonly string[];
  }[];
}

interface MutableCacheEntry<T = unknown> {
  data: T;
  timestamp: number;
  expiresAt: number;
  accessCount: number;
  lastAccessed: number;
  size: number;
  version: string;
  compressed?: boolean;
  encrypted?: boolean;
  partition?: CachePartition;
  dependencies?: string[];
  metadata?: Record<string, unknown>;
}

interface MutableCacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
  totalSize: number;
  entryCount: number;
  evictions: number;
  compressions: number;
  prefetches: number;
  invalidations: number;
  performance: {
    averageAccessTime: number;
    averageCompressionTime: number;
    averageDecompressionTime: number;
  };
}

interface BroadcastMessage {
  readonly type: 'invalidate' | 'update';
  readonly key: string;
  readonly entry?: MutableCacheEntry;
}

interface QueryState {
  readonly status: 'pending' | 'error' | 'success';
  readonly isFetching?: boolean;
}

interface QueryWithState {
  readonly state: QueryState;
  readonly queryKey: readonly unknown[];
  readonly isEnabled?: boolean;
}

const MAX_KEY_LENGTH = 1000;
const MAX_CACHE_SIZE = 100 * 1024 * 1024;
const MAX_SHOP_DOMAIN_LENGTH = 200;
const MAX_STORE_ID_LENGTH = 200;
const MAX_POST_ID_LENGTH = 200;

const validateKey = (key: string): string | null => {
  if (!key || typeof key !== 'string') {
    return null;
  }
  const trimmed = key.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH) {
    return null;
  }
  return trimmed;
};

const validateShopDomain = (shopDomain: string): string | null => {
  if (!shopDomain || typeof shopDomain !== 'string') {
    return null;
  }
  const trimmed = shopDomain.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SHOP_DOMAIN_LENGTH) {
    return null;
  }
  return trimmed;
};

const validateStoreId = (storeId: string): string | null => {
  if (!storeId || typeof storeId !== 'string') {
    return null;
  }
  const trimmed = storeId.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_STORE_ID_LENGTH) {
    return null;
  }
  return trimmed;
};

const validatePostId = (postId: string): string | null => {
  if (!postId || typeof postId !== 'string') {
    return null;
  }
  const trimmed = postId.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_POST_ID_LENGTH) {
    return null;
  }
  return trimmed;
};

const hasWindow = (): boolean => {
  return typeof window !== 'undefined';
};

const hasIndexedDB = (): boolean => {
  return hasWindow() && 'indexedDB' in window;
};

const hasLocalStorage = (): boolean => {
  if (!hasWindow()) {
    return false;
  }
  try {
    const test = '__localStorage_test__';
    localStorage.setItem(test, test);
    localStorage.removeItem(test);
    return true;
  } catch {
    return false;
  }
};

const hasBroadcastChannel = (): boolean => {
  return typeof BroadcastChannel !== 'undefined';
};

class PersistentCacheStorage {
  private static readonly DB_NAME = 'api-cache';
  private static readonly STORE_NAME = 'cache';
  private static readonly VERSION = 1;
  private static readonly KEY_PREFIX = 'cache-';
  private static readonly EXPIRES_AT_INDEX = 'expiresAt';
  private static readonly LAST_ACCESSED_INDEX = 'lastAccessed';

  private readonly dbName = PersistentCacheStorage.DB_NAME;
  private readonly storeName = PersistentCacheStorage.STORE_NAME;
  private readonly version = PersistentCacheStorage.VERSION;
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (!hasIndexedDB()) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const request = indexedDB.open(this.dbName, this.version);

        request.onerror = () => {
          reject(request.error || new Error('Failed to open IndexedDB'));
        };

        request.onsuccess = () => {
          try {
            this.db = request.result;
            resolve();
          } catch {
            reject(new Error('Failed to initialize database'));
          }
        };

        request.onupgradeneeded = (event) => {
          try {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(this.storeName)) {
              const store = db.createObjectStore(this.storeName, { keyPath: 'key' });
              store.createIndex(
                PersistentCacheStorage.EXPIRES_AT_INDEX,
                PersistentCacheStorage.EXPIRES_AT_INDEX,
                { unique: false },
              );
              store.createIndex(
                PersistentCacheStorage.LAST_ACCESSED_INDEX,
                PersistentCacheStorage.LAST_ACCESSED_INDEX,
                { unique: false },
              );
            }
          } catch {
            reject(new Error('Failed to upgrade database'));
          }
        };
      } catch {
        reject(new Error('Failed to open IndexedDB'));
      }
    });
  }

  async get<T>(key: string): Promise<MutableCacheEntry<T> | null> {
    const validatedKey = validateKey(key);
    if (!validatedKey) {
      return null;
    }

    if (!this.db) {
      if (!hasLocalStorage()) {
        return null;
      }
      try {
        const item = localStorage.getItem(`${PersistentCacheStorage.KEY_PREFIX}${validatedKey}`);
        if (!item) {
          return null;
        }
        const parsed = JSON.parse(item) as MutableCacheEntry<T>;
        return parsed;
      } catch {
        return null;
      }
    }

    return new Promise<MutableCacheEntry<T> | null>((resolve, reject) => {
      try {
        const transaction = this.db!.transaction([this.storeName], 'readonly');
        const store = transaction.objectStore(this.storeName);
        const request = store.get(validatedKey);

        request.onerror = () => {
          reject(request.error || new Error('Failed to get from IndexedDB'));
        };

        request.onsuccess = () => {
          try {
            const result = request.result?.value;
            if (!result) {
              resolve(null);
              return;
            }
            resolve(result as MutableCacheEntry<T>);
          } catch {
            resolve(null);
          }
        };
      } catch {
        resolve(null);
      }
    });
  }

  async set<T>(key: string, entry: MutableCacheEntry<T>): Promise<void> {
    const validatedKey = validateKey(key);
    if (!validatedKey) {
      return;
    }

    if (!this.db) {
      if (!hasLocalStorage()) {
        return;
      }
      try {
        localStorage.setItem(`${PersistentCacheStorage.KEY_PREFIX}${validatedKey}`, JSON.stringify(entry));
      } catch {
      }
      return;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const transaction = this.db!.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.put({ key: validatedKey, value: entry });

        request.onerror = () => {
          reject(request.error || new Error('Failed to set in IndexedDB'));
        };

        request.onsuccess = () => {
          resolve();
        };
      } catch {
        reject(new Error('Failed to set in IndexedDB'));
      }
    });
  }

  async delete(key: string): Promise<void> {
    const validatedKey = validateKey(key);
    if (!validatedKey) {
      return;
    }

    if (!this.db) {
      if (hasLocalStorage()) {
        try {
          localStorage.removeItem(`${PersistentCacheStorage.KEY_PREFIX}${validatedKey}`);
        } catch {
        }
      }
      return;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const transaction = this.db!.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.delete(validatedKey);

        request.onerror = () => {
          reject(request.error || new Error('Failed to delete from IndexedDB'));
        };

        request.onsuccess = () => {
          resolve();
        };
      } catch {
        resolve();
      }
    });
  }

  async clear(): Promise<void> {
    if (!this.db) {
      if (!hasLocalStorage()) {
        return;
      }
      try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith(PersistentCacheStorage.KEY_PREFIX)) {
            keys.push(key);
          }
        }
        for (const key of keys) {
          try {
            localStorage.removeItem(key);
          } catch {
          }
        }
      } catch {
      }
      return;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const transaction = this.db!.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.clear();

        request.onerror = () => {
          reject(request.error || new Error('Failed to clear IndexedDB'));
        };

        request.onsuccess = () => {
          resolve();
        };
      } catch {
        resolve();
      }
    });
  }

  async getAllKeys(): Promise<string[]> {
    if (!this.db) {
      if (!hasLocalStorage()) {
        return [];
      }
      try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith(PersistentCacheStorage.KEY_PREFIX)) {
            keys.push(key.replace(PersistentCacheStorage.KEY_PREFIX, ''));
          }
        }
        return keys;
      } catch {
        return [];
      }
    }

    return new Promise<string[]>((resolve, reject) => {
      try {
        const transaction = this.db!.transaction([this.storeName], 'readonly');
        const store = transaction.objectStore(this.storeName);
        const request = store.getAllKeys();

        request.onerror = () => {
          reject(request.error || new Error('Failed to get all keys from IndexedDB'));
        };

        request.onsuccess = () => {
          try {
            const result = request.result as string[];
            resolve(Array.isArray(result) ? result : []);
          } catch {
            resolve([]);
          }
        };
      } catch {
        resolve([]);
      }
    });
  }
}

class EnhancedCacheManager {
  private static readonly DEFAULT_STRATEGY: CacheStrategy = 'ttl';
  private static readonly DEFAULT_VERSION = '1.0';
  private static readonly DEFAULT_PARTITION: CachePartition = 'global';
  private static readonly DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024;
  private static readonly DEFAULT_COMPRESSION_THRESHOLD = 1024;
  private static readonly DEFAULT_TTL = 86400000;
  private static readonly CLEANUP_INTERVAL = 60000;
  private static readonly BROADCAST_CHANNEL_NAME = 'api-cache';
  private static readonly INVALIDATE_MESSAGE_TYPE = 'invalidate';
  private static readonly UPDATE_MESSAGE_TYPE = 'update';
  private static readonly KEY_SEPARATOR = ':';
  private static readonly USER_PREFIX = 'user:';
  private static readonly SESSION_PREFIX = 'session:';
  private static readonly TENANT_PREFIX = 'tenant:';
  private static readonly SESSION_ID_PREFIX = 'session-';
  private static readonly ID_RADIX = 36;
  private static readonly ID_SUBSTRING_START = 2;
  private static readonly ID_SUBSTRING_LENGTH = 9;
  private static readonly MILLISECONDS_PER_SECOND = 1000;

  private readonly storage: PersistentCacheStorage;
  private readonly config: Required<CacheConfig>;
  private readonly metrics: MutableCacheMetrics;
  private readonly middleware: CacheMiddleware[] = [];
  private readonly prefetchConfig: PrefetchConfig;
  private readonly cache: Map<string, MutableCacheEntry> = new Map();
  private readonly accessOrder: string[] = [];
  private readonly accessCounts: Map<string, number> = new Map();
  private broadcastChannel: BroadcastChannel | null = null;
  private cleanupTimerId: ReturnType<typeof setInterval> | null = null;

  constructor(config: CacheConfig = {}) {
    this.config = {
      strategy: config.strategy ?? EnhancedCacheManager.DEFAULT_STRATEGY,
      enablePersistence: config.enablePersistence ?? true,
      enableCompression: config.enableCompression ?? false,
      enableEncryption: config.enableEncryption ?? false,
      enableVersioning: config.enableVersioning ?? true,
      enableAnalytics: config.enableAnalytics ?? true,
      enablePrefetching: config.enablePrefetching ?? true,
      enableCrossTab: config.enableCrossTab ?? true,
      enableSWR: config.enableSWR ?? true,
      enablePartitioning: config.enablePartitioning ?? false,
      enableMiddleware: config.enableMiddleware ?? true,
      maxCacheSize: config.maxCacheSize ?? EnhancedCacheManager.DEFAULT_MAX_CACHE_SIZE,
      compressionThreshold: config.compressionThreshold ?? EnhancedCacheManager.DEFAULT_COMPRESSION_THRESHOLD,
      encryptionKey: config.encryptionKey ?? '',
      version: config.version ?? EnhancedCacheManager.DEFAULT_VERSION,
      partition: config.partition ?? EnhancedCacheManager.DEFAULT_PARTITION,
      userId: config.userId ?? '',
      sessionId: config.sessionId ?? this.generateSessionId(),
      tenantId: config.tenantId ?? '',
    };

    this.storage = new PersistentCacheStorage();
    this.metrics = {
      hits: 0,
      misses: 0,
      hitRate: 0,
      totalSize: 0,
      entryCount: 0,
      evictions: 0,
      compressions: 0,
      prefetches: 0,
      invalidations: 0,
      performance: {
        averageAccessTime: 0,
        averageCompressionTime: 0,
        averageDecompressionTime: 0,
      },
    };

    this.prefetchConfig = {
      enabled: this.config.enablePrefetching,
      patterns: [],
    } as PrefetchConfig;

    if (this.config.enableCrossTab && hasBroadcastChannel()) {
      try {
        this.broadcastChannel = new BroadcastChannel(EnhancedCacheManager.BROADCAST_CHANNEL_NAME);
        this.broadcastChannel.onmessage = (event) => {
          try {
            const message = event.data as BroadcastMessage;
            if (message.type === EnhancedCacheManager.INVALIDATE_MESSAGE_TYPE) {
              this.invalidate(message.key).catch(() => {
              });
            } else if (
              message.type === EnhancedCacheManager.UPDATE_MESSAGE_TYPE &&
              message.entry
            ) {
              this.set(message.key, message.entry.data, 0, message.entry.dependencies).catch(() => {
              });
            }
          } catch {
          }
        };
      } catch {
      }
    }

    this.init().catch(() => {
    });
  }

  private async init(): Promise<void> {
    if (this.config.enablePersistence) {
      try {
        await this.storage.init();
        const keys = await this.storage.getAllKeys();
        for (const key of keys) {
          try {
            const entry = await this.storage.get(key);
            if (entry && entry.expiresAt > Date.now()) {
              this.cache.set(key, entry);
            }
          } catch {
          }
        }
      } catch {
      }
    }

    if (hasWindow() && typeof setInterval === 'function') {
      this.cleanupTimerId = setInterval(() => {
        this.cleanup().catch(() => {
        });
      }, EnhancedCacheManager.CLEANUP_INTERVAL);
    }
  }

  destroy(): void {
    if (this.cleanupTimerId !== null) {
      clearInterval(this.cleanupTimerId);
      this.cleanupTimerId = null;
    }
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch {
      }
      this.broadcastChannel = null;
    }
  }

  private generateKey(baseKey: string): string {
    if (!this.config.enablePartitioning) {
      return baseKey;
    }

    const parts = [baseKey];
    if (this.config.partition === 'user' && this.config.userId) {
      parts.unshift(`${EnhancedCacheManager.USER_PREFIX}${this.config.userId}`);
    } else if (this.config.partition === 'session' && this.config.sessionId) {
      parts.unshift(`${EnhancedCacheManager.SESSION_PREFIX}${this.config.sessionId}`);
    } else if (this.config.partition === 'tenant' && this.config.tenantId) {
      parts.unshift(`${EnhancedCacheManager.TENANT_PREFIX}${this.config.tenantId}`);
    }

    return parts.join(EnhancedCacheManager.KEY_SEPARATOR);
  }

  async get<T>(key: string): Promise<T | null> {
    const validatedKey = validateKey(key);
    if (!validatedKey) {
      this.metrics.misses++;
      this.updateMetrics();
      return null;
    }

    const startTime = Date.now();
    const fullKey = this.generateKey(validatedKey);

    let entry = this.cache.get(fullKey);

    if (!entry && this.config.enablePersistence) {
      try {
        const persistedEntry = await this.storage.get(fullKey);
        if (persistedEntry) {
          entry = persistedEntry;
          this.cache.set(fullKey, entry);
        }
      } catch {
      }
    }

    if (!entry) {
      this.metrics.misses++;
      this.updateMetrics();
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(fullKey);
      if (this.config.enablePersistence) {
        try {
          await this.storage.delete(fullKey);
        } catch {
        }
      }
      this.metrics.misses++;
      this.updateMetrics();
      return null;
    }

    if (this.config.enableVersioning && entry.version !== this.config.version) {
      try {
        await this.invalidate(fullKey);
      } catch {
      }
      this.metrics.misses++;
      this.updateMetrics();
      return null;
    }

    entry.lastAccessed = Date.now();
    entry.accessCount++;

    const lruIndex = this.accessOrder.indexOf(fullKey);
    if (lruIndex > -1) {
      this.accessOrder.splice(lruIndex, 1);
    }
    this.accessOrder.push(fullKey);

    this.accessCounts.set(fullKey, (this.accessCounts.get(fullKey) ?? 0) + 1);

    const data = entry.data;

    this.metrics.hits++;
    const accessTime = Date.now() - startTime;
    this.metrics.performance.averageAccessTime =
      (this.metrics.performance.averageAccessTime * (this.metrics.hits - 1) + accessTime) /
      this.metrics.hits;
    this.updateMetrics();

    return data as T;
  }

  async set<T>(
    key: string,
    data: T,
    ttl: number = 0,
    dependencies?: readonly string[],
  ): Promise<void> {
    const validatedKey = validateKey(key);
    if (!validatedKey) {
      return;
    }

    const fullKey = this.generateKey(validatedKey);

    let serializedSize = 0;
    try {
      serializedSize = JSON.stringify(data).length;
    } catch {
      serializedSize = 0;
    }

    const entry: MutableCacheEntry<T> = {
      data: data as T,
      timestamp: Date.now(),
      expiresAt: ttl > 0 ? Date.now() + ttl : Date.now() + EnhancedCacheManager.DEFAULT_TTL,
      accessCount: 0,
      lastAccessed: Date.now(),
      size: serializedSize,
      version: this.config.version,
      compressed: false,
      encrypted: false,
      partition: this.config.partition,
      dependencies: dependencies ? [...dependencies] : undefined,
      metadata: {},
    };

    try {
      await this.evictIfNeeded(entry.size);
    } catch {
    }

    this.cache.set(fullKey, entry);

    if (this.config.enablePersistence) {
      try {
        await this.storage.set(fullKey, entry);
      } catch {
      }
    }

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          type: EnhancedCacheManager.UPDATE_MESSAGE_TYPE,
          key: fullKey,
          entry,
        } as BroadcastMessage);
      } catch {
      }
    }

    this.metrics.totalSize += entry.size;
    this.metrics.entryCount = this.cache.size;
    this.updateMetrics();
  }

  async invalidate(key: string): Promise<void> {
    const validatedKey = validateKey(key);
    if (!validatedKey) {
      return;
    }

    const fullKey = this.generateKey(validatedKey);

    if (this.config.enableMiddleware) {
      for (const mw of this.middleware) {
        if (mw.beforeInvalidate) {
          try {
            if (!mw.beforeInvalidate(fullKey)) {
              return;
            }
          } catch {
          }
        }
      }
    }

    const entry = this.cache.get(fullKey);
    if (entry) {
      this.metrics.totalSize -= entry.size;
      this.cache.delete(fullKey);
    }

    if (this.config.enablePersistence) {
      try {
        await this.storage.delete(fullKey);
      } catch {
      }
    }

    if (entry?.dependencies) {
      for (const dep of entry.dependencies) {
        try {
          await this.invalidate(dep);
        } catch {
        }
      }
    }

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          type: EnhancedCacheManager.INVALIDATE_MESSAGE_TYPE,
          key: fullKey,
        } as BroadcastMessage);
      } catch {
      }
    }

    this.metrics.invalidations++;
    this.updateMetrics();

    if (this.config.enableMiddleware) {
      for (const mw of this.middleware) {
        if (mw.afterInvalidate) {
          try {
            mw.afterInvalidate(fullKey);
          } catch {
          }
        }
      }
    }
  }

  private calculateCurrentSize(): number {
    return Array.from(this.cache.values()).reduce((sum, e) => sum + e.size, 0);
  }

  private async evictIfNeeded(newEntrySize: number): Promise<void> {
    const currentSize = this.calculateCurrentSize();
    if (currentSize + newEntrySize <= this.config.maxCacheSize) {
      return;
    }

    const toEvict: string[] = [];
    let remainingSize = currentSize + newEntrySize;

    switch (this.config.strategy) {
      case 'lru': {
        const accessOrderCopy = [...this.accessOrder];
        while (remainingSize > this.config.maxCacheSize && accessOrderCopy.length > 0) {
          const key = accessOrderCopy.shift();
          if (key) {
            toEvict.push(key);
            const entry = this.cache.get(key);
            if (entry) {
              remainingSize -= entry.size;
            }
          }
        }
        break;
      }
      case 'lfu': {
        const sorted = Array.from(this.accessCounts.entries()).sort((a, b) => a[1] - b[1]);
        for (const [key] of sorted) {
          if (remainingSize <= this.config.maxCacheSize) {
            break;
          }
          toEvict.push(key);
          const entry = this.cache.get(key);
          if (entry) {
            remainingSize -= entry.size;
          }
        }
        break;
      }
      case 'fifo': {
        const entries = Array.from(this.cache.entries()).sort(
          (a, b) => a[1].timestamp - b[1].timestamp,
        );
        for (const [key] of entries) {
          if (remainingSize <= this.config.maxCacheSize) {
            break;
          }
          toEvict.push(key);
          const entry = this.cache.get(key);
          if (entry) {
            remainingSize -= entry.size;
          }
        }
        break;
      }
      default: {
        const expired = Array.from(this.cache.entries())
          .filter(([, e]) => e.expiresAt <= Date.now())
          .map(([k]) => k);
        toEvict.push(...expired);
        for (const key of expired) {
          const entry = this.cache.get(key);
          if (entry) {
            remainingSize -= entry.size;
          }
        }
        if (remainingSize > this.config.maxCacheSize) {
          const sorted = Array.from(this.cache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp)
            .map(([k]) => k);
          const needed = Math.ceil(
            (remainingSize - this.config.maxCacheSize) /
              EnhancedCacheManager.MILLISECONDS_PER_SECOND,
          );
          for (const key of sorted.slice(0, needed)) {
            if (remainingSize <= this.config.maxCacheSize) {
              break;
            }
            toEvict.push(key);
            const entry = this.cache.get(key);
            if (entry) {
              remainingSize -= entry.size;
            }
          }
        }
        break;
      }
    }

    for (const key of toEvict) {
      const entry = this.cache.get(key);
      if (entry) {
        this.cache.delete(key);
        if (this.config.enablePersistence) {
          try {
            await this.storage.delete(key);
          } catch {
          }
        }
        this.metrics.evictions++;
      }
    }
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      try {
        await this.invalidate(key);
      } catch {
      }
    }
  }

  private updateMetrics(): void {
    const total = this.metrics.hits + this.metrics.misses;
    this.metrics.hitRate = total > 0 ? this.metrics.hits / total : 0;
  }

  private generateSessionId(): string {
    return `${EnhancedCacheManager.SESSION_ID_PREFIX}${Date.now()}${EnhancedCacheManager.KEY_SEPARATOR}${Math.random()
      .toString(EnhancedCacheManager.ID_RADIX)
      .substring(
        EnhancedCacheManager.ID_SUBSTRING_START,
        EnhancedCacheManager.ID_SUBSTRING_START + EnhancedCacheManager.ID_SUBSTRING_LENGTH,
      )}`;
  }

  getCacheConfig(): Readonly<Required<CacheConfig>> {
    return this.config;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    if (this.config.enablePersistence) {
      try {
        await this.storage.clear();
      } catch {
      }
    }
    this.metrics.hits = 0;
    this.metrics.misses = 0;
    this.metrics.hitRate = 0;
    this.metrics.totalSize = 0;
    this.metrics.entryCount = 0;
    this.metrics.evictions = 0;
    this.metrics.compressions = 0;
    this.metrics.prefetches = 0;
    this.metrics.invalidations = 0;
    this.metrics.performance.averageAccessTime = 0;
    this.metrics.performance.averageCompressionTime = 0;
    this.metrics.performance.averageDecompressionTime = 0;
  }
}

let cacheManager: EnhancedCacheManager | null = null;

function getCacheManager(): EnhancedCacheManager {
  if (!cacheManager) {
    cacheManager = new EnhancedCacheManager({
      enablePersistence: true,
      enableAnalytics: true,
      enablePrefetching: true,
      enableCrossTab: true,
      enableSWR: true,
    });
  }
  return cacheManager;
}

const CACHE_TTL = {
  STORE: 15 * 60 * 1000,
  QUOTA: 2 * 60 * 1000,
  PLANS: 60 * 60 * 1000,
  POSTS: 2 * 60 * 1000,
  ANALYTICS: 10 * 60 * 1000,
} as const;

export const queryKeys = {
  store: (shopDomain: string) => ['store', shopDomain] as const,
  quota: (storeId: string) => ['quota', storeId] as const,
  posts: (storeId: string, filters?: { readonly status?: string }) =>
    ['posts', storeId, filters] as const,
  post: (postId: string) => ['post', postId] as const,
  analytics: (storeId: string, dateRange?: { readonly start: string; readonly end: string }) =>
    ['analytics', storeId, dateRange] as const,
  postMetrics: (postId: string) => ['post-metrics', postId] as const,
};

function buildCacheKey(keys: readonly unknown[]): string {
  if (!Array.isArray(keys) || keys.length === 0) {
    return '';
  }
  try {
    return keys.map((k) => String(k)).join(':');
  } catch {
    return '';
  }
}

async function getCachedData<T>(
  cacheManager: EnhancedCacheManager,
  key: string,
  fetcher: () => Promise<T>,
  ttl: number,
  enableSWR: boolean,
): Promise<T> {
  const validatedKey = validateKey(key);
  if (!validatedKey) {
    return await fetcher();
  }

  try {
    const cached = await cacheManager.get<T>(validatedKey);
    if (cached !== null) {
      if (enableSWR) {
        fetcher()
          .then((data) => {
            cacheManager.set(validatedKey, data, ttl).catch(() => {
            });
          })
          .catch(() => {
          });
      }
      return cached;
    }
  } catch {
  }

  try {
    const data = await fetcher();
    await cacheManager.set(validatedKey, data, ttl);
    return data;
  } catch (error) {
    throw error;
  }
}

interface CachedQueryOptions {
  readonly refetchInterval?: number;
  readonly enabled?: boolean;
}

function createCachedQuery<T>(
  queryKey: readonly unknown[],
  fetcher: () => Promise<T>,
  ttl: number,
  options?: CachedQueryOptions,
): UseQueryResult<T, Error> {
  const cacheManager = getCacheManager();
  const config = cacheManager.getCacheConfig();

  const enabled = options?.enabled ?? true;

  const isQueryEnabled = (query: QueryWithState): boolean => {
    if (!enabled || query.state.status === 'error') {
      return false;
    }
    const identifier = query.queryKey[1];
    if (typeof identifier === 'string' && identifier.length === 0) {
      return false;
    }
    return true;
  };

  return useQuery({
    queryKey,
    queryFn: async () => {
      return getCachedData(cacheManager, buildCacheKey(queryKey), fetcher, ttl, config.enableSWR);
    },
    staleTime: ttl,
    gcTime: ttl * 2,
    enabled,
    refetchInterval: options?.refetchInterval
      ? (query: QueryWithState) => {
          if (!isQueryEnabled(query)) {
            return false;
          }
          return options.refetchInterval!;
        }
      : false,
  });
}

const isWrappedResponse = (result: unknown): result is { data: unknown } => {
  return (
    result !== null &&
    typeof result === 'object' &&
    'data' in result &&
    !('id' in result) &&
    !('shop_domain' in result)
  );
};

export function useStore(shopDomain: string): UseQueryResult<unknown, Error> {
  const validatedShopDomain = validateShopDomain(shopDomain);
  const hasShopDomain = !!validatedShopDomain;

  return useQuery({
    queryKey: queryKeys.store(shopDomain),
    queryFn: async () => {
      if (!hasShopDomain) {
        return null;
      }
      try {
        const result = await storeApi.getStore(validatedShopDomain!);

        if (isWrappedResponse(result)) {
          return result.data;
        }

        return result;
      } catch (error) {
        throw error;
      }
    },
    staleTime: CACHE_TTL.STORE,
    gcTime: CACHE_TTL.STORE * 2,
    enabled: hasShopDomain,
  });
}

export function useQuotaStatus(storeId: string): UseQueryResult<unknown, Error> {
  const validatedStoreId = validateStoreId(storeId);
  const hasStoreId = !!validatedStoreId;

  return createCachedQuery(
    queryKeys.quota(storeId),
    async () => {
      if (!hasStoreId) {
        return null;
      }
      return storeApi.getQuotaStatus(validatedStoreId!);
    },
    CACHE_TTL.QUOTA,
    {
      refetchInterval: CACHE_TTL.QUOTA * 2,
      enabled: hasStoreId,
    },
  );
}

export function usePosts(
  storeId: string,
  filters?: { readonly status?: string },
): UseQueryResult<readonly BlogPost[], Error> {
  const validatedStoreId = validateStoreId(storeId);
  const hasStoreId = !!validatedStoreId;

  return createCachedQuery(
    queryKeys.posts(storeId, filters),
    async () => {
      if (!hasStoreId) {
        return [];
      }
      return postsApi.list(validatedStoreId!, filters);
    },
    CACHE_TTL.POSTS,
    { enabled: hasStoreId },
  );
}

interface UpdatePostParams {
  readonly postId: string;
  readonly updates: Partial<BlogPost>;
}

export function useUpdatePost(): UseMutationResult<BlogPost, Error, UpdatePostParams> {
  const queryClient = useQueryClient();
  const cacheManager = getCacheManager();

  return useMutation({
    mutationFn: async ({ postId, updates }: UpdatePostParams): Promise<BlogPost> => {
      const validatedPostId = validatePostId(postId);
      if (!validatedPostId) {
        throw new Error('Invalid post ID');
      }

      try {
        return await postsApi.update(validatedPostId, updates);
      } catch (error) {
        throw error;
      }
    },
    onSuccess: async (data: BlogPost) => {
      try {
        queryClient.invalidateQueries({ queryKey: queryKeys.post(data.id) });
        queryClient.invalidateQueries({ queryKey: ['posts'] });
        await cacheManager.set(buildCacheKey(queryKeys.post(data.id)), data, CACHE_TTL.POSTS);
      } catch {
      }
    },
  });
}
