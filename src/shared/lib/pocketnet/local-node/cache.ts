import { LOCAL_NODE_CONSTANTS } from "./constants";

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/** Methods with short in-session TTL (subset of proxy16 ckeys). */
const TTL_MS: Record<string, number> = {
  getnodeinfo: 15_000,
  getuserprofile: 60_000,
  searchusers: 30_000,
  getsubscribeschannels: 60_000,
  getprofilefeed: 20_000,
};

export class LocalNodeCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts?: { maxEntries?: number; now?: () => number }) {
    this.maxEntries = opts?.maxEntries ?? LOCAL_NODE_CONSTANTS.CACHE_MAX_ENTRIES;
    this.now = opts?.now ?? Date.now;
  }

  cacheKey(method: string, parameters: unknown[]): string | null {
    if (!(method in TTL_MS)) return null;
    try {
      return `${method}:${JSON.stringify(parameters)}`;
    } catch {
      return null;
    }
  }

  get(key: string): unknown | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown, method: string): void {
    const ttl = TTL_MS[method] ?? 0;
    if (ttl <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest != null) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
  }

  async wrap(
    key: string | null,
    method: string,
    skipRead: boolean,
    produce: () => Promise<unknown>,
  ): Promise<unknown> {
    if (key && !skipRead) {
      const hit = this.get(key);
      if (hit !== undefined) return hit;
      const pending = this.inflight.get(key);
      if (pending) return pending;
    }

    const run = produce().then((value) => {
      if (key) {
        this.set(key, value, method);
        this.inflight.delete(key);
      }
      return value;
    }, (err) => {
      if (key) this.inflight.delete(key);
      throw err;
    });

    if (key) this.inflight.set(key, run);
    return run;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}
