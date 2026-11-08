import { PROXY_NODES } from "@/shared/config";
import { useLocalStorage } from "@/shared/lib/browser";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { isLocalNodeProxyAvailable } from "../lib/is-local-node-available";
import type {
  ProxyGateway,
  ProxyHealth,
  ProxyListItem,
  ProxyMode,
  ProxyPersistedState,
} from "./types";

const NAMESPACE = "pocketnet-proxy";
const STORAGE_KEY = "pocketnet_proxy_v1";

const AUTO_ID = "auto";
export const LOCAL_PROXY_ID = "localnodes";

function gatewayId(host: string, port: number): string {
  return `${host}:${port}`;
}

function buildGateways(
  nodes: readonly { host: string; port: number; wss?: number }[] = PROXY_NODES,
): ProxyGateway[] {
  return nodes.map((n) => ({
    id: gatewayId(n.host, n.port),
    host: n.host,
    port: n.port,
    wss: n.wss,
    label: n.host,
  }));
}

function parsePersisted(raw: unknown): ProxyPersistedState {
  if (!raw || typeof raw !== "object") {
    return { mode: "auto", pinnedGatewayId: null };
  }
  const obj = raw as Record<string, unknown>;
  const mode: ProxyMode =
    obj.mode === "gateway" || obj.mode === "local" || obj.mode === "auto"
      ? obj.mode
      : "auto";
  const pinned =
    typeof obj.pinnedGatewayId === "string" && obj.pinnedGatewayId.length > 0
      ? obj.pinnedGatewayId
      : null;
  return { mode, pinnedGatewayId: pinned };
}

export const useProxyStore = defineStore(NAMESPACE, () => {
  const { setLSValue, value: lsValue } = useLocalStorage<ProxyPersistedState>(
    STORAGE_KEY,
    { mode: "auto", pinnedGatewayId: null },
  );

  const initial = parsePersisted(lsValue);
  const mode = ref<ProxyMode>(initial.mode);
  const pinnedGatewayId = ref<string | null>(initial.pinnedGatewayId);
  const health = ref<ProxyHealth>("idle");
  const healthDetail = ref("");
  const gateways = ref<ProxyGateway[]>(buildGateways());
  /** Boot offer: remotes dead, Local alive — ask to switch (donor pdirectdialog). */
  const offerLocalPending = ref(false);
  /** Once per app session after show/dismiss/accept — no spam. */
  let localOfferShownThisSession = false;

  const localAvailable = computed(() => isLocalNodeProxyAvailable());

  const currentGateway = computed(() => {
    const pin = pinnedGatewayId.value;
    if (pin) {
      const found = gateways.value.find((g) => g.id === pin);
      if (found) return found;
    }
    return gateways.value[0] ?? null;
  });

  const currentLabel = computed(() => {
    if (mode.value === "local") return "Local Node Proxy";
    if (mode.value === "gateway" && currentGateway.value) {
      return currentGateway.value.label;
    }
    if (mode.value === "auto") {
      const g = currentGateway.value;
      return g ? `Auto · ${g.label}` : "Auto";
    }
    return "Auto";
  });

  const currentSelectionId = computed(() => {
    if (mode.value === "local") return LOCAL_PROXY_ID;
    if (mode.value === "gateway" && pinnedGatewayId.value) {
      return pinnedGatewayId.value;
    }
    return AUTO_ID;
  });

  const listItems = computed((): ProxyListItem[] => {
    const items: ProxyListItem[] = [
      {
        id: AUTO_ID,
        kind: "auto",
        label: "Auto",
        detail: "Failover across gateways; Local as last resort",
        available: true,
      },
    ];
    for (const g of gateways.value) {
      items.push({
        id: g.id,
        kind: "gateway",
        label: g.label,
        detail: `https://${g.host}:${g.port}`,
        available: true,
      });
    }
    items.push({
      id: LOCAL_PROXY_ID,
      kind: "local",
      label: "Local Node Proxy",
      detail: localAvailable.value
        ? "Direct blockchain node RPC"
        : "Unavailable in this browser",
      available: localAvailable.value,
    });
    return items;
  });

  function persist(): void {
    setLSValue({
      mode: mode.value,
      pinnedGatewayId: pinnedGatewayId.value,
    });
  }

  /** Configure gateway list (from PocketnetInstance.listofproxies). */
  function setGateways(
    nodes: readonly { host: string; port: number; wss?: number }[],
  ): void {
    gateways.value = buildGateways(nodes);
    if (
      pinnedGatewayId.value &&
      !gateways.value.some((g) => g.id === pinnedGatewayId.value)
    ) {
      pinnedGatewayId.value = gateways.value[0]?.id ?? null;
      persist();
    }
  }

  function select(id: string): void {
    if (id === AUTO_ID) {
      mode.value = "auto";
      persist();
      return;
    }
    if (id === LOCAL_PROXY_ID) {
      if (!localAvailable.value) return;
      mode.value = "local";
      persist();
      return;
    }
    const gateway = gateways.value.find((g) => g.id === id);
    if (!gateway) return;
    mode.value = "gateway";
    pinnedGatewayId.value = gateway.id;
    persist();
  }

  /** Remember preferred gateway for Auto ordering without leaving Auto mode. */
  function preferGateway(id: string): void {
    if (!gateways.value.some((g) => g.id === id)) return;
    pinnedGatewayId.value = id;
    persist();
  }

  function setHealth(next: ProxyHealth, detail = ""): void {
    health.value = next;
    healthDetail.value = detail;
  }

  /**
   * Ordered gateway base URLs for failover. When a gateway is pinned (gateway
   * mode or preferred in auto), that host is first.
   */
  function gatewayBaseUrls(): string[] {
    const urls = gateways.value.map((g) => `https://${g.host}:${g.port}`);
    if (urls.length === 0) return ["https://1.pocketnet.app:8899"];
    const pin = pinnedGatewayId.value;
    if (!pin) return urls;
    const preferred = `https://${pin}`;
    // pin is `host:port` — match against full base without scheme mismatch
    const idx = gateways.value.findIndex((g) => g.id === pin);
    if (idx <= 0) return urls;
    return [...urls.slice(idx), ...urls.slice(0, idx)];
  }

  /** True when callPocketnetRpc should use Local Node Proxy first. */
  function shouldUseLocal(): boolean {
    return mode.value === "local" && localAvailable.value;
  }

  /** True when Auto may fall back to Local after remotes fail. */
  function allowLocalFallback(): boolean {
    return mode.value === "auto" && localAvailable.value;
  }

  function canOfferLocalThisSession(): boolean {
    return !localOfferShownThisSession;
  }

  function showLocalOffer(): void {
    localOfferShownThisSession = true;
    offerLocalPending.value = true;
  }

  function dismissLocalOffer(): void {
    offerLocalPending.value = false;
    localOfferShownThisSession = true;
  }

  function acceptLocalOffer(): void {
    offerLocalPending.value = false;
    localOfferShownThisSession = true;
    select(LOCAL_PROXY_ID);
  }

  /** Test helper — reset session offer gate. */
  function resetLocalOfferSession(): void {
    localOfferShownThisSession = false;
    offerLocalPending.value = false;
  }

  return {
    mode,
    pinnedGatewayId,
    health,
    healthDetail,
    gateways,
    offerLocalPending,
    localAvailable,
    currentGateway,
    currentLabel,
    currentSelectionId,
    listItems,
    setGateways,
    select,
    preferGateway,
    setHealth,
    gatewayBaseUrls,
    shouldUseLocal,
    allowLocalFallback,
    canOfferLocalThisSession,
    showLocalOffer,
    dismissLocalOffer,
    acceptLocalOffer,
    resetLocalOfferSession,
  };
});
