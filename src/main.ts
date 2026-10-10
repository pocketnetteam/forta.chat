import { Buffer } from "buffer";

// Polyfill Node.js globals for browser environment
(globalThis as unknown as Record<string, unknown>).Buffer = Buffer;

// Wire the Capacitor deep-link listener synchronously, BEFORE any await.
// An invite URL delivered during cold start fires once and is gone — if Vue
// is still booting we lose it. The handler buffers URLs until the router
// registers its invite/join callbacks.
import { setupDeepLinkHandler } from "./app/providers/initializers/deep-link-handler";
setupDeepLinkHandler();

import { app } from "./app";

// This body runs only after every static import evaluated. Tell the boot
// guard in index.html that the module graph loaded, so it never swaps the app
// for its "update Android System WebView" fallback (audit W2B-01).
(window as unknown as { __fortaBootStarted?: boolean }).__fortaBootStarted = true;

app.then(app => {
  // On boot failure app is null — AppLoading stays mounted with error UI
  if (app) app.mount("#app");
});
