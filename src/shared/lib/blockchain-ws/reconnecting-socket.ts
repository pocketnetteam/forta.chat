/**
 * Compact WebSocket wrapper with exponential backoff + jitter reconnect.
 *
 * Designed for blockchain-ws use case: connection is best-effort, never
 * blocks the app, gracefully gives up on intentional `close()`. The chat
 * project does not bundle the legacy `vendor/reconnectingwebsocket.js`,
 * so we keep this lightweight (no external deps).
 *
 * Behaviour:
 *  - `start(getUrl)` — connect; on failure, retry with backoff.
 *  - `close()` — idempotent; cancels reconnect timer, closes socket.
 *  - `send(payload)` — try-catch wrapped (silent no-op when not OPEN).
 *  - Lifecycle events: `onOpen`, `onMessage`, `onClose`, `onError`.
 *
 * Backoff: starts at MIN_BACKOFF_MS, doubles up to MAX_BACKOFF_MS,
 * with ±50% jitter to avoid thundering-herd on outage recovery.
 */

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const JITTER_RATIO = 0.5;

export interface ReconnectingSocketHandlers {
  onOpen?: () => void;
  onMessage?: (data: string) => void;
  onClose?: () => void;
  onError?: (err: unknown) => void;
}

export interface ReconnectingSocketOptions {
  /** Async URL provider — re-evaluated on every reconnect attempt
   *  (so a proxy-list refresh between attempts is automatically picked up).
   *  Returning `null` aborts the current attempt and re-schedules a retry. */
  getUrl: () => Promise<string | null>;
  handlers: ReconnectingSocketHandlers;
  /** Inject WebSocket constructor for tests. Defaults to `globalThis.WebSocket`. */
  WebSocketCtor?: typeof WebSocket;
  /** Override backoff bounds for tests. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Override jitter (0…1). Use 0 in tests for determinism. */
  jitterRatio?: number;
}

export class ReconnectingSocket {
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  private connecting = false;
  private readonly options: Required<ReconnectingSocketOptions>;

  constructor(options: ReconnectingSocketOptions) {
    this.options = {
      getUrl: options.getUrl,
      handlers: options.handlers,
      WebSocketCtor: options.WebSocketCtor ?? (globalThis.WebSocket as typeof WebSocket),
      minBackoffMs: options.minBackoffMs ?? MIN_BACKOFF_MS,
      maxBackoffMs: options.maxBackoffMs ?? MAX_BACKOFF_MS,
      jitterRatio: options.jitterRatio ?? JITTER_RATIO,
    };
  }

  /** True once `close()` has been called — guards async callbacks from
   *  reviving a torn-down socket. */
  isClosed(): boolean {
    return this.closed;
  }

  /** True if the underlying WebSocket is in OPEN state. */
  isOpen(): boolean {
    return this.socket?.readyState === 1; // WebSocket.OPEN
  }

  /** Start the connect → reconnect loop. Idempotent: a second call while
   *  already running is a no-op. */
  start(): void {
    if (this.closed) return;
    if (this.connecting || this.isOpen()) return;
    void this.connect();
  }

  /** Send a JSON-serialisable payload. Silently dropped if not connected.
   *  Returns `true` if the buffer accepted the payload. */
  send(payload: unknown): boolean {
    if (!this.isOpen() || !this.socket) return false;
    try {
      const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
      this.socket.send(msg);
      return true;
    } catch (e) {
      this.options.handlers.onError?.(e);
      return false;
    }
  }

  /** Close the socket and cancel any pending reconnect. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelRetry();
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      try {
        sock.onopen = null;
        sock.onmessage = null;
        sock.onclose = null;
        sock.onerror = null;
        sock.close();
      } catch {
        /* ignore */
      }
    }
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    this.cancelRetry();
    const delay = this.computeBackoff();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private computeBackoff(): number {
    const base = Math.min(
      this.options.minBackoffMs * 2 ** this.attempt,
      this.options.maxBackoffMs,
    );
    const jitter = base * this.options.jitterRatio * Math.random();
    return Math.round(base + jitter);
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting) return;
    this.connecting = true;

    try {
      const url = await this.options.getUrl();
      if (this.closed) return;
      if (!url) {
        this.attempt++;
        this.scheduleRetry();
        return;
      }

      const Ctor = this.options.WebSocketCtor;
      if (!Ctor) {
        // Environment without WebSocket (SSR, broken polyfill) — silently drop.
        this.attempt++;
        this.scheduleRetry();
        return;
      }

      let sock: WebSocket;
      try {
        sock = new Ctor(url);
      } catch (e) {
        this.options.handlers.onError?.(e);
        this.attempt++;
        this.scheduleRetry();
        return;
      }

      this.socket = sock;

      sock.onopen = () => {
        if (this.closed) {
          try { sock.close(); } catch { /* ignore */ }
          return;
        }
        this.attempt = 0;
        this.options.handlers.onOpen?.();
      };

      sock.onmessage = (event: MessageEvent) => {
        if (this.closed) return;
        const raw = typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : "";
        if (raw) this.options.handlers.onMessage?.(raw);
      };

      sock.onerror = (err: Event) => {
        if (this.closed) return;
        this.options.handlers.onError?.(err);
      };

      sock.onclose = () => {
        if (this.closed) return;
        if (this.socket === sock) this.socket = null;
        this.options.handlers.onClose?.();
        this.attempt++;
        this.scheduleRetry();
      };
    } finally {
      this.connecting = false;
    }
  }
}
