/**
 * Blockchain WebSocket service — best-effort client for Bastyon's
 * Proxy16 → Pocketnet Node WS bridge.
 *
 * Behavioural contract (per `docs/websocket-flow.md`):
 *  1. After login, `start()` resolves the proxy WSS URL via `api.get.currentwss()`,
 *     opens a socket and sends a `registration` message signed with the user's key.
 *  2. The proxy answers `{msg:"registered"}` and starts streaming events.
 *  3. Live events go through `dispatch()`; same dispatcher is reused for the
 *     RPC `getmissedinfo` catch-up (initial + on focus return).
 *  4. The service is OPTIONAL: any failure (no signature, dead proxy, malformed
 *     payload) is logged with `[blockchain-ws]` prefix but never throws.
 *
 * The service ONLY supports the event subset used by the chat:
 *  - `new block` / `newblocks` → `onBlock`
 *  - `transaction`             → `onTransaction`
 *  - `event` with `mesType=userInfo` → `onUserInfo`
 *
 * Other event types (cScore, comment, reshare, …) are silently ignored.
 */

import {
  ReconnectingSocket,
  type ReconnectingSocketHandlers,
} from "./reconnecting-socket";
import {
  canRunGetMissed,
  fetchGetMissed,
  markGetMissedRan,
} from "./getmissed";
import type {
  BlockchainWsHandlers,
  BlockchainWsStartOptions,
  InboundMessage,
  RegistrationMessage,
} from "./types";

/** Window of in-memory deduplication for live + catch-up events.
 *  10k entries is plenty for a single session and roughly bounded memory. */
const DEDUPE_MAX_SIZE = 10_000;

/** Foreground-return throttle (matches legacy 2-minute guard). */
const FOCUS_DEBOUNCE_MS = 1_000;

export class BlockchainWsService {
  private socket: ReconnectingSocket | null = null;
  private options: BlockchainWsStartOptions | null = null;
  private dedupe = new Set<string>();
  private dedupeOrder: string[] = [];
  private lastBlockHeight = 0;
  private started = false;
  private destroyed = false;

  private visibilityHandler: (() => void) | null = null;
  private appStateHandle: { remove: () => Promise<void> } | null = null;
  private focusDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Inject WebSocket constructor for tests. Real code uses `globalThis.WebSocket`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _WebSocketCtor: any;
  /** Suppress focus listener wiring for tests / Node. */
  private readonly _attachFocusListener: boolean;

  constructor(opts?: {
    WebSocketCtor?: typeof WebSocket;
    attachFocusListener?: boolean;
  }) {
    this._WebSocketCtor = opts?.WebSocketCtor;
    this._attachFocusListener = opts?.attachFocusListener ?? true;
  }

  /** Kick off the WS lifecycle. Idempotent: a second call with the same
   *  address is a no-op; with a different address triggers a `stop()` first. */
  start(options: BlockchainWsStartOptions): void {
    if (this.destroyed) return;

    if (this.started && this.options?.address === options.address) {
      return;
    }

    if (this.started) {
      this.stop();
    }

    this.options = options;
    this.started = true;
    this.dedupe.clear();
    this.dedupeOrder = [];
    this.lastBlockHeight = options.getLastKnownBlock() || 0;

    const api = options.getApi();
    if (!api) {
      console.warn("[blockchain-ws] start aborted: SDK Api not ready");
      return;
    }
    if (!options.getSignature()) {
      console.warn("[blockchain-ws] start aborted: signature not available");
      return;
    }

    const handlers: ReconnectingSocketHandlers = {
      onOpen: () => this.handleOpen(),
      onMessage: (raw) => this.handleMessage(raw),
      onClose: () => {
        console.info("[blockchain-ws] disconnected");
      },
      onError: (err) => {
        console.warn("[blockchain-ws] socket error:", err);
      },
    };

    this.socket = new ReconnectingSocket({
      getUrl: () => this.resolveUrl(),
      handlers,
      WebSocketCtor: this._WebSocketCtor,
    });
    this.socket.start();

    if (this._attachFocusListener) {
      this.attachFocusListener();
    }
  }

  /** Tear everything down. Safe to call repeatedly and from anywhere. */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.focusDebounceTimer) {
      clearTimeout(this.focusDebounceTimer);
      this.focusDebounceTimer = null;
    }

    this.detachFocusListener();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.options = null;
    this.dedupe.clear();
    this.dedupeOrder = [];
  }

  /** True when the underlying socket is currently OPEN. Useful for diagnostics. */
  isConnected(): boolean {
    return this.socket?.isOpen() ?? false;
  }

  /** Permanently disable the service (called once at app teardown / tests). */
  destroy(): void {
    this.stop();
    this.destroyed = true;
  }

  /** Manually trigger a `getmissedinfo` catch-up. Throttled internally. */
  async runCatchUp(initial = false): Promise<void> {
    if (!this.started || !this.options) return;
    if (!canRunGetMissed(initial)) return;

    const api = this.options.getApi();
    if (!api) return;

    const fromBlock = this.lastBlockHeight || this.options.getLastKnownBlock() || 0;
    if (!fromBlock) return;

    let result;
    try {
      result = await fetchGetMissed({
        api,
        address: this.options.address,
        fromBlock,
      });
    } catch (e) {
      console.warn("[blockchain-ws] getmissedinfo failed:", e);
      return;
    }

    markGetMissedRan();

    if (!result) return;

    // Replay through the same dispatcher to share dedupe + handler routing.
    this.dispatch(result.block);
    for (const item of result.notifications) {
      this.dispatch(item);
    }
  }

  private async resolveUrl(): Promise<string | null> {
    if (!this.started || !this.options) return null;
    const api = this.options.getApi();
    if (!api) return null;

    let wssInfo: unknown;
    try {
      wssInfo = await api.get.currentwss();
    } catch (e) {
      console.warn("[blockchain-ws] currentwss() failed:", e);
      return null;
    }

    if (!wssInfo || typeof wssInfo !== "object") return null;
    const obj = wssInfo as Record<string, unknown>;

    // `dummy` mode is for the in-process direct proxy used by Bastyon Electron.
    // The chat app does not run that proxy, so we silently skip it.
    if ("dummy" in obj && obj.dummy) {
      console.info("[blockchain-ws] proxy is in direct/dummy mode — skipping WS");
      return null;
    }

    const url = obj.url;
    if (typeof url !== "string" || !url) return null;
    return url;
  }

  private handleOpen(): void {
    if (!this.options) return;
    const sig = this.options.getSignature();
    if (!sig) {
      console.warn("[blockchain-ws] open: signature unavailable, closing");
      this.socket?.close();
      this.socket = null;
      return;
    }

    const message: RegistrationMessage = {
      signature: sig,
      address: this.options.address,
      device: this.options.deviceId,
      block: this.options.getLastKnownBlock() || 0,
      node: null,
    };

    const sent = this.socket?.send(message);
    if (!sent) {
      console.warn("[blockchain-ws] failed to send registration");
      return;
    }

    console.info("[blockchain-ws] connected and registered for", this.options.address);

    // Catch up missed events from the offline window. fire-and-forget.
    void this.runCatchUp(true);
  }

  private handleMessage(raw: string): void {
    let parsed: InboundMessage;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn("[blockchain-ws] invalid JSON payload:", e);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    // Skip proxy-internal control messages — they don't affect chat state.
    const type = (parsed as { type?: string }).type;
    if (type === "proxy-message-tick" || type === "changenode" || type === "proxy-settings-changed") {
      return;
    }

    this.dispatch(parsed);
  }

  /** Single entry-point for both live + catch-up events. */
  dispatch(data: InboundMessage): void {
    if (!data || !this.started || !this.options) return;

    // The legacy code maps raw transactions (with vin/vout) to msg=transaction.
    if (!data.msg && !data.mesType && data.vin && data.vout) {
      data.msg = "transaction";
    }

    const txid = typeof data.txid === "string" ? (data.txid as string) : null;
    if (txid) {
      if (this.dedupe.has(txid)) return;
      this.dedupe.add(txid);
      this.dedupeOrder.push(txid);
      if (this.dedupeOrder.length > DEDUPE_MAX_SIZE) {
        const drop = this.dedupeOrder.shift();
        if (drop) this.dedupe.delete(drop);
      }
    }

    const handlers = this.options.handlers;

    try {
      if (data.msg === "new block" || data.msg === "newblocks") {
        const heightRaw = data.height ?? data.block ?? 0;
        const height = Number(heightRaw) || 0;
        if (height > 0 && height > this.lastBlockHeight) {
          this.lastBlockHeight = height;
        }
        const time = typeof data.time === "number" ? (data.time as number) : undefined;
        handlers.onBlock?.({ height, time });
        return;
      }

      if (data.msg === "transaction") {
        const t = data as Record<string, unknown>;
        handlers.onTransaction?.({
          txid: (t.txid as string) ?? "",
          addr: (t.addr as string) ?? undefined,
          time: typeof t.time === "number" ? (t.time as number) : undefined,
          amount: typeof t.amount === "number" ? (t.amount as number) : undefined,
          nout: typeof t.nout === "number" ? (t.nout as number) : undefined,
          height: typeof t.height === "number" ? (t.height as number) : undefined,
          node: typeof t.node === "string" ? (t.node as string) : undefined,
        });
        return;
      }

      if (data.msg === "event" && data.mesType === "userInfo") {
        const addrFrom = typeof data.addrFrom === "string" ? (data.addrFrom as string) : "";
        if (!addrFrom) return;
        handlers.onUserInfo?.({
          mesType: "userInfo",
          addrFrom,
          txid: typeof data.txid === "string" ? (data.txid as string) : undefined,
          time: typeof data.time === "number" ? (data.time as number) : undefined,
        });
        return;
      }

      // `registered` / `connectionfailed` / others — no chat-side action needed.
    } catch (e) {
      console.warn("[blockchain-ws] handler threw:", e);
    }
  }

  /** Wire focus listeners that retrigger `runCatchUp()` when the user comes
   *  back to the app. Both web (visibilitychange) and native (Capacitor App). */
  private attachFocusListener(): void {
    if (typeof document !== "undefined") {
      this.visibilityHandler = () => {
        if (document.hidden) return;
        this.scheduleCatchUp();
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
    // Capacitor's appStateChange fires before document.visibilitychange on
    // Android in some scenarios — wire both for resilience.
    void this.attachCapacitorAppListener();
  }

  private async attachCapacitorAppListener(): Promise<void> {
    try {
      const { App: CapApp } = await import("@capacitor/app");
      if (!this.started) return;
      const handle = await CapApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) this.scheduleCatchUp();
      });
      // Re-check `started` because the dynamic import is async — service may
      // have been stopped while we were waiting. If so, drop the listener.
      if (!this.started) {
        try { await handle.remove(); } catch { /* ignore */ }
        return;
      }
      this.appStateHandle = handle;
    } catch {
      // @capacitor/app is unavailable on web — silently skip.
    }
  }

  private detachFocusListener(): void {
    if (typeof document !== "undefined" && this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    this.visibilityHandler = null;

    if (this.appStateHandle) {
      const handle = this.appStateHandle;
      this.appStateHandle = null;
      handle.remove().catch(() => { /* ignore */ });
    }
  }

  private scheduleCatchUp(): void {
    if (!this.started) return;
    if (this.focusDebounceTimer) return;
    this.focusDebounceTimer = setTimeout(() => {
      this.focusDebounceTimer = null;
      void this.runCatchUp(false);
    }, FOCUS_DEBOUNCE_MS);
  }
}

/** Process-wide singleton — one chat session, one socket. */
export const blockchainWs = new BlockchainWsService();

/** Test-only factory: a fresh, isolated instance. */
export function createBlockchainWsServiceForTesting(opts?: {
  WebSocketCtor?: typeof WebSocket;
  attachFocusListener?: boolean;
}): BlockchainWsService {
  return new BlockchainWsService(opts);
}
