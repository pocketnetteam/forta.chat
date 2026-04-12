export interface ProxyNode {
  host: string;
  port: number;
  wss: number;
}

export interface ApiResponse<T = unknown> {
  data: T | null;
  error: string | null;
}

// --- Blockchain WebSocket message types ---

/** Raw WS message from proxy: new block mined */
export interface WsBlockMessage {
  msg: "new block";
  height: number;
  hash?: string;
  block?: number;
  time?: number;
  node?: string;
}

/** Raw WS message from proxy: transaction affecting our address */
export interface WsTransactionMessage {
  msg: "transaction";
  addr: string;
  txid: string;
  amount: string;
  nout: string;
  time: number;
  node?: string;
  mesType?: string;
  height?: number;
}

/** Raw WS message from proxy: social event (comment, upvote, subscribe, etc.) */
export interface WsSocialEventMessage {
  msg: "event";
  mesType: string;
  addr?: string;
  addrFrom?: string;
  txid?: string;
  time?: number;
  nblock?: number;
  node?: string;
  [key: string]: unknown;
}

/** Proxy registration handshake response */
export interface WsRegisteredMessage {
  msg: "registered" | "registererror" | "notauthorized";
  addr?: string;
  node?: { key: string };
}

/** Proxy tick message */
export interface WsTickMessage {
  type: "proxy-message-tick";
  data: { state: unknown; settings: unknown };
}

/** Catch-up response from getmissedinfo RPC.
 *  d[0] = block info (we tag it with msg: 'newblocks'),
 *  d[1..n] = missed notification events */
export interface MissedInfoBlockItem {
  block?: number;
  height?: number;
  contentsLang?: Record<string, unknown>;
  contentsSubscribes?: Record<string, unknown>;
  msg?: string;
}

export interface MissedInfoEventItem {
  txid?: string;
  msg?: string;
  mesType?: string;
  addr?: string;
  addrFrom?: string;
  nblock?: number;
  time?: number;
  [key: string]: unknown;
}

/** Union of all WS messages the service can receive */
export type WsMessage =
  | WsBlockMessage
  | WsTransactionMessage
  | WsSocialEventMessage
  | WsRegisteredMessage
  | WsTickMessage
  | Record<string, unknown>;
