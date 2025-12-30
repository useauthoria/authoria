import { useQuery, useMutation, useQueryClient, QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { storeApi, postsApi, analyticsApi, type BlogPost } from './api-client';

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
    if (!('indexedDB' in window)) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'key' });
          store.createIndex(PersistentCacheStorage.EXPIRES_AT_INDEX, PersistentCacheStorage.EXPIRES_AT_INDEX, { unique: false });
          store.createIndex(PersistentCacheStorage.LAST_ACCESSED_INDEX, PersistentCacheStorage.LAST_ACCESSED_INDEX, { unique: false });
        }
      };
    });
  }

  async get<T>(key: string): Promise<MutableCacheEntry<T> | null> {
    if (!this.db) {
      const item = localStorage.getItem(`${PersistentCacheStorage.KEY_PREFIX}${key}`);
      return item ? (JSON.parse(item) as MutableCacheEntry<T>) : null;
    }

    return new Promise<MutableCacheEntry<T> | null>((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve((request.result?.value ?? null) as MutableCacheEntry<T> | null);
    });
  }

  async set<T>(key: string, entry: MutableCacheEntry<T>): Promise<void> {
    if (!this.db) {
      localStorage.setItem(`${PersistentCacheStorage.KEY_PREFIX}${key}`, JSON.stringify(entry));
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put({ key, value: entry });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async delete(key: string): Promise<void> {
    if (!this.db) {
      localStorage.removeItem(`${PersistentCacheStorage.KEY_PREFIX}${key}`);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async clear(): Promise<void> {
    if (!this.db) {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(PersistentCacheStorage.KEY_PREFIX)) {
          keys.push(key);
        }
      }
      keys.forEach((key) => localStorage.removeItem(key));
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getAllKeys(): Promise<string[]> {
    if (!this.db) {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(PersistentCacheStorage.KEY_PREFIX)) {
          keys.push(key.replace(PersistentCacheStorage.KEY_PREFIX, ''));
        }
      }
      return keys;
    }

    return new Promise<string[]>((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAllKeys();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as string[]);
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

    if (this.config.enableCrossTab && typeof BroadcastChannel !== 'undefined') {
      this.broadcastChannel = new BroadcastChannel(EnhancedCacheManager.BROADCAST_CHANNEL_NAME);
      this.broadcastChannel.onmessage = (event) => {
        const message = event.data as BroadcastMessage;
        if (message.type === EnhancedCacheManager.INVALIDATE_MESSAGE_TYPE) {
          this.invalidate(message.key);
        } else if (message.type === EnhancedCacheManager.UPDATE_MESSAGE_TYPE && message.entry) {
          this.set(message.key, message.entry.data, 0, message.entry.dependencies);
        }
      };
    }

    this.init();
  }

  private async init(): Promise<void> {
    if (this.config.enablePersistence) {
      await this.storage.init();
      const keys = await this.storage.getAllKeys();
      for (const key of keys) {
        const entry = await this.storage.get(key);
        if (entry && entry.expiresAt > Date.now()) {
          this.cache.set(key, entry);
        }
      }
    }

    setInterval(() => this.cleanup(), EnhancedCacheManager.CLEANUP_INTERVAL);
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
    const startTime = Date.now();
    const fullKey = this.generateKey(key);

    let entry = this.cache.get(fullKey);

    if (!entry && this.config.enablePersistence) {
      const persistedEntry = await this.storage.get(fullKey);
      if (persistedEntry) {
        entry = persistedEntry;
        this.cache.set(fullKey, entry);
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
        await this.storage.delete(fullKey);
      }
      this.metrics.misses++;
      this.updateMetrics();
      return null;
    }

    if (this.config.enableVersioning && entry.version !== this.config.version) {
      this.invalidate(fullKey);
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
      (this.metrics.performance.averageAccessTime * (this.metrics.hits - 1) + accessTime) / this.metrics.hits;
    this.updateMetrics();

    return data as T;
  }

  async set<T>(key: string, data: T, ttl: number = 0, dependencies?: readonly string[]): Promise<void> {
    const fullKey = this.generateKey(key);

    const entry: MutableCacheEntry<T> = {
      data: data as T,
      timestamp: Date.now(),
      expiresAt: ttl > 0 ? Date.now() + ttl : Date.now() + EnhancedCacheManager.DEFAULT_TTL,
      accessCount: 0,
      lastAccessed: Date.now(),
      size: JSON.stringify(data).length,
      version: this.config.version,
      compressed: false,
      encrypted: false,
      partition: this.config.partition,
      dependencies: dependencies ? [...dependencies] : undefined,
      metadata: {},
    };

    await this.evictIfNeeded(entry.size);

    this.cache.set(fullKey, entry);

    if (this.config.enablePersistence) {
      await this.storage.set(fullKey, entry);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: EnhancedCacheManager.UPDATE_MESSAGE_TYPE,
        key: fullKey,
        entry,
      } as BroadcastMessage);
    }

    this.metrics.totalSize += entry.size;
    this.metrics.entryCount = this.cache.size;
    this.updateMetrics();
  }

  async invalidate(key: string): Promise<void> {
    const fullKey = this.generateKey(key);

    if (this.config.enableMiddleware) {
      for (const mw of this.middleware) {
        if (mw.beforeInvalidate) {
          if (!mw.beforeInvalidate(fullKey)) {
            return;
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
      await this.storage.delete(fullKey);
    }

    if (entry?.dependencies) {
      for (const dep of entry.dependencies) {
        await this.invalidate(dep);
      }
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: EnhancedCacheManager.INVALIDATE_MESSAGE_TYPE,
        key: fullKey,
      } as BroadcastMessage);
    }

    this.metrics.invalidations++;
    this.updateMetrics();

    if (this.config.enableMiddleware) {
      for (const mw of this.middleware) {
        if (mw.afterInvalidate) {
          mw.afterInvalidate(fullKey);
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
          if (remainingSize <= this.config.maxCacheSize) break;
          toEvict.push(key);
          const entry = this.cache.get(key);
          if (entry) {
            remainingSize -= entry.size;
          }
        }
        break;
      }
      case 'fifo': {
        const entries = Array.from(this.cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
        for (const [key] of entries) {
          if (remainingSize <= this.config.maxCacheSize) break;
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
          const needed = Math.ceil((remainingSize - this.config.maxCacheSize) / EnhancedCacheManager.MILLISECONDS_PER_SECOND);
          for (const key of sorted.slice(0, needed)) {
            if (remainingSize <= this.config.maxCacheSize) break;
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
          await this.storage.delete(key);
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
      await this.invalidate(key);
    }
  }

  private updateMetrics(): void {
    const total = this.metrics.hits + this.metrics.misses;
    this.metrics.hitRate = total > 0 ? this.metrics.hits / total : 0;
  }


  private generateSessionId(): string {
    return `${EnhancedCacheManager.SESSION_ID_PREFIX}${Date.now()}${EnhancedCacheManager.KEY_SEPARATOR}${Math.random().toString(EnhancedCacheManager.ID_RADIX).substring(EnhancedCacheManager.ID_SUBSTRING_START, EnhancedCacheManager.ID_SUBSTRING_START + EnhancedCacheManager.ID_SUBSTRING_LENGTH)}`;
  }


  getCacheConfig(): Readonly<Required<CacheConfig>> {
    return this.config;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    if (this.config.enablePersistence) {
      await this.storage.clear();
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
  STORE: 10 * 60 * 1000,
  QUOTA: 1 * 60 * 1000,
  PLANS: 60 * 60 * 1000,
  POSTS: 30 * 1000,
  ANALYTICS: 5 * 60 * 1000,
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
  return keys.join(':');
}

async function getCachedData<T>(
  cacheManager: EnhancedCacheManager,
  key: string,
  fetcher: () => Promise<T>,
  ttl: number,
  enableSWR: boolean,
): Promise<T> {
  const cached = await cacheManager.get<T>(key);
  if (cached) {
    if (enableSWR) {
      fetcher()
        .then((data) => {
          cacheManager.set(key, data, ttl);
        })
        .catch(() => {
        });
    }
    return cached;
  }
  const data = await fetcher();
  await cacheManager.set(key, data, ttl);
  return data;
}

function createCachedQuery<T>(
  queryKey: readonly unknown[],
  fetcher: () => Promise<T>,
  ttl: number,
  options?: { readonly refetchInterval?: number; readonly enabled?: boolean },
) {
  const cacheManager = getCacheManager();
  const config = cacheManager.getCacheConfig();

  // Extract enabled from options to ensure it's properly set
  const enabled = options?.enabled ?? true;

  return useQuery({
    queryKey,
    queryFn: async () => {
      return getCachedData(cacheManager, buildCacheKey(queryKey), fetcher, ttl, config.enableSWR);
    },
    staleTime: ttl,
    gcTime: ttl * 2,
    enabled,
    // Make refetchInterval a function that respects the enabled state dynamically
    // React Query will call this function and check if the query is enabled before refetching
    // The query object passed to this function has the current query state
    refetchInterval: options?.refetchInterval
      ? (query) => {
          // Only refetch if the query is currently enabled
          // Check query.isEnabled which reflects the current enabled state (not the closure variable)
          // Also skip if query is in error state or currently fetching
          if (!query.isEnabled || query.state.status === 'error' || query.isFetching) {
            return false;
          }
          // Additional safety: check if queryKey contains an empty string (for storeId/shopDomain-based queries)
          // The queryKey structure is: ['quota', storeId], ['posts', storeId, ...], ['analytics', storeId, ...], or ['store', shopDomain]
          // The identifier is always at index 1
          const identifier = query.queryKey[1];
          if (typeof identifier === 'string' && identifier === '') {
            return false;
          }
          return options.refetchInterval!;
        }
      : false,
  });
}

export function useStore(shopDomain: string) {
  // NOTE: Store data drives routing guards (SetupGuard) so it must respect React Query invalidation/refetch.
  // We intentionally do NOT use the persistent EnhancedCacheManager layer for this query.
  return useQuery({
    queryKey: queryKeys.store(shopDomain),
    queryFn: async () => {
      if (!shopDomain) {
        console.warn('[useStore] No shopDomain provided');
        return null;
      }
      try {
        const result = await storeApi.getStore(shopDomain);

        // Safety check: If result appears to be wrapped (has 'data' and 'correlationId' but not 'id'), unwrap it
        if (result && typeof result === 'object' && 'data' in result && !('id' in result) && !('shop_domain' in result)) {
          console.warn('[useStore] Detected wrapped response, unwrapping');
          return (result as { data: unknown }).data as typeof result;
        }

        return result;
      } catch (error) {
        console.error('[useStore] Query error:', { shopDomain, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    staleTime: CACHE_TTL.STORE,
    gcTime: CACHE_TTL.STORE * 2,
    enabled: !!shopDomain,
  });
}

export function useQuotaStatus(storeId: string) {
  return createCachedQuery(
    queryKeys.quota(storeId),
    async () => {
      // Defensive check: if storeId is empty, return null instead of throwing
      // This prevents errors during refetchInterval when storeId becomes empty
      if (!storeId) {
        return null;
      }
      return storeApi.getQuotaStatus(storeId);
    },
    CACHE_TTL.QUOTA,
    {
      refetchInterval: CACHE_TTL.QUOTA,
      enabled: !!storeId, // Only fetch if storeId is provided
    },
  );
}

export function usePosts(storeId: string, filters?: { readonly status?: string }) {
  return createCachedQuery(
    queryKeys.posts(storeId, filters),
    async () => {
      // Defensive check: if storeId is empty, return empty array instead of throwing
      // This prevents errors during refetchInterval when storeId becomes empty
      if (!storeId) {
        return [];
      }
      return postsApi.list(storeId, filters);
    },
    CACHE_TTL.POSTS,
    { enabled: !!storeId }, // Only fetch if storeId is provided
  );
}


export function useUpdatePost() {
  const queryClient = useQueryClient();
  const cacheManager = getCacheManager();

  return useMutation({
    mutationFn: ({ postId, updates }: { readonly postId: string; readonly updates: Partial<BlogPost> }) =>
      postsApi.update(postId, updates),
    onSuccess: async (data: BlogPost) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.post(data.id) });
      queryClient.invalidateQueries({ queryKey: ['posts'] });

      await cacheManager.set(buildCacheKey(queryKeys.post(data.id)), data, CACHE_TTL.POSTS);
    },
  });
}

