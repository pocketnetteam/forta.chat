/**
 * Public types for the blockchain WebSocket service.
 *
 * The service mirrors the Bastyon `WSn` class from `js/satolist.js`
 * (see `docs/websocket-flow.md` reference) but only routes the events
 * relevant to the chat app: blocks, transactions, and `event/userInfo`.
 */

/** Signature payload returned by `window.POCKETNETINSTANCE.user.signature()`.
 *  Same shape used by Bastyon for ECDSA-based WS authentication. */
export interface SignaturePayload {
  nonce: string;
  signature: string;
  pubkey: string;
  address: string;
  v: number;
}

/** Registration message sent to Proxy16 right after `onopen`.
 *  Proxy16 treats messages without `action` as `registration` (see proxy16/server/wss.js). */
export interface RegistrationMessage {
  signature: SignaturePayload;
  address: string;
  device: string;
  block: number;
  node: string | null;
}

/** Block summary payload (from `new block` real-time event or from the
 *  first element of `getmissedinfo` response). */
export interface BlockEventPayload {
  height: number;
  time?: number;
  /** Difference between current best block and this event (used by
   *  actions.js to bulk-increment `confirmations` of all UTXOs). */
  difference?: number;
}

/** Transaction event payload (incoming PKOIN to a watched address). */
export interface TransactionEventPayload {
  txid: string;
  addr?: string;
  time?: number;
  amount?: number;
  nout?: number;
  height?: number;
  node?: string;
}

/** Generic `event` payload — discriminator is `mesType` (e.g. `userInfo`). */
export interface UserInfoEventPayload {
  mesType: "userInfo";
  addrFrom: string;
  txid?: string;
  time?: number;
}

/** Handlers wired by callers (auth-store). All optional — service ignores
 *  unhandled types. Handlers MUST be best-effort: throwing is allowed and
 *  swallowed by the service. */
export interface BlockchainWsHandlers {
  onBlock?: (data: BlockEventPayload) => void;
  onTransaction?: (data: TransactionEventPayload) => void;
  onUserInfo?: (data: UserInfoEventPayload) => void;
}

/** RPC surface required by the WS service. Matches a subset of the
 *  globally-loaded `Api` class (see `src/global.d.ts`).
 *
 *  We mirror the `api.get.currentwss()` nesting so an `Api` instance is
 *  structurally assignable without an extra adapter at call sites. */
export interface BlockchainWsRpcAdapter {
  /** Generic RPC pass-through (used for `getmissedinfo`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc<T = any>(method: string, params?: unknown[], options?: unknown): Promise<T>;
  get: {
    /** Get current proxy WSS URL. Returned shape depends on direct vs network proxy. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    currentwss(): Promise<any>;
  };
}

/** Configuration passed to `blockchainWs.start({...})`. */
export interface BlockchainWsStartOptions {
  /** Bastyon address of the currently logged-in user. */
  address: string;
  /** Stable device id (used by proxy for FCM push routing — irrelevant for chat
   *  but required by the registration protocol). Take from `PocketnetInstance.options.device`. */
  deviceId: string;
  /** Lazy getter for the current ECDSA signature payload. The service calls
   *  this every time it sends a `registration` message, so the signature is
   *  always fresh. Returning `null` aborts `start()` with a warning. */
  getSignature: () => SignaturePayload | null | undefined;
  /** Lazy getter for the loaded SDK Api instance. Returning `null` aborts
   *  `start()` with a warning (degrades to existing polling). */
  getApi: () => BlockchainWsRpcAdapter | null;
  /** Lazy getter for the last-known blockchain block height. Used for the
   *  initial `registration.block` field and as a starting point for
   *  `getmissedinfo`. */
  getLastKnownBlock: () => number;
  handlers: BlockchainWsHandlers;
}

/** Internal: parsed inbound message after JSON decode. The proxy may emit
 *  control messages (`proxy-message-tick`, `changenode`,
 *  `proxy-settings-changed`) — they are ignored here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InboundMessage = Record<string, any>;
