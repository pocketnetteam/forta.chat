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

    // Chain on any in-flight flush so batches commit in enqueue order.
    const prev = this.inFlight ?? Promise.resolve();
    const run = prev.then(async () => {
      try {
        await this.onFlush(items);
      } catch (err) {
        console.error("[WriteBuffer] flush failed:", err);
      }
    });
    this.inFlight = run;
    await run;
    if (this.inFlight === run) {
      this.inFlight = null;
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
