import type { LocalAiConfig, LocalAiLogger } from "local-ai";

// TODO(local-ai-0.1): placeholder — see docs/plans/llama2/decisions.md, open
// question #1. Not a real CDN/domain yet, replace before shipping a build
// with the AI tab enabled.
export const MANIFEST_URL_PLACEHOLDER = "https://static.forta.chat/local-ai/manifest.json";

/** Routes `local-ai`'s pluggable logger through the project's console
 *  conventions (`CLAUDE.md` → Error Handling): only warn/error surface,
 *  prefixed with the module name; debug/info are no-op so the console isn't
 *  spammed by every internal event (plan §11). */
const logger: LocalAiLogger = {
  debug: () => {},
  info: () => {},
  warn: (message, meta) => console.warn(`[LocalAi] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[LocalAi] ${message}`, meta ?? ""),
};

/**
 * Builds a `LocalAiConfig` scoped to one Bastyon account. Pure/testable —
 * takes `address` as a parameter instead of reading the auth store directly
 * (roadmap 2.1). Callers pass the result to `LocalAiClient.create()`.
 *
 * Dynamically imports `local-ai/adapters/capacitor` — `llama-cpp-capacitor`
 * and friends have no reason to sit in the web/Electron entry bundle, only
 * native builds ever call this (plan §7.1, "AI" tab is native-only).
 *
 * `databaseName` is per-account (`local_ai_<address>`) so switching accounts
 * on-device never leaks one user's AI-chat context into another's prompt
 * (plan §4.2) — the model *file* itself stays shared (content-addressed by
 * the library's own default `storageDirectory`), only the SQLite mirror is
 * namespaced here.
 */
export async function createLocalAiConfig(address: string): Promise<LocalAiConfig> {
  const {
    CapacitorPlatformSupportAdapter,
    CapgoDeviceInfoAdapter,
    CapgoDownloaderAdapter,
    CapacitorFsAdapter,
    CapacitorSqliteAdapter,
    LlamaCppCapacitorAdapter,
    CapacitorAppLifecycleAdapter,
    WebCryptoHashAdapter,
    SystemClockAdapter,
  } = await import("local-ai/adapters/capacitor");

  return {
    manifestUrl: MANIFEST_URL_PLACEHOLDER,
    databaseName: `local_ai_${address}`,
    ports: {
      platformSupport: new CapacitorPlatformSupportAdapter(),
      deviceInfo: new CapgoDeviceInfoAdapter(),
      downloadTransport: new CapgoDownloaderAdapter(),
      fileSystem: new CapacitorFsAdapter(),
      sqlite: new CapacitorSqliteAdapter(`local_ai_${address}`),
      llmRuntime: new LlamaCppCapacitorAdapter(),
      appLifecycle: new CapacitorAppLifecycleAdapter(),
      hash: new WebCryptoHashAdapter(),
      clock: new SystemClockAdapter(),
    },
    // roadmap 7.1: library default is `false` (memory-vs-latency tradeoff
    // left to the consumer, docs/guides/memory-and-lifecycle.md). Explicit
    // `true` here — this project's whole context is Android-compatibility
    // across weak/old devices (`CLAUDE.md`), and a multi-GB LLM staying
    // resident in RAM while backgrounded risks the OS killing the entire
    // app process on low-RAM Android 7/8 devices, not just slowing AI down.
    // Tradeoff accepted: returning to an AI chat after backgrounding pays
    // the reload latency again (no eager reload on foreground either, per
    // the library's own design) — reasonable given AI replies already
    // stream, so a cold-start delay before the first token is not a new
    // class of wait for the user.
    autoUnloadOnBackground: true,
    logger,
    // Persistent log store enabled so real-device diagnostics are available
    // through the existing bug-report flow (plan §11, roadmap 7.6) — this is
    // the only diagnostic channel for a Capacitor integration that has never
    // been run on a real device by the library's own authors (plan §1, §10).
    // minLevel 'warn' (not the library's 'info' default) keeps the 5000-entry
    // cap from filling with routine progress/lifecycle noise.
    logging: {
      enabled: true,
      minLevel: "warn",
      maxEntries: 5000,
    },
  };
}

/** Lazily loads just the `PlatformSupportPort` adapter — used by
 *  `checkSupportOnce()`, which must work without a full client/config
 *  (no `manifestUrl`/network involved, plan §4 `checkSupportOnce()`). */
export async function createPlatformSupportPort() {
  const { CapacitorPlatformSupportAdapter } = await import("local-ai/adapters/capacitor");
  return new CapacitorPlatformSupportAdapter();
}
