/**
 * Service Worker for Authoria
 * Provides offline support and asset caching
 */

const CACHE_NAME = 'authoria-v1';
const RUNTIME_CACHE = 'authoria-runtime-v1';

// Assets to cache on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting(); // Activate immediately
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== RUNTIME_CACHE)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim(); // Take control of all pages
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip cross-origin requests (except API calls we want to cache)
  if (url.origin !== location.origin && !url.pathname.startsWith('/functions/v1/')) {
    return;
  }

  // Strategy: Cache First for static assets, Network First for API calls
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
  } else if (isApiCall(url.pathname)) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});

/**
 * Check if URL is a static asset
 */
function isStaticAsset(pathname) {
  return (
    pathname.endsWith('.js') ||
    pathname.endsWith('.css') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.jpg') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.woff') ||
    pathname.endsWith('.woff2')
  );
}

/**
 * Check if URL is an API call
 */
function isApiCall(pathname) {
  return pathname.startsWith('/functions/v1/') || pathname.startsWith('/api/');
}

/**
 * Cache First strategy - check cache, fallback to network
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // Return offline page or error response
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Network First strategy - try network, fallback to cache
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Cache successful API responses (with TTL)
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // Network failed, try cache
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    // Return error response
    return new Response('Network error and no cache available', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

/**
 * Background sync for offline actions
 */
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-posts') {
    event.waitUntil(syncPosts());
  }
});

async function syncPosts() {
  // Sync any pending posts created offline
  // This would integrate with IndexedDB or local storage
  console.log('Syncing posts...');
}

