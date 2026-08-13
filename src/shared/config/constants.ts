export const APP_NAME = "forta-chat";

/**
 * Public URL of the app for shareable links.
 * On Capacitor (Android/iOS) window.location.origin returns localhost,
 * so we always use this constant for links shared externally.
 */
export const APP_PUBLIC_URL = "https://forta.chat";

export const PROXY_NODES = [
  { host: "1.pocketnet.app", port: 8899, wss: 8099 },
  { host: "2.pocketnet.app", port: 8899, wss: 8099 }
];

export const RTC_WS_URL = "wss://pocketnet.app:9090";
export const RTC_HTTP_URL = "https://pocketnet.app:9091";
export const MATRIX_SERVER = "matrix.pocketnet.app";

/** Fallback media/homeserver mirrors for `MATRIX_SERVER`. Mirrors bastyon-chat's
 *  `matrixMirrors` (pocketnet `Bastyon.json` → `matrix.2.pocketnet.app`) and its
 *  `pingServers` live-server pick. Media downloads alternate primary↔mirror across
 *  retry attempts, so a throttled or region-blocked primary media-repo doesn't
 *  leave images stuck in an eternal spinner (WEE-90 H2). */
export const MATRIX_MIRRORS = ["matrix.2.pocketnet.app"];
