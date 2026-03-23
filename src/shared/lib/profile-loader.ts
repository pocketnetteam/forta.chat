/**
 * ProfileLoader — DataLoader-pattern for user profile loading.
 *
 * Collects all address requests within a microtick into a single batch,
 * then processes with concurrency control + yielding to keep the UI responsive.
 *
 * Deduplication of in-flight requests is handled by PromisePool inside
 * loadUsersBatch — this class only handles microtick batching and yielding.
 *
 * Usage:
 *   const loader = new ProfileLoader(addr => userStore.loadUsersBatch(addr));
 *   // Multiple callers in same tick — merged into one batch:
 *   loader.load('addr1');
 *   loader.load('addr2');
 *   loader.load('addr3');
 */

/** How many addresses to send in one API batch */
const BATCH_SIZE = 30;

/** Pause between batches to yield to the event loop (ms) */
const YIELD_MS = 16; // ~1 frame

export class ProfileLoader {
  private pending = new Set<string>();
  private scheduled = false;
  private readonly loadFn: (addresses: string[]) => Promise<void>;

  constructor(loadFn: (addresses: string[]) => Promise<void>) {
    this.loadFn = loadFn;
  }

  /** Enqueue addresses for loading. Collected into batches automatically. */
  load(addresses: string[]): void {
    for (const addr of addresses) {
      if (addr) {
        this.pending.add(addr);
      }
    }
    if (!this.scheduled && this.pending.size > 0) {
      this.scheduled = true;
      // Schedule flush on next microtick — collects all same-frame requests
      queueMicrotask(() => this.flush());
    }
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    if (this.pending.size === 0) return;

    const all = [...this.pending];
    this.pending.clear();

    // Process in batches with yielding
    for (let i = 0; i < all.length; i += BATCH_SIZE) {
      const batch = all.slice(i, i + BATCH_SIZE);
      try {
        await this.loadFn(batch);
      } catch {
        // Caller handles errors via store reactivity
      }
      // Yield to event loop between batches so UI can repaint
      if (i + BATCH_SIZE < all.length) {
        await new Promise(r => setTimeout(r, YIELD_MS));
      }
    }

    // If more requests accumulated during loading, flush again
    if (this.pending.size > 0) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }
}
