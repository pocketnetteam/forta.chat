import { ref } from "vue";
import { isNative } from "./platform";

/**
 * Connectivity layer.
 *
 * Two reactive surfaces:
 *   - `useConnectivity()` for Vue components — observes online + bandwidth tier.
 *   - `onConnectivityChange()` for low-level subscribers (call-service) — fires
 *     on every transport flip, including WiFi↔cellular handover. The browser's
 *     `online/offline` events are not enough on Android WebView: they only
 *     fire on full network loss, never on smooth WiFi↔cellular swap, so a
 *     call running on WiFi when the phone roams to mobile data drops without
 *     anyone notifying ICE. We subscribe to Capacitor's `@capacitor/network`
 *     plugin alongside the browser events to catch transport changes.
 */

export type ConnectionType =
  | "wifi"
  | "cellular"
  | "ethernet"
  | "unknown"
  | "none";

export interface ConnectivityChange {
  connected: boolean;
  type: ConnectionType;
  previousConnected: boolean;
  previousType: ConnectionType;
}

type ConnectivityListener = (change: ConnectivityChange) => void;

const isOnline = ref(typeof navigator !== "undefined" ? navigator.onLine : true);
const isSlow = ref(false);
const connectionType = ref<ConnectionType>("unknown");

const listeners: Set<ConnectivityListener> = new Set();

function emitChange(next: { connected: boolean; type: ConnectionType }): void {
  const prevConnected = isOnline.value;
  const prevType = connectionType.value;
  if (next.connected === prevConnected && next.type === prevType) return;

  isOnline.value = next.connected;
  connectionType.value = next.type;

  const change: ConnectivityChange = {
    connected: next.connected,
    type: next.type,
    previousConnected: prevConnected,
    previousType: prevType,
  };
  for (const cb of listeners) {
    try {
      cb(change);
    } catch (e) {
      console.error("[connectivity] listener threw:", e);
    }
  }
}

function readBrowserConnectionType(): ConnectionType {
  // navigator.connection.type isn't widely supported, but where it is
  // we use it as a fallback when Capacitor isn't available (Electron / web).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn = (navigator as any).connection;
  if (!conn) return "unknown";
  const type = (conn.type as string) ?? (conn.effectiveType as string);
  if (type === "wifi") return "wifi";
  if (type === "cellular" || /^[2345]g$/i.test(type ?? "")) return "cellular";
  if (type === "ethernet") return "ethernet";
  if (type === "none") return "none";
  return "unknown";
}

function updateOnline(): void {
  emitChange({
    connected: navigator.onLine,
    type: navigator.onLine ? readBrowserConnectionType() : "none",
  });
}

function updateConnectionTier(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn = (navigator as any).connection;
  if (conn) {
    const eff = conn.effectiveType as string;
    isSlow.value = eff === "slow-2g" || eff === "2g" || eff === "3g";
  }
}

let initialized = false;

async function initListeners(): Promise<void> {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn = (navigator as any).connection;
  if (conn) {
    updateConnectionTier();
    conn.addEventListener("change", () => {
      updateConnectionTier();
      emitChange({
        connected: navigator.onLine,
        type: navigator.onLine ? readBrowserConnectionType() : "none",
      });
    });
  }

  if (isNative) {
    try {
      // Lazy import so web/Electron builds don't bundle the native plugin.
      const { Network } = await import("@capacitor/network");
      const status = await Network.getStatus();
      emitChange({
        connected: status.connected,
        type: (status.connectionType as ConnectionType) ?? "unknown",
      });
      Network.addListener("networkStatusChange", (next) => {
        emitChange({
          connected: next.connected,
          type: (next.connectionType as ConnectionType) ?? "unknown",
        });
      });
    } catch (e) {
      console.warn(
        "[connectivity] @capacitor/network unavailable; falling back to browser events:",
        e,
      );
    }
  }
}

/**
 * Subscribe to connectivity transitions. Fires on:
 *   - online ↔ offline
 *   - WiFi ↔ cellular swaps (Android handover)
 *
 * Returns an unsubscribe function. Safe to call before init.
 */
export function onConnectivityChange(
  callback: ConnectivityListener,
): () => void {
  // Kick off initialization on first subscription so the test harness and
  // first caller don't have to wait for a Vue component to mount.
  void initListeners();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function useConnectivity() {
  void initListeners();
  return { isOnline, isSlow, connectionType };
}
