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
  /** Set when the last download attempt for this artifact failed. */
  error: string | null;
}

export function createEmptyDownloadState(): LocalAiDownloadState {
  return { progress: null, ready: false, error: null };
}

export type { SupportReport, EligibilityReport, DownloadProgress };
