import { PocketnetInstance } from "./pocketnetinstance";

export const initializeChatConfig = () => {
  window.testpocketnet = false;
  window.POCKETNETINSTANCE = PocketnetInstance;
  // Alias for the vendor Bastyon SDK (actions.js/api.js/sdk.js), which reads
  // a bare global `app` in several places instead of `parent.app`/`self.app`
  // (e.g. actions.js Account.loadUnspents → `app.platform.currentBlock`).
  // Same object reference as POCKETNETINSTANCE, so it stays in sync with all
  // mutations made via PocketnetInstanceConfigurator. Must run before
  // loadChatScripts() so `window.app.platform` exists once Actions/Api/pSDK
  // are constructed.
  window.app = PocketnetInstance;
};

export * from "./configurator";
