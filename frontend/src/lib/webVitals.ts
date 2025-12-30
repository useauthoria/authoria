export interface WebVitalsMetrics {
  readonly appId?: string;
  readonly shopId?: string;
  readonly userId?: string;
  readonly appLoadId?: string;
  readonly metrics?: Array<{
    readonly name: string;
    readonly value: number;
    readonly id: string;
    readonly delta: number;
    readonly entries: readonly PerformanceEntry[];
  }>;
}

export function initWebVitalsMonitoring(
  onReport: (metrics: WebVitalsMetrics) => void,
): void {
  // Web Vitals are already being tracked by Shopify App Bridge
  // This function is a placeholder for custom Web Vitals tracking if needed
  // Currently unused - callback does nothing
}
