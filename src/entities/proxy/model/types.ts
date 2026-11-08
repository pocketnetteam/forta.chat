/** How Forta routes Pocketnet blockchain RPC. */
export type ProxyMode = "auto" | "gateway" | "local";

/** Health of the currently selected Pocketnet transport. */
export type ProxyHealth = "idle" | "checking" | "ok" | "error";

export interface ProxyGateway {
  id: string;
  host: string;
  port: number;
  wss?: number;
  /** Display label (usually the host). */
  label: string;
}

export interface ProxyListItem {
  id: string;
  kind: "auto" | "gateway" | "local";
  label: string;
  /** Optional host shown under the label. */
  detail?: string;
  /** False when Local is unavailable on this platform (e.g. production web). */
  available: boolean;
}

export interface ProxyPersistedState {
  mode: ProxyMode;
  /** Sticky gateway id when mode is gateway, or preferred start in auto. */
  pinnedGatewayId: string | null;
}
