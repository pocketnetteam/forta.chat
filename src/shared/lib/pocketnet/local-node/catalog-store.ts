import type { SeedMeta } from "./types";

const STORAGE_KEY = "forta-chat:localnode-catalog-v1";

export interface CatalogDoc extends SeedMeta {
  key: string;
}

export class LocalNodeCatalogStore {
  private memory: CatalogDoc[] = [];
  private readonly persist: boolean;

  constructor(opts?: { persist?: boolean; memoryOnly?: boolean }) {
    this.persist = opts?.memoryOnly === true ? false : opts?.persist !== false;
    if (this.persist) this.reloadFromStorage();
  }

  private reloadFromStorage(): void {
    try {
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as CatalogDoc[];
      if (Array.isArray(parsed)) this.memory = parsed.filter((d) => d?.key && d?.host);
    } catch {
      this.memory = [];
    }
  }

  private flush(): void {
    if (!this.persist) return;
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.memory));
    } catch {
      /* quota / private mode */
    }
  }

  async open(): Promise<void> {
    if (this.persist) this.reloadFromStorage();
  }

  async close(): Promise<void> {
    this.flush();
  }

  async list(limit?: number): Promise<CatalogDoc[]> {
    const all = [...this.memory];
    if (limit == null || limit >= all.length) return all;
    // Shuffle-ish: take from end then start for variety on cold start.
    return all.slice(0, limit);
  }

  async upsertMany(docs: CatalogDoc[]): Promise<void> {
    for (const doc of docs) {
      if (!doc?.key || !doc.host) continue;
      const idx = this.memory.findIndex((d) => d.key === doc.key);
      if (idx >= 0) this.memory[idx] = { ...this.memory[idx], ...doc };
      else this.memory.push(doc);
    }
    this.flush();
  }

  async removeKeys(keys: string[]): Promise<void> {
    const drop = new Set(keys);
    this.memory = this.memory.filter((d) => !drop.has(d.key));
    this.flush();
  }

  async clear(): Promise<void> {
    this.memory = [];
    this.flush();
  }
}
