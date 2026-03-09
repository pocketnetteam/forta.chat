import type { App } from "vue";

import { createPinia } from "pinia";

import { setupAssets } from "./assets";
import { setupChatScripts } from "./chat-scripts";
import { setupRouter } from "./router";
import { setupInitialTheme } from "./theme";
import { initTransport } from "@/shared/lib/transport/init-transport";
import { useTorStore } from "@/entities/tor";
import { useLocaleStore } from "@/entities/locale";

export const setupProviders = async (app: App) => {
  setupAssets();

  // Start loading chat scripts early — runs in parallel with Pinia/theme/locale.
  const scriptsReady = setupChatScripts();

  app.use(createPinia());
  setupInitialTheme();
  useLocaleStore(); // sets document.documentElement.lang from persisted locale

  // Register Service Worker transport proxy in Electron
  if (window.electronAPI?.isElectron) {
    initTransport();
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
