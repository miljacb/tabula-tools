/**
 * Page memory as far as the browser exposes it.
 * - JS heap: Chrome's `performance.memory` (coarse and delayed on purpose; JS objects only).
 * - Full page: `performance.measureUserAgentSpecificMemory()`, Chrome, only when cross-origin isolated.
 *   Covers JS, DOM and canvas; never GPU memory.
 */

/** @returns {{ used: number, allocated: number, limit: number } | null} bytes */
export function readJsHeap() {
  const m = /** @type {any} */ (globalThis.performance)?.memory;
  if (!m || !(m.usedJSHeapSize > 0)) return null;
  return { used: m.usedJSHeapSize, allocated: m.totalJSHeapSize, limit: m.jsHeapSizeLimit };
}

export function canMeasurePageMemory() {
  return globalThis.crossOriginIsolated === true
    && typeof /** @type {any} */ (globalThis.performance)?.measureUserAgentSpecificMemory === 'function';
}

/**
 * Why a full measurement is unavailable, for the panel.
 * @returns {string} empty when available
 */
export function pageMemoryUnavailableReason() {
  if (typeof /** @type {any} */ (globalThis.performance)?.measureUserAgentSpecificMemory !== 'function') {
    return 'Full page memory needs Chrome or Edge.';
  }
  if (globalThis.crossOriginIsolated !== true) {
    return 'Full page memory needs the page served with cross-origin isolation headers.';
  }
  return '';
}

/**
 * Totals per memory type from a measureUserAgentSpecificMemory() result.
 * Entries with several types (e.g. ['JavaScript', 'DOM']) are counted under their joined name.
 * @param {{ bytes: number, breakdown: { bytes: number, types: string[] }[] }} result
 */
export function summarizePageMemory(result) {
  /** @type {Record<string, number>} */
  const byType = {};
  for (const entry of result.breakdown || []) {
    if (!entry.bytes) continue;
    const type = entry.types?.length ? entry.types.join(' + ') : 'Other';
    byType[type] = (byType[type] || 0) + entry.bytes;
  }
  return { total: result.bytes, byType };
}

/** Resolves when the browser finishes (can take seconds; Chrome waits for a garbage collection). */
export async function measurePageMemory() {
  const result = await /** @type {any} */ (performance).measureUserAgentSpecificMemory();
  return summarizePageMemory(result);
}
