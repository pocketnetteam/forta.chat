import type { App } from "vue";
import { watch } from "vue";

import { createPinia } from "pinia";

import { setupAssets } from "./assets";
import { setupChatScripts } from "./chat-scripts";
import { setupRouter } from "./router";
import { setupInitialTheme } from "./theme";
import { initTransport, initNativeTransport } from "@/shared/lib/transport/init-transport";
import { useTorStore } from "@/entities/tor";
import { useLocaleStore } from "@/entities/locale";
import { isElectron, isNative, isAndroid } from "@/shared/lib/platform";
import { bootStatus } from "@/app/model/boot-status";
import { withTimeout } from "@/shared/lib/with-timeout";
import { whenChatsInteractive } from "@/shared/lib/boot-signals";

// WEE-97 item 6: fallbacks so deferred boot work still runs when the
// chats-interactive signal never fires (user parked on the login page).
const TOR_DEFER_FALLBACK_MS = 15_000;
const TELEMETRY_DEFER_FALLBACK_MS = 20_000;

export const setupProviders = async (app: App) => {
  setupAssets();

  bootStatus.setStep("scripts");

  // Start loading chat scripts early — runs in parallel with Pinia/theme/locale.
  const scriptsReady = setupChatScripts();

  app.use(createPinia());
  setupInitialTheme();
  useLocaleStore(); // sets document.documentElement.lang from persisted locale

  // Register Service Worker transport proxy in Electron
  if (isElectron) {
    initTransport();
    useTorStore().init();
  }

  if (isNative) {
    // Register Service Worker transport proxy on Android (PocketNet fetch → Tor)
    if (isAndroid) {
      initNativeTransport();
    }

    // Configure status bar for proper safe area insets
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const { useThemeStore } = await import('@/entities/theme');
    try {
      await StatusBar.setOverlaysWebView({ overlay: true });
    } catch (e) {
      console.warn('[StatusBar] setOverlaysWebView failed:', e);
    }

    // Sync status bar color with app theme.
    //
    // Capacitor's Style semantics are platform-consistent:
    //   Style.Dark  → light text/icons (use on dark backgrounds)
    //   Style.Light → dark text/icons  (use on light backgrounds)
    //
    // setBackgroundColor is an Android-only API; on iOS the plugin
    // throws "not implemented for ios". Wrap each call in try/catch
    // so a single failure doesn't break the theme switch.
    const themeStore = useThemeStore();
    const syncStatusBar = async () => {
      const isDark = themeStore.isDarkMode;
      try {
        await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
      } catch (e) {
        console.warn('[StatusBar] setStyle failed:', e);
      }
      // Read --background-total-theme CSS variable (RGB triplet)
      const rgb = getComputedStyle(document.documentElement)
        .getPropertyValue('--background-total-theme').trim();
      if (rgb) {
        const parts = rgb.split(',').map((s: string) => parseInt(s.trim()));
        const hex = '#' + parts.map((v: number) => v.toString(16).padStart(2, '0')).join('');
        try {
          await StatusBar.setBackgroundColor({ color: hex });
        } catch {
          // iOS: setBackgroundColor is not implemented — the status bar is
          // transparent over the WebView, so the underlying CSS background
          // already paints through. Silently skip.
        }
      }
    };
    // Run once now and watch for changes
    syncStatusBar();
    watch(() => themeStore.isDarkMode, syncStatusBar);

    // WEE-97 item 6: telemetry collection is deferred until the chat list is
    // interactive (fallback: 20s — covers the login-page / boot-error case).
    // It used to poll Dexie every 500ms from the very start of boot; after
    // the signal the DB is already initialized, so the poll loop below is
    // only exercised on the fallback path.
    whenChatsInteractive(TELEMETRY_DEFER_FALLBACK_MS).then(() => {
      import('@/shared/lib/telemetry').then(({ collectTelemetry }) => {
        collectTelemetry().then(async (snapshot) => {
          const { isChatDbReady, getChatDb } = await import('@/shared/lib/local-db');
          // Wait for DB to be ready (up to 10s)
          for (let i = 0; i < 20 && !isChatDbReady(); i++) {
            await new Promise(r => setTimeout(r, 500));
          }
          if (isChatDbReady()) {
            const kit = getChatDb();
            await kit.db.syncState.put({
              key: 'device_telemetry',
              value: JSON.stringify(snapshot),
            });
          }
        }).catch((e) => console.warn('[Telemetry] Collection failed:', e));
      }).catch((e) => console.warn('[Telemetry] Module load failed:', e));
    });

    // Wire store to native torService reactive state (always — for settings UI)
    const torStore = useTorStore();
    torStore.init();

    // Only start Tor daemon if user previously opted in.
    // Default is "neveruse" (opt-in) — app boots instantly via clearnet.
    //
    // WEE-97 item 6: the daemon start is deferred until the chat list is
    // interactive (fallback: 15s for the login-page case). The Matrix proxy
    // was already best-effort — initMatrix reads torService.matrixBaseUrl
    // once at connect time, and the daemon's 5-10s bootstrap virtually never
    // beat it; the deferral just stops Tor from competing for CPU/IO during
    // the critical boot path. The Settings UI keeps working: torStore.init()
    // above wires reactive state unconditionally.
    if (torStore.isEnabled) {
      whenChatsInteractive(TOR_DEFER_FALLBACK_MS).then(async () => {
        const { torService } = await import('@/shared/lib/tor');
        torService.initBackground(torStore.mode);

        // Once the daemon is bootstrapped, route the live Matrix session
        // through the local reverse proxy. The proxy flag is consulted
        // per-request in MatrixClientService, so this takes effect on the
        // next /sync long-poll — previously a session that connected before
        // Tor was ready stayed clearnet forever.
        const applyMatrixProxy = () => {
          if (!torService.matrixBaseUrl) return false;
          import('@/entities/matrix').then(({ getMatrixClientService }) => {
            getMatrixClientService().setTorProxyUrl(torService.matrixBaseUrl);
            console.info('[TOR] Matrix proxy applied to live session');
          }).catch((e) => console.warn('[TOR] Matrix proxy re-apply failed:', e));
          return true;
        };
        if (!applyMatrixProxy()) {
          const proxyWatch = watch(
            () => torService.isReady.value,
            (ready) => {
              if (ready && applyMatrixProxy()) proxyWatch();
            },
          );
        }

        // Notify user if Tor fails to start
        const torWatch = watch(
          () => torService.initFailed.value,
          (failed) => {
            if (failed) {
              import('@/shared/lib/use-toast').then(({ useToast }) => {
                const { toast } = useToast();
                toast(
                  'Secure connection unavailable. You can enable Tor in Settings.',
                  'error',
                  8000,
                );
              });
              torWatch(); // stop watching
            }
          },
        );
      });
    }
  }

  // Static pages (e.g. /download landing) don't need chat scripts —
  // skip blocking wait so they render instantly.
  const isStaticRoute = location.hash === "#/download"
    || location.hash.startsWith("#/download?")
    || location.hash.startsWith("#/download/");

  if (!isStaticRoute) {
    // Scripts must finish before router mounts the app — components
    // need API globals (sdk, actions, etc.) available in onMounted.
    await withTimeout(scriptsReady, 30_000, "Chat scripts loading");
  }

  bootStatus.setStep("auth");
  await setupRouter(app);
};

export * from "./app-routes";
export * from "./chat-scripts";
export * from "./initializers";
export * from "./router";
export * from "./types";
