import { IS_DEV } from "@/shared/config";
import { loadScript } from "@/shared/lib/loadScript";

const scriptsToLoad = {
  async: [
    "/js/vendor/moment.min.js",
    "/js/vendor/linkify.min.js",
    "/js/widgets",
    "/js/buildChat",
    "/js/media",
    "/js/vendor/unmute",
    "/js/vendor/joypixels",
    "/js/vendor/hammer.min.js",
    "/js/vendor/xss.min.js"
  ],
  await: [
    // underscore must load before actions.js/satolist.js which use global `_`
    "/js/vendor/underscore-min.js",
    "/js/satolist",
    "/js/functionsfirst",
    "/js/functions",
    "/js/lib/pocketnet/btc17",
    "/js/lib/pocketnet/buffer",
    "/js/lib/client/system16",
    "/js/lib/client/sdk",
    "/js/lib/client/actions",
    "/js/kit",
    "/js/lib/client/api",
    "/js/lib/client/resoursesdbls",
    "/js/lib/client/resoursesdb"
  ]
} as const;

/** All script URLs loaded during boot — exported for regression tests (no CDN). */
export const CHAT_SCRIPT_URLS = [
  ...scriptsToLoad.async,
  ...scriptsToLoad.await,
] as const;

/** Shared promise — allows starting early and awaiting later */
let _loadPromise: Promise<void> | null = null;

export const loadChatScripts = (): Promise<void> => {
  if (_loadPromise) return _loadPromise;
  _loadPromise = _loadChatScriptsImpl();
  return _loadPromise;
};

async function _loadChatScriptsImpl(): Promise<void> {
  try {
    const isElectron = !!(window as any).electronAPI?.isElectron;

    const normalizeScriptName = (scriptName: string): string => {
      if (scriptName.endsWith(".js")) {
        if (isElectron && scriptName.startsWith("/")) return "." + scriptName;
        return scriptName;
      }
      const name = `${scriptName}.js`;
      if (isElectron && name.startsWith("/")) return "." + name;
      return name;
    };

    // Fire-and-forget scripts (no dependency chain) — swallow errors
    // to prevent unhandled rejections from triggering boot error UI
    for (const script of scriptsToLoad.async) {
      loadScript(normalizeScriptName(script)).catch(() => {});
    }

    // Sequential dependency chain
    for (const script of scriptsToLoad.await) {
      await loadScript(normalizeScriptName(script));
    }
  } catch (error) {
    console.error("Failed to load chat scripts", error);
    throw error;
  }
}
