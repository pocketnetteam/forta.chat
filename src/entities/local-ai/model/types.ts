import type { DownloadProgress, EligibilityReport, SupportReport } from "local-ai";

/** Per-artifact download/readiness state shown by both `AiModelGate.vue`
 *  (in-chat) and `LocalAiSettingsSection.vue` (Settings) — same Pinia state,
 *  two renderers, never two separate `onProgress` subscriptions. */
export interface LocalAiDownloadState {
  /** Latest progress event for this artifact, if a download is in flight. */
  progress: DownloadProgress | null;
  /** True once `ensureModelReady()`/`ensureEmbeddingReady()` has resolved
   *  successfully at least once this session. */
  ready: boolean;
  /** Set when the last download attempt for this artifact failed. Raw
   *  technical detail (e.g. "download of model__x__v1.gguf failed after 5
   *  attempts: ...") — never shown to the user directly, see `errorCode`. */
  error: string | null;
  /** Stable machine-readable code from local-ai's `LocalAiError` hierarchy
   *  (`'download_failed'`, `'checksum_mismatch'`, `'insufficient_storage'`,
   *  ...) when `error` came from a download failure — lets the UI show a
   *  translated, human-readable message instead of `error`'s raw exception
   *  text, which is what a real network blip mid-download actually
   *  surfaced as, with no clear next action, before this existed (see
   *  docs/decisions.md). `null` when there's no error, or it didn't carry
   *  a recognizable code (falls back to a generic message). */
  errorCode: string | null;
}

export function createEmptyDownloadState(): LocalAiDownloadState {
  return { progress: null, ready: false, error: null, errorCode: null };
}

export type { SupportReport, EligibilityReport, DownloadProgress };
