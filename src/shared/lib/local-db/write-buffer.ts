import type { LocalMessage } from "./schema";
import type { ParsedMessage } from "./event-writer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BufferedWrite {
  roomId: string;
  localMsg: LocalMessage;
  parsed: ParsedMessage;
  myAddress?: string;
  activeRoomId?: string | null;
}

export interface WriteBufferOptions {
  /** Milliseconds to wait before flushing (default 150) */
  delayMs?: number;
  /** Force-flush when buffer reaches this size (default 50) */
  maxSize?: number;
}

type FlushCallback<T> = (items: T[]) => Promise<void>;

/** A batch whose write failed is put back and tried again this many times
 *  (with a growing delay) before it is dropped. It used to be dropped at once,
 *  losing the incoming messages it held (audit S3-01). */
export const WRITE_BUFFER_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// WriteBuffer — accumulates DB writes and flushes them in a single batch
// ---------------------------------------------------------------------------

export class WriteBuffer<T = BufferedWrite> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;
  private readonly maxSize: number;
  private disposed = false;
  /** In-flight flush chain — flushes are serialized and awaitable, so
   *  flushNow() callers get a real "everything enqueued before this call
   *  is committed" guarantee even when a maxSize force-flush is running. */
  private inFlight: Promise<void> | null = null;
  /** Failed flushes in a row. */
  private failures = 0;
  /** A failed batch sits at the front of the buffer waiting for its retry;
   *  `requeuedHead` items there belong to it and any batch chained behind it. */
  private retryPending = false;
  private requeuedHead = 0;
  /** Batches taken off the buffer whose onFlush has not finished yet. */
  private readonly flushing = new Set<T[]>();

  constructor(
    private readonly onFlush: FlushCallback<T>,
    options?: WriteBufferOptions,
  ) {
    this.delayMs = options?.delayMs ?? 150;
    this.maxSize = options?.maxSize ?? 50;
  }

  /** Add an item to the buffer. Starts the flush timer or force-flushes if full. */
  enqueue(item: T): void {
    if (this.disposed) return;

    this.buffer.push(item);

    if (this.buffer.length >= this.maxSize) {
      this.clearTimer();
      void this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.delayMs);
    }
  }

  /** True if any item not yet committed matches `predicate` — still
   *  buffered, or in a flush that is running or queued. */
  hasPending(predicate: (item: T) => boolean): boolean {
    if (this.buffer.some(predicate)) return true;
    for (const batch of this.flushing) {
      if (batch.some(predicate)) return true;
    }
    return false;
  }

  /** Immediately drain the buffer (returns when flush completes — including
   *  any flush that was already in flight when this was called). */
  async flushNow(): Promise<void> {
    this.clearTimer();
    const pending = this.inFlight;
    if (pending) await pending;
    await this.flush();
  }

  /** Flush remaining items and stop all pending timers. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimer();
    const pending = this.inFlight;
    if (pending) await pending;
    if (this.buffer.length > 0) {
      await this.flush();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const items = this.buffer;
    this.buffer = [];
    this.retryPending = false;
    this.requeuedHead = 0;
    this.flushing.add(items);

    // Chain on any in-flight flush so batches commit in enqueue order.
    const prev = this.inFlight ?? Promise.resolve();
    const run = prev.then(async () => {
      // A batch taken before an older one failed must not land ahead of it:
      // go back into the buffer right behind the failed batch and retry with it.
      if (this.retryPending) {
        this.buffer.splice(this.requeuedHead, 0, ...items);
        this.requeuedHead += items.length;
        // Back in the buffer, so hasPending() still sees them; a stale batch
        // left in `flushing` would report them pending forever.
        this.flushing.delete(items);
        return;
      }
      try {
        await this.onFlush(items);
        this.failures = 0;
      } catch (err) {
        this.failures++;
        if (!this.disposed && this.failures <= WRITE_BUFFER_MAX_RETRIES) {
          console.warn(`[WriteBuffer] flush failed, will retry (${this.failures}/${WRITE_BUFFER_MAX_RETRIES}):`, err);
          // Back in front of anything enqueued meanwhile, so order holds.
          this.buffer = items.concat(this.buffer);
          this.requeuedHead = items.length;
          this.retryPending = true;
          this.scheduleRetry();
        } else {
          console.error(`[WriteBuffer] flush failed, dropping ${items.length} item(s):`, err);
          this.failures = 0;
        }
      } finally {
        this.flushing.delete(items);
      }
    });
    this.inFlight = run;
    await run;
    if (this.inFlight === run) {
      this.inFlight = null;
    }
  }

  private scheduleRetry(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs * 2 ** this.failures);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
