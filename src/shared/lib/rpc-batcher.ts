export interface RpcBatcherOptions<TKey, TItem> {
  /** Send a batch of keys to the RPC, return a flat array of response items. */
  execute: (keys: TKey[]) => Promise<TItem[]>;
  /** Extract the grouping key from a response item so it can be routed back to the caller. */
  keyOf: (item: TItem) => TKey;
  /** Batching window in ms (default 50). */
  delayMs?: number;
}

interface PendingEntry<TItem> {
  resolve: (items: TItem[]) => void;
  reject: (err: unknown) => void;
}

/**
 * Generic DataLoader-style batcher for RPC calls.
 *
 * Collects individual `load(key)` calls within a time window,
 * flushes them as a single batched RPC request, then splits
 * the response back to each caller by key.
 */
export class RpcBatcher<TKey = string, TItem = unknown> {
  private pending = new Map<TKey, PendingEntry<TItem>[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly execute: RpcBatcherOptions<TKey, TItem>["execute"];
  private readonly keyOf: RpcBatcherOptions<TKey, TItem>["keyOf"];
  private readonly delayMs: number;

  constructor(options: RpcBatcherOptions<TKey, TItem>) {
    this.execute = options.execute;
    this.keyOf = options.keyOf;
    this.delayMs = options.delayMs ?? 50;
  }

  /** Enqueue a key for batched loading. Returns a promise that resolves with items matching this key. */
  load(key: TKey): Promise<TItem[]> {
    return new Promise<TItem[]>((resolve, reject) => {
      let entries = this.pending.get(key);
      if (!entries) {
        entries = [];
        this.pending.set(key, entries);
      }
      entries.push({ resolve, reject });

      if (this.timer === null) {
        this.timer = setTimeout(() => void this.flush(), this.delayMs);
      }
    });
  }

  private async flush(): Promise<void> {
    this.timer = null;

    const batch = this.pending;
    this.pending = new Map();

    const keys = [...batch.keys()];
    if (keys.length === 0) return;

    try {
      const raw = await this.execute(keys);
      const items = Array.isArray(raw) ? raw : [];

      const grouped = new Map<TKey, TItem[]>();
      for (const item of items) {
        const k = this.keyOf(item);
        let list = grouped.get(k);
        if (!list) {
          list = [];
          grouped.set(k, list);
        }
        list.push(item);
      }

      for (const [key, entries] of batch) {
        const result = grouped.get(key) ?? [];
        for (const entry of entries) entry.resolve(result);
      }
    } catch (err) {
      for (const entries of batch.values()) {
        for (const entry of entries) entry.reject(err);
      }
    }
  }
}
