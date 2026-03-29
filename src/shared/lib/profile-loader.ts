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
const BATCH_SIZE = 10;

/** Pause between batches to yield to the event loop (ms) */
const YIELD_MS = 150;

/** Sentinel value to signal the loadFn to suppress intermediate reactive triggers */
export const PROFILE_LOADER_BATCH_ACTIVE = { active: false };

/** Schedule callback during idle time, falling back to setTimeout */
function scheduleIdle(cb: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => cb(), { timeout: 2000 });
  } else {
    setTimeout(cb, 50);
  }
}

export class ProfileLoader {
  private pending = new Set<string>();
  private scheduled = false;
  private readonly loadFn: (addresses: string[]) => Promise<void>;
  private readonly onFlushComplete?: () => void;

  constructor(loadFn: (addresses: string[]) => Promise<void>, onFlushComplete?: () => void) {
    this.loadFn = loadFn;
    this.onFlushComplete = onFlushComplete;
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
      // Schedule flush during idle time — doesn't compete with UI interactions
      scheduleIdle(() => this.flush());
    }
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    if (this.pending.size === 0) return;

    const all = [...this.pending];
    this.pending.clear();

    // Suppress intermediate reactive triggers during batch loading.
    // The onFlushComplete callback fires once at the end to trigger a single UI update.
    PROFILE_LOADER_BATCH_ACTIVE.active = true;

    // Process in small batches with generous yielding between them
    for (let i = 0; i < all.length; i += BATCH_SIZE) {
      const batch = all.slice(i, i + BATCH_SIZE);
      try {
        await this.loadFn(batch);
      } catch {
        // Caller handles errors via store reactivity
      }
      // Yield generously between batches so UI stays responsive
      if (i + BATCH_SIZE < all.length) {
        await new Promise(r => setTimeout(r, YIELD_MS));
      }
    }

    PROFILE_LOADER_BATCH_ACTIVE.active = false;
    // Notify store to trigger a single reactive update for all loaded profiles
    this.onFlushComplete?.();

    // If more requests accumulated during loading, flush again via idle
    if (this.pending.size > 0) {
      this.scheduled = true;
      scheduleIdle(() => this.flush());
    }
  }
}
