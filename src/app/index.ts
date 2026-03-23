import { setupProviders } from "@/app/providers";
import { AppLoading } from "@/app/ui/app-loading";
import { createApp } from "vue";

import App from "./App.vue";

async function setupApp() {
  createApp(AppLoading).mount("#appLoading");
  const app = createApp(App);

  app.config.errorHandler = (err, _instance, info) => {
    console.error('[Vue Error]', err, info);
  };

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[Unhandled Promise]', e.reason);
  });

  await setupProviders(app);
  return app;
}

export const app = setupApp();
