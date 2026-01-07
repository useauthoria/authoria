const PREFETCH_REL = 'prefetch' as const;
const MAILTO_PROTOCOL = 'mailto:' as const;
const TEL_PROTOCOL = 'tel:' as const;
const LINK_SELECTOR = 'a[href]' as const;
const MOUSEENTER_EVENT = 'mouseenter' as const;
const THROTTLE_DELAY_MS = 100;
const MAX_PREFETCHED_URLS = 100;

interface PrefetchState {
  readonly prefetchedUrls: Set<string>;
  readonly handler: (event: Event) => void;
  readonly cleanup: () => void;
}

let prefetchState: PrefetchState | null = null;

function isElement(node: EventTarget | null): node is Element {
  return node !== null && node instanceof Element;
}

function isHTMLAnchorElement(element: Element | null): element is HTMLAnchorElement {
  return element !== null && element instanceof HTMLAnchorElement;
}

function isValidPrefetchUrl(url: string): boolean {
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    return false;
  }

  if (url.startsWith(MAILTO_PROTOCOL) || url.startsWith(TEL_PROTOCOL)) {
    return false;
  }

  try {
    const urlObj = new URL(url, window.location.origin);
    return urlObj.origin === window.location.origin && (urlObj.protocol === 'http:' || urlObj.protocol === 'https:');
  } catch {
    return false;
  }
}

function createPrefetchLink(href: string): HTMLLinkElement | null {
  try {
    const linkElement = document.createElement('link');
    linkElement.rel = PREFETCH_REL;
    linkElement.href = href;
    return linkElement;
  } catch {
    return null;
  }
}

function createThrottledHandler(prefetchedUrls: Set<string>): (event: Event) => void {
  let lastCallTime = 0;

  return (event: Event): void => {
    const now = Date.now();
    if (now - lastCallTime < THROTTLE_DELAY_MS) {
      return;
    }
    lastCallTime = now;

    const target = event.target;
    if (!isElement(target)) {
      return;
    }

    const link = target.closest(LINK_SELECTOR);
    if (!isHTMLAnchorElement(link)) {
      return;
    }

    const href = link.href;
    if (!isValidPrefetchUrl(href)) {
      return;
    }

    prefetchUrl(href, prefetchedUrls);
  };
}

function prefetchUrl(url: string, prefetchedUrls: Set<string>): void {
  if (prefetchedUrls.has(url)) {
    return;
  }

  if (prefetchedUrls.size >= MAX_PREFETCHED_URLS) {
    const firstUrl = prefetchedUrls.values().next().value;
    if (firstUrl) {
      const existingLink = document.querySelector(`link[rel="${PREFETCH_REL}"][href="${firstUrl}"]`);
      if (existingLink) {
        existingLink.remove();
      }
      prefetchedUrls.delete(firstUrl);
    }
  }

  const linkElement = createPrefetchLink(url);
  if (linkElement) {
    document.head.appendChild(linkElement);
    prefetchedUrls.add(url);
  }
}

export function setupLinkPrefetching(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  if (prefetchState !== null) {
    return;
  }

  const prefetchedUrls = new Set<string>();
  const handler = createThrottledHandler(prefetchedUrls);
  
  const cleanup = (): void => {
    document.removeEventListener(MOUSEENTER_EVENT, handler, true);
    prefetchedUrls.forEach((url) => {
      const link = document.querySelector(`link[rel="${PREFETCH_REL}"][href="${url}"]`);
      if (link) {
        link.remove();
      }
    });
    prefetchedUrls.clear();
  };

  prefetchState = {
    prefetchedUrls,
    handler,
    cleanup,
  };

  document.addEventListener(MOUSEENTER_EVENT, handler, true);
}

export function prefetchCriticalRoutes(): void {
  if (typeof document === 'undefined') {
    return;
  }
}

export function cleanupLinkPrefetching(): void {
  if (prefetchState === null) {
    return;
  }

  prefetchState.cleanup();
  prefetchState = null;
}
