export interface SeedMeta {
  host: string;
  port: number;
  sport: number;
  ws: number;
  sws: number;
  name: string;
  stable?: boolean;
  peer?: boolean;
  local?: boolean;
  addedby?: string;
  version?: string | null;
  vcode?: number | null;
  bchain?: string | null;
  allowRpc?: boolean;
  key?: string;
}

export interface NodeRpcRecord {
  success: boolean;
  code: number;
  time: number;
  method: string;
}

export interface TransportRequest {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  timeout?: number;
  headers?: Record<string, string>;
}

export interface TransportResponse {
  status: number;
  body: unknown;
}

export type TransportError = {
  code: number;
  message: string;
};
