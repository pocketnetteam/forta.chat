export const APP_NAME = "forta-chat";

/**
 * Public URL of the app for shareable links.
 * On Capacitor (Android/iOS) window.location.origin returns localhost,
 * so we always use this constant for links shared externally.
 */
export const APP_PUBLIC_URL = "https://forta.chat";

export const PROXY_NODES = [
  { host: "1.pocketnet.app", port: 8899, wss: 8099 },
  { host: "2.pocketnet.app", port: 8899, wss: 8099 },
  { host: "3.pocketnet.app", port: 8899, wss: 8099 },
  { host: "6.pocketnet.app", port: 8899, wss: 8099 }
];

export const RTC_WS_URL = "wss://pocketnet.app:9090";
export const RTC_HTTP_URL = "https://pocketnet.app:9091";
export const MATRIX_SERVER = "matrix.pocketnet.app";
