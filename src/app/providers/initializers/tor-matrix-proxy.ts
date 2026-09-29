import { watch, type WatchStopHandle } from "vue";

/**
 * Keeps the Matrix client's Tor proxy URL equal to the Tor service's, for the
 * life of the app. It used to be applied once, and only when Tor was on at
 * start: switching Tor on in settings never told the client (it kept probing
 * mirrors directly), and switching it off left the client believing it ran
 * through a proxy that no longer existed (mirror failover off until restart).
 *
 * `getUrl` must read reactive state (torService.matrixBaseUrl reads its refs).
 */
export function syncMatrixTorProxy(
  getUrl: () => string,
  setUrl: (url: string) => void,
): WatchStopHandle {
  return watch(getUrl, (url, previous) => {
    if (url === previous) return;
    setUrl(url);
    console.info(url ? "[TOR] Matrix proxy applied" : "[TOR] Matrix proxy cleared");
  }, { immediate: true });
}
