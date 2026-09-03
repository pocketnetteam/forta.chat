import type { LocalAiConfig, LocalAiLogger } from "local-ai";
import { isAndroid } from "@/shared/lib/platform";
import { NativeForegroundDownloadAdapter } from "./native-foreground-download.adapter";
import { NativeFastVerifyAdapter } from "./native-fast-verify.adapter";

// See docs/plans/llama2/decisions.md, open question #1 — this now points at
// a real, reachable manifest (2026-08-19, self-hosted by the user) so the
// device loop can exercise download/ensureModelReady/sendMessage for real.
// Not necessarily the final production URL — confirm with the product owner
// before shipping a release build with the AI tab enabled.
export const MANIFEST_URL_PLACEHOLDER = "https://bastyon.com/local-ai-manifest.json";

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
 * `n_threads` for `local-ai`'s `runtimeTuning.threads` (perf-tuning plan
 * `docs/plans/llama2/2026-08-20-local-ai-perf-tuning-plan.md` §3). No
 * `DeviceSnapshot` field carries CPU core count (plan §11 open question 4,
 * deliberately out of scope here), so this reads `navigator.hardwareConcurrency`
 * directly — available in the WebView. Capped at 4 rather than passed through
 * uncapped: on bigLITTLE Android SoCs (common on the older/weaker devices
 * this project targets, `CLAUDE.md`) using every reported core risks pulling
 * in slow efficiency cores and/or thermal throttling, which can make CPU
 * inference *slower*, not faster — a real risk without per-device
 * measurement, hence the conservative starting cap (raise only after a real
 * on-device `tgAvg` comparison, plan §9/§11). Floored at 2 so a
 * `hardwareConcurrency` of `0`/`undefined` (some WebView configurations
 * report it as absent) never collapses to single-threaded.
 */
export function computeRuntimeThreads(hardwareConcurrency: number | undefined): number {
  return Math.max(2, Math.min(hardwareConcurrency || 4, 4));
}

/**
 * Builds a `LocalAiConfig` scoped to one Bastyon account. Pure/testable —
 * takes `address` as a parameter instead of reading the auth store directly
 * (roadmap 2.1). Callers pass the result to `LocalAiClient.create()`.
 *
 * Dynamically imports `local-ai/adapters/capacitor` — `llama-cpp-pro`
 * (formerly `llama-cpp-capacitor`, see `local-ai`'s
 * `docs/adr/0008-llama-cpp-pro-migration.md`) and friends have no reason to
 * sit in the web/Electron entry bundle, only
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
    CapacitorRangeDownloadAdapter,
    CapacitorFsAdapter,
    CapacitorSqliteAdapter,
    LlamaCppCapacitorAdapter,
    CapacitorAppLifecycleAdapter,
    WebCryptoHashAdapter,
    SystemClockAdapter,
  } = await import("local-ai/adapters/capacitor");

  // Shared instance (not one per port) — the download transport needs the
  // same FileSystemPort the rest of the client uses, both for where it
  // writes chunks and so resume-offset stat()s see what downloadTransport
  // itself just wrote.
  const fileSystem = new CapacitorFsAdapter();

  return {
    manifestUrl: MANIFEST_URL_PLACEHOLDER,
    databaseName: `local_ai_${address}`,
    ports: {
      platformSupport: new CapacitorPlatformSupportAdapter(),
      deviceInfo: new CapgoDeviceInfoAdapter(),
      // Real byte-level resume — see docs/plans/llama2/decisions.md's "no
      // real resume on Android" entry (2026-08-19): @capgo/capacitor-downloader
      // (DownloadManager) has none at all on Android, pause()/resume() reject
      // unconditionally.
      //
      // On Android specifically, NativeForegroundDownloadAdapter (a real
      // ModelDownloadService foreground service) is used instead of the
      // JS-only CapacitorRangeDownloadAdapter — a WebView JS loop gets
      // throttled/killed once the app is backgrounded, so the "real resume"
      // fix above didn't actually survive the user switching apps (see
      // docs/decisions.md's "background download" entry). No iOS
      // equivalent plugin exists yet, so iOS keeps the JS adapter — iOS
      // background execution has its own constraints or would need a
      // BGProcessingTask, out of scope here.
      downloadTransport: isAndroid
        ? new NativeForegroundDownloadAdapter(fileSystem)
        : new CapacitorRangeDownloadAdapter(fileSystem),
      fileSystem,
      sqlite: new CapacitorSqliteAdapter(`local_ai_${address}`),
      llmRuntime: new LlamaCppCapacitorAdapter(),
      appLifecycle: new CapacitorAppLifecycleAdapter(),
      hash: new WebCryptoHashAdapter(),
      clock: new SystemClockAdapter(),
      // Android-only, same reasoning as downloadTransport above — see
      // NativeFastVerifyAdapter's own doc comment: checksum verification
      // through the portable Filesystem-bridge path took ~1.9 hours for a
      // 2.3GB model on-device (confirmed live, 2026-08-19), read as a hang
      // ("скачалась модель - зависла на 100%"). Omitted on iOS/web —
      // DownloadEngine falls back to the portable path there.
      fastVerify: isAndroid ? new NativeFastVerifyAdapter() : undefined,
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
    // Multi-model UI follow-up (2026-08-21): each downloaded model stays on
    // disk across a switch, so switching back to a previously-downloaded
    // model is instant, no re-download. Deliberate product trade-off (more
    // storage used) discussed and chosen over the library's storage-
    // conscious default — see local-ai-store.ts's `modelDiskState`.
    retainInactiveModels: true,
    // perf-tuning plan §3 — n_threads was previously never passed to
    // initLlama() at all, leaving the native plugin's own thread-count
    // default in effect. See computeRuntimeThreads()'s own doc comment for
    // the cap rationale.
    runtimeTuning: {
      threads: computeRuntimeThreads(typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined),
    },
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
