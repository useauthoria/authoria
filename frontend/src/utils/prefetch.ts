export function setupLinkPrefetching(): void {
  if (typeof document === 'undefined') return;

  document.addEventListener('mouseenter', (event) => {
    const target = event.target;
    if (!target || typeof (target as Element).closest !== 'function') return;
    const link = (target as Element).closest('a[href]') as HTMLAnchorElement | null;

    if (link && link.href && !link.href.startsWith('mailto:') && !link.href.startsWith('tel:')) {
      const url = new URL(link.href, window.location.origin);
      if (url.origin === window.location.origin) {
        // Prefetch on hover
        const linkElement = document.createElement('link');
        linkElement.rel = 'prefetch';
        linkElement.href = link.href;
        document.head.appendChild(linkElement);
      }
    }
  }, true);
}

export function prefetchCriticalRoutes(): void {
  if (typeof document === 'undefined') return;

  const criticalRoutes = ['/dashboard', '/posts', '/analytics', '/settings'];

  criticalRoutes.forEach((route) => {
    const linkElement = document.createElement('link');
    linkElement.rel = 'prefetch';
    linkElement.href = route;
    document.head.appendChild(linkElement);
  });
}
