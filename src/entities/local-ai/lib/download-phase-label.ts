import type { DownloadProgress } from "local-ai";
import type { TranslationKey } from "@/shared/lib/i18n";

/**
 * Translates a `DownloadProgress` into what's actually happening right
 * now, in words — "Скачивание… X%" covers only one of several real phases
 * a model download goes through, and showing that same text (or nothing
 * distinct) for every phase is exactly what made a real, slow-but-working
 * verification/load pass read as a hang: "скачалась модель - зависла на
 * 100%" (reported live, 2026-08-19). `status: 'verifying'` (streamed
 * incrementally now, not a single stuck-at-100 tick) and `status:
 * 'loading'` (no fractional progress possible — parsing/mapping a GGUF
 * into the runtime isn't itself chunked) each get their own text so the
 * user can tell "still verifying, X% through" apart from "verified,
 * loading into memory now" apart from "actually still downloading".
 *
 * `isPaused` is separate UI-only state (see `local-ai-store.ts`'s own doc
 * comment on it) — local-ai's DownloadProgress has no 'paused' status of
 * its own, so it's checked first here rather than folded into the status
 * switch below.
 *
 * Shared by `AiModelGate.vue` and `LocalAiSettingsSection.vue` — one
 * mapping, not two copies that could drift.
 */
export function downloadPhaseLabel(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  progress: DownloadProgress | null,
  isPaused: boolean,
): string {
  const percent = Math.round(progress?.percent ?? 0);
  if (isPaused) return t("ai.downloadPaused", { percent });
  switch (progress?.status) {
    case "verifying":
      return t("ai.verifying", { percent });
    case "loading":
      return t("ai.loadingModel");
    default:
      return t("ai.downloading", { percent });
  }
}
