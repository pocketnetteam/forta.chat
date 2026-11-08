import type { NodeRpcRecord, SeedMeta } from "./types";

export class LocalNode {
  host: string;
  port: number;
  sport: number;
  ws: number;
  sws: number;
  name: string;
  stable: boolean;
  peer: boolean;
  local: boolean;
  addedby: string;
  version: string | null;
  vcode: number | null;
  bchain: string | null;
  allowRpc: boolean;
  key: string;
  inited = false;
  canuse = false;
  height = 0;
  initedTime: number | null = null;

  private readonly now: () => number;
  private events: Array<{ success: boolean; code: number; time: number; method: string; at: number }> = [];
  private penaltyK = 0;
  private penaltyUntil = 0;
  private penaltyReason: string | null = null;

  constructor(meta: SeedMeta, opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
    this.host = meta.host;
    this.port = meta.port;
    this.sport = meta.sport;
    this.ws = meta.ws;
    this.sws = meta.sws;
    this.name = meta.name || meta.host;
    this.stable = meta.stable === true;
    this.peer = meta.peer === true;
    this.local = meta.local === true;
    this.addedby = meta.addedby ?? "";
    this.version = meta.version ?? null;
    this.vcode = meta.vcode ?? null;
    this.bchain = meta.bchain ?? null;
    this.allowRpc = meta.allowRpc !== false;
    this.key = meta.key ?? `${meta.host}:${meta.port}`;
  }

  export(): SeedMeta & { key: string; canuse?: boolean; height?: number } {
    return {
      host: this.host,
      port: this.port,
      sport: this.sport,
      ws: this.ws,
      sws: this.sws,
      name: this.name,
      stable: this.stable,
      peer: this.peer,
      local: this.local,
      addedby: this.addedby,
      version: this.version,
      vcode: this.vcode,
      bchain: this.bchain,
      allowRpc: this.allowRpc,
      key: this.key,
      canuse: this.canuse,
      height: this.height,
    };
  }

  recordRpcResult(rec: NodeRpcRecord): void {
    this.events.push({ ...rec, at: this.now() });
    if (this.events.length > 200) this.events.shift();

    if (!rec.success) {
      if (rec.code === 521) this.setPenalty(0.8, 220_000, "521");
      else if (rec.code === 408) this.setPenalty(0.5, 60_000, "408");
      else if (rec.code === 429) this.setPenalty(0.3, 60_000, "429");
    }
  }

  private setPenalty(k: number, ms: number, reason: string): void {
    if (this.penaltyK > 0) return;
    this.penaltyK = k;
    this.penaltyUntil = this.now() + ms;
    this.penaltyReason = reason;
  }

  private penaltyMultiplier(): number {
    if (this.penaltyK <= 0) return 1;
    if (this.now() >= this.penaltyUntil) {
      this.penaltyK = 0;
      this.penaltyReason = null;
      return 1;
    }
    return 1 - this.penaltyK;
  }

  /** HTTP-only availability (no WSS gate). */
  calcAvailability(): number {
    const recent = this.events.filter((e) => this.now() - e.at < 300_000);
    if (recent.length === 0) return this.canuse ? 0.5 : 0;
    const ok = recent.filter((e) => e.success).length;
    return ok / recent.length;
  }

  rating(): number {
    if (!this.inited || !this.canuse || !this.height) return 0;
    const availability = this.calcAvailability();
    const base = Math.max(0, this.height) * availability;
    return base * this.penaltyMultiplier();
  }

  markFromNodeInfo(info: {
    version?: string;
    versioncode?: number;
    chain?: string;
    height?: number;
    lastblock?: { height?: number };
  }): void {
    this.inited = true;
    this.initedTime = this.now();
    this.canuse = true;
    this.version = info.version ?? this.version;
    this.vcode = info.versioncode ?? this.vcode;
    this.bchain = info.chain ?? this.bchain;
    this.height = info.height ?? info.lastblock?.height ?? this.height;
  }
}
