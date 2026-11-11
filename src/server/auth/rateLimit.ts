const WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; count: number }>();

/**
 * A fixed one-minute window counter kept in the memory of this process.
 * Returns false once `perMinute` requests were seen for the key in the window.
 */
export function rateLimit(key: string, perMinute: number, now: number = Date.now()): boolean {
  const current = windows.get(key);
  if (!current || now - current.start >= WINDOW_MS) {
    windows.set(key, { start: now, count: 1 });
    // Keep the map from growing without bound.
    if (windows.size > 10_000) for (const [k, w] of windows) if (now - w.start >= WINDOW_MS) windows.delete(k);
    return true;
  }
  if (current.count >= perMinute) return false;
  current.count += 1;
  return true;
}

export function resetRateLimits(): void {
  windows.clear();
}
