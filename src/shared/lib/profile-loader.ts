/**
 * ProfileLoader — DataLoader-pattern for user profile loading.
 *
 * Collects all address requests within a collection window into a single batch,
 * then processes with concurrency control + yielding to keep the UI responsive.
 *
 * Deduplication of in-flight requests is handled by PromisePool inside
 * loadUsersBatch — this class only handles batching and yielding.
 *
 * Usage:
 *   const loader = new ProfileLoader(addr => userStore.loadUsersBatch(addr));
 *   // Multiple callers within the collection window — merged into one batch:
 *   loader.load('addr1');
 *   loader.load('addr2');
 *   loader.load('addr3');
 */

/** How many addresses to send in one API batch.
 *  getuserprofile RPC supports up to 70 addresses per call.
 *  30 balances throughput with responsiveness. */
const BATCH_SIZE = 30;

/** Pause between batches to yield to the event loop (ms) */
const YIELD_MS = 50;

/** How long to wait after the first load() call before flushing (ms).
 *  Addresses from different async init phases (cache, sync, UI components)
 *  arrive over ~100-200ms. A short fixed delay collects them into fewer batches
 *  than requestIdleCallback which can fire within 1ms when idle. */
const COLLECT_MS = 100;

/** Sentinel value to signal the loadFn to suppress intermediate reactive triggers */
export const PROFILE_LOADER_BATCH_ACTIVE = { active: false };

export class ProfileLoader {
  private pending = new Set<string>();
  private scheduled = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
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
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, COLLECT_MS);
    }
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    if (this.pending.size === 0) return;

    const all = [...this.pending];
    this.pending.clear();

    PROFILE_LOADER_BATCH_ACTIVE.active = true;

    for (let i = 0; i < all.length; i += BATCH_SIZE) {
      const batch = all.slice(i, i + BATCH_SIZE);
      try {
        await this.loadFn(batch);
      } catch {
        // Caller handles errors via store reactivity
      }
      if (i + BATCH_SIZE < all.length) {
        await new Promise(r => setTimeout(r, YIELD_MS));
      }
    }

    PROFILE_LOADER_BATCH_ACTIVE.active = false;
    this.onFlushComplete?.();

    // If more requests accumulated during loading, flush again after collection window
    if (this.pending.size > 0) {
      this.scheduled = true;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, COLLECT_MS);
    }
  }
}
