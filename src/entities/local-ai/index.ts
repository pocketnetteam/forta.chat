export { useLocalAiStore } from "./model/local-ai-store";
export type { LocalAiDownloadState, SupportReport, EligibilityReport, DownloadProgress } from "./model/types";
export { createLocalAiConfig, createPlatformSupportPort, MANIFEST_URL_PLACEHOLDER } from "./lib/create-client";
export { collectAiDiagnostics } from "./lib/collect-ai-diagnostics";
export type { AiDiagnostics } from "./lib/collect-ai-diagnostics";
export { downloadErrorMessage } from "./lib/download-error-message";
export { downloadPhaseLabel } from "./lib/download-phase-label";
export { startAiInferenceKeepAlive, stopAiInferenceKeepAlive } from "./lib/ai-inference-keep-alive.adapter";
