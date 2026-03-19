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

export const setupProviders = async (app: App) => {
  setupAssets();

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

    // Start Tor daemon and reverse proxy before Matrix client connects
    const { torService } = await import('@/shared/lib/tor');
    await torService.init('always');
    // Wire store to native torService reactive state
    useTorStore().init();
  }

  // Scripts must finish before router mounts the app — components
  // need API globals (sdk, actions, etc.) available in onMounted.
  await scriptsReady;
  await setupRouter(app);
};

export * from "./app-routes";
export * from "./chat-scripts";
export * from "./initializers";
export * from "./router";
export * from "./types";
