import type { TranslationKey } from "@/shared/lib/i18n";

/**
 * Maps `local-ai`'s stable `LocalAiError.code` values (see its own
 * `docs/errors.md`/`errors.ts` — `code` is the contract, never `message`)
 * to a translated, human-readable string. Never show a download failure's
 * raw `.message` directly — a real network blip mid-download surfaced as
 * "download of model__qwen3-4b__v1.gguf failed after 5 attempts: ..." with
 * no clear next action, which is exactly the complaint that prompted this
 * (docs/decisions.md).
 *
 * Shared by `AiModelGate.vue` and `LocalAiSettingsSection.vue` — one
 * mapping, not two copies that could drift.
 */
export function downloadErrorMessage(t: (key: TranslationKey) => string, errorCode: string | null): string {
  switch (errorCode) {
    case "checksum_mismatch":
      return t("ai.downloadErrorChecksum");
    case "insufficient_storage":
      return t("ai.downloadErrorStorage");
    default:
      // Covers 'download_failed' (network drop, native-plugin errors, etc.
      // — DownloadEngine wraps every transport-level failure under this one
      // code) and any error without a recognizable code at all.
      return t("ai.downloadErrorGeneric");
  }
}
