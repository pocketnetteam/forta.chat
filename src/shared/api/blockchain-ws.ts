import { PROXY_NODES } from "@/shared/config";
import type {
  WsTransactionMessage,
  WsRegisteredMessage,
  MissedInfoBlockItem,
  MissedInfoEventItem,
} from "./types";

export type BlockchainWsEvent =
  | "block"
  | "transaction"
  | "social"
  | "registered"
  | "tick"
  | "message";

type EventHandler = (data: any) => void;

export interface BlockchainWsCredentials {
  address: string;
  /** The full signature object returned by POCKETNETINSTANCE.user.signature() */
  signature: unknown;
  device?: string;
  block?: number;
  node?: string | null;
}

/**
 * Callback for fetching missed events via `getmissedinfo` RPC.
 * Injected by AppInitializer so the service stays framework-agnostic.
 */
export type GetMissedInfoFn = (
  address: string,
  fromBlock: number,
  count: number
) => Promise<unknown[] | null>;

const LS_LAST_BLOCK_KEY = "forta_ws_last_block";
const MISSED_INFO_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * Singleton WebSocket service for PocketNet blockchain events.
 *
 * Purely additive acceleration layer — the app works identically without it.
 * All event handlers are wrapped in try/catch so a bad WS message never crashes the app.
 */
class BlockchainWsService {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private credentials: BlockchainWsCredentials | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private _isConnected = false;
  private _isRegistered = false;
  private nodeIndex = 0;

  private lastBlockHeight = 0;
  private lastBlockTime = 0;
  private loadingMissed = false;
  private getMissedInfoFn: GetMissedInfoFn | null = null;
  private visibilityHandler: (() => void) | null = null;

  get isConnected() {
    return this._isConnected;
  }

  get isRegistered() {
    return this._isRegistered;
  }

  /** Set the RPC callback for getmissedinfo. Called by AppInitializer. */
  setGetMissedInfoFn(fn: GetMissedInfoFn) {
    this.getMissedInfoFn = fn;
  }

  connect(credentials: BlockchainWsCredentials) {
    this.destroyed = false;
    this.credentials = credentials;
    this.lastBlockHeight = this.loadLastBlock();
    this.doConnect();
    this.attachVisibilityListener();
  }

  disconnect() {
    this.destroyed = true;
    this.credentials = null;
    this._isConnected = false;
    this._isRegistered = false;
    this.detachVisibilityListener();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  on(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  off(event: string, handler: EventHandler) {
    this.handlers.get(event)?.delete(handler);
  }

  // --- Private ---

  private emit(event: string, data: unknown) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (e) {
        console.warn("[BlockchainWs] Handler error for event", event, e);
      }
    }
  }

  private getWsUrl(): string {
    const node = PROXY_NODES[this.nodeIndex % PROXY_NODES.length];
    return `wss://${node.host}:${node.wss}`;
  }

  private doConnect() {
    if (this.destroyed || !this.credentials) return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    const url = this.getWsUrl();
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.warn("[BlockchainWs] Failed to create WebSocket:", e);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._isConnected = true;
      this.reconnectAttempts = 0;
      this.sendHandshake();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);
        this.handleMessage(data);
      } catch {
        // Non-JSON message — ignore
      }
    };

    this.ws.onclose = () => {
      this._isConnected = false;
      this._isRegistered = false;
      if (!this.destroyed) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror, which handles reconnect
      try { this.ws?.close(); } catch { /* ignore */ }
    };
  }

  private sendHandshake() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.credentials) return;
    const msg = {
      signature: this.credentials.signature,
      address: this.credentials.address,
      device: this.credentials.device || "web",
      block: this.credentials.block || this.lastBlockHeight || 0,
      node: this.credentials.node || null,
    };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      console.warn("[BlockchainWs] Handshake send error:", e);
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.nodeIndex++;
      this.doConnect();
    }, delay);
  }

  private handleMessage(data: Record<string, unknown>) {
    // Dispatch raw message for any listener that wants everything
    this.emit("message", data);

    const type = data.type as string | undefined;
    const msg = data.msg as string | undefined;
    const mesType = data.mesType as string | undefined;

    // Proxy tick
    if (type === "proxy-message-tick") {
      this.emit("tick", data);
      return;
    }

    // Proxy settings changed — ignore for now
    if (type === "proxy-settings-changed") return;

    // Registration response
    if (msg === "registered" || msg === "registererror" || msg === "notauthorized") {
      this._isRegistered = msg === "registered";
      this.emit("registered", data as unknown as WsRegisteredMessage);
      if (this._isRegistered) {
        this.fetchMissedInfo();
      }
      return;
    }

    // New block
    if (msg === "new block") {
      const height = (data.height as number) ?? (data.block as number) ?? 0;
      if (height > 0 && height > this.lastBlockHeight) {
        const previousHeight = this.lastBlockHeight;
        this.lastBlockHeight = height;
        this.lastBlockTime = Date.now();
        this.saveLastBlock(height);
        this.emit("block", {
          ...data,
          height,
          previousHeight,
          difference: previousHeight > 0 ? height - previousHeight : 1,
        });
      }
      return;
    }

    // Transaction (has msg === "transaction" and may also have mesType)
    if (msg === "transaction") {
      // satolist.js: if msg === 'transaction' && mesType, move mesType to type and delete mesType
      if (mesType) {
        (data as any).type = mesType;
        delete data.mesType;
      }
      this.emit("transaction", data as unknown as WsTransactionMessage);
      return;
    }

    // Social events (mesType without msg, or msg === "event")
    if (mesType) {
      this.emit("social", data);
      this.emit(`social:${mesType}`, data);
      return;
    }

    // newblocks (from getmissedinfo catch-up, processed separately)
    if (msg === "newblocks") {
      const height = (data.block as number) ?? (data.height as number) ?? 0;
      if (height > 0 && height > this.lastBlockHeight) {
        const previousHeight = this.lastBlockHeight;
        this.lastBlockHeight = height;
        this.lastBlockTime = Date.now();
        this.saveLastBlock(height);
        this.emit("block", {
          ...data,
          height,
          previousHeight,
          difference: previousHeight > 0 ? height - previousHeight : 1,
        });
      }
      return;
    }
  }

  // --- getmissedinfo catch-up ---

  async fetchMissedInfo() {
    if (this.loadingMissed || !this.getMissedInfoFn || !this.credentials?.address) return;
    const fromBlock = this.lastBlockHeight || 0;
    if (!fromBlock) return;

    this.loadingMissed = true;
    try {
      const result = await this.getMissedInfoFn(this.credentials.address, fromBlock, 30);
      if (!result || !Array.isArray(result) || result.length === 0) {
        this.loadingMissed = false;
        return;
      }

      // First element = block info
      const blockInfo = result[0] as MissedInfoBlockItem;
      if (blockInfo) {
        blockInfo.msg = "newblocks";
        this.handleMessage(blockInfo as unknown as Record<string, unknown>);
      }

      // Remaining = missed notification events
      const notifications = (result.slice(1) as MissedInfoEventItem[])
        .sort((a, b) => (b.nblock ?? 0) - (a.nblock ?? 0));

      for (const event of notifications) {
        this.handleMessage(event as unknown as Record<string, unknown>);
      }
    } catch (e) {
      console.warn("[BlockchainWs] fetchMissedInfo error:", e);
    } finally {
      this.loadingMissed = false;
    }
  }

  /** Called on tab focus to catch up on potentially missed events */
  private onVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    if (!this._isRegistered || !this.credentials) return;
    // Skip if last block was recent (WS is working fine)
    if (this.lastBlockTime && Date.now() - this.lastBlockTime < MISSED_INFO_COOLDOWN_MS) return;
    this.fetchMissedInfo();
  };

  private attachVisibilityListener() {
    if (typeof document === "undefined") return;
    this.detachVisibilityListener();
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityHandler = this.onVisibilityChange;
  }

  private detachVisibilityListener() {
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  // --- localStorage persistence for lastProcessedBlock ---

  private loadLastBlock(): number {
    try {
      const val = localStorage.getItem(LS_LAST_BLOCK_KEY);
      return val ? parseInt(val, 10) || 0 : 0;
    } catch {
      return 0;
    }
  }

  private saveLastBlock(height: number) {
    try {
      localStorage.setItem(LS_LAST_BLOCK_KEY, String(height));
    } catch { /* ignore */ }
  }
}

export const blockchainWs = new BlockchainWsService();
