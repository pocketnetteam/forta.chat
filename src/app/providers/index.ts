import type { App } from "vue";
import { watch } from "vue";

import { createPinia } from "pinia";

import { setupAssets } from "./assets";
import { setupChatScripts } from "./chat-scripts";
import { setupRouter } from "./router";
import { setupInitialTheme } from "./theme";
import { initTransport } from "@/shared/lib/transport/init-transport";
import { useTorStore } from "@/entities/tor";
import { useLocaleStore } from "@/entities/locale";
import { isElectron, isNative } from "@/shared/lib/platform";
import { bootStatus } from "@/app/model/boot-status";
import { withTimeout } from "@/shared/lib/with-timeout";

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

    // Collect device telemetry (non-blocking) and persist to Dexie
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

    // Wire store to native torService reactive state (always — for settings UI)
    const torStore = useTorStore();
    torStore.init();

    // Only start Tor daemon if user previously opted in.
    // Default is "neveruse" (opt-in) — app boots instantly via clearnet.
    if (torStore.isEnabled) {
      bootStatus.setStep("tor");
      const { torService } = await import('@/shared/lib/tor');
      torService.initBackground();

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
