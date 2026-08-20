import { isAndroid } from "@/shared/lib/platform";
import { AiInferenceKeepAlive } from "./ai-inference-plugin";

/**
 * Brackets one AI-chat `sendMessage()` call with a real Android foreground
 * service (`AiInferenceForegroundService.kt`) — without it, Android can
 * deprioritize or kill the whole process while a reply streams and the user
 * has switched to another app (see `docs/plans/llama2/decisions.md`'s
 * "AI-chat background generation" entry). Android-only, same gate
 * `create-client.ts` uses for `NativeForegroundDownloadAdapter` — a no-op on
 * web/Electron/iOS, where no equivalent native plugin exists.
 *
 * Best-effort: a failure here never blocks/aborts generation itself — the
 * completion still runs (natively, independent of this service), it just
 * loses the extra process-survival margin the notification would have
 * bought it. Mirrors `ModelDownloadService.start()`'s own
 * non-fatal-rejection handling on the Kotlin side.
 */
export async function startAiInferenceKeepAlive(): Promise<void> {
  if (!isAndroid) return;
  try {
    await AiInferenceKeepAlive.start();
  } catch (e) {
    console.warn("[AiInferenceKeepAlive] start failed:", e);
  }
}

/** Counterpart to {@link startAiInferenceKeepAlive} — stops the foreground
 *  service. Safe to call even if `start()` never ran or already failed. */
export async function stopAiInferenceKeepAlive(): Promise<void> {
  if (!isAndroid) return;
  try {
    await AiInferenceKeepAlive.stop();
  } catch (e) {
    console.warn("[AiInferenceKeepAlive] stop failed:", e);
  }
}
