import { registerPlugin } from "@capacitor/core";

/**
 * Bridge to the native `AiInferencePlugin.kt` (Android) — a real foreground
 * service (`AiInferenceForegroundService.kt`) that keeps the process alive
 * while an AI-chat reply streams, so backgrounding the app doesn't get the
 * generation killed. See `AiInferenceForegroundService`'s doc comment and
 * `docs/plans/llama2/decisions.md`'s "AI-chat background generation" entry.
 *
 * iOS has no equivalent plugin yet — `ai-inference-keep-alive.adapter.ts`
 * only wires this in on Android, same pattern as
 * `native-foreground-download.adapter.ts`/`model-download-plugin.ts`.
 */
export interface AiInferenceKeepAlivePlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const AiInferenceKeepAlive = registerPlugin<AiInferenceKeepAlivePlugin>("AiInferenceKeepAlive");
