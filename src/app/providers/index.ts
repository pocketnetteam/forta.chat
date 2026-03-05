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

  // Start loading chat scripts early but don't block UI framework setup.
  // Scripts are only needed when Matrix client initializes (after login).
  const scriptsReady = setupChatScripts();

  app.use(createPinia());
  setupInitialTheme();
  useLocaleStore(); // sets document.documentElement.lang from persisted locale

  // Register Service Worker transport proxy in Electron
  if (window.electronAPI?.isElectron) {
    initTransport();
    useTorStore().init();
  }

  await setupRouter(app);

  // Ensure scripts finish loading before app becomes interactive
  await scriptsReady;
};

export * from "./app-routes";
export * from "./chat-scripts";
export * from "./initializers";
export * from "./router";
export * from "./types";
