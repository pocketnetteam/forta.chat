const counts = new Map<string, number>();
const WARN_THRESHOLD_MS = 16; // 1 frame

export function perfMark(label: string): void {
  performance.mark(`perf:${label}`);
}

export function perfMeasure(name: string, startLabel: string, endLabel: string): number {
  try {
    performance.measure(`perf:${name}`, `perf:${startLabel}`, `perf:${endLabel}`);
    const entry = performance.getEntriesByName(`perf:${name}`).pop();
    const duration = entry?.duration ?? 0;
    if (duration > WARN_THRESHOLD_MS) {
      console.warn(`[PERF] ${name}: ${duration.toFixed(1)}ms`);
    }
    return duration;
  } catch {
    return 0;
  }
}

export function perfCount(name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

export function getPerfCounts(): ReadonlyMap<string, number> {
  return counts;
}

export function resetPerfCounts(): void {
  counts.clear();
}
