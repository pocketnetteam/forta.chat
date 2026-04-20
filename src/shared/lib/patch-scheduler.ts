/**
 * Coalesces rapid successive calls into a single flush per animation frame.
 *
 * WHY: when many reactive writers target the same derived state in quick
 * succession (Dexie delta hooks + optimistic UI patches + flushWriteBuffer),
 * each write produces its own reactive commit and its own render. That shows
 * up as flicker — especially when downstream layout is isolated via
 * `contain: strict`. Batching multiple updates into one frame collapses the
 * cascade to a single render.
 */
export interface PatchScheduler<T> {
  /** Append items to the pending batch; schedule a flush if one isn't already pending. */
  schedule(items: readonly T[]): void;
  /** Cancel the pending flush and drop any queued items. */
  cancel(): void;
}

export interface PatchSchedulerOptions {
  /** Override rAF detection — useful for forcing microtask fallback in tests. */
  useRaf?: boolean;
}

export function createPatchScheduler<T>(
  flush: (batch: T[]) => void,
  opts: PatchSchedulerOptions = {},
): PatchScheduler<T> {
  const useRaf = opts.useRaf ?? (typeof requestAnimationFrame !== "undefined");
  let pending: T[] = [];
  let rafId: number | null = null;

  const run = () => {
    rafId = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    flush(batch);
  };

  return {
    schedule(items) {
      if (items.length === 0) return;
      pending.push(...items);
      if (rafId !== null) return;
      if (useRaf) {
        rafId = requestAnimationFrame(run);
      } else {
        // Non-browser env (tests, SSR): microtask keeps batching within a tick.
        rafId = 1;
        queueMicrotask(run);
      }
    },
    cancel() {
      if (rafId !== null && useRaf) cancelAnimationFrame(rafId);
      rafId = null;
      pending = [];
    },
  };
}
