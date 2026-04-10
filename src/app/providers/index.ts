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
    await StatusBar.setOverlaysWebView({ overlay: true });

    // Sync status bar color with app theme
    const themeStore = useThemeStore();
    const syncStatusBar = () => {
      const isDark = themeStore.isDarkMode;
      StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
      // Read --background-total-theme CSS variable (RGB triplet)
      const rgb = getComputedStyle(document.documentElement)
        .getPropertyValue('--background-total-theme').trim();
      if (rgb) {
        const parts = rgb.split(',').map((s: string) => parseInt(s.trim()));
        const hex = '#' + parts.map((v: number) => v.toString(16).padStart(2, '0')).join('');
        StatusBar.setBackgroundColor({ color: hex });
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

    // Start Tor daemon in background — does NOT block boot.
    // App loads with direct connections; switches to Tor when ready.
    bootStatus.setStep("tor");
    const { torService } = await import('@/shared/lib/tor');
    torService.initBackground();
    // Wire store to native torService reactive state
    useTorStore().init();

    // Notify user if Tor fails to start (after app is mounted)
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

  // Scripts must finish before router mounts the app — components
  // need API globals (sdk, actions, etc.) available in onMounted.
  await withTimeout(scriptsReady, 30_000, "Chat scripts loading");
  bootStatus.setStep("auth");
  await setupRouter(app);
};

export * from "./app-routes";
export * from "./chat-scripts";
export * from "./initializers";
export * from "./router";
export * from "./types";
