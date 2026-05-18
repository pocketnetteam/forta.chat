import { isNative } from "@/shared/lib/platform";

export type SendErrorKind =
  | "permissionDenied"
  | "micDenied"
  | "pickerCancelled"
  | "fileTooLarge"
  | "dbNotReady"
  | "matrixNotReady"
  | "cryptoNotReady"
  | "uploadFailed"
  | "queueStuck"
  | "unknown";

export interface SendErrorContext {
  fileName?: string;
  kind?: "image" | "video" | "audio" | "file";
  cause?: unknown;
}

export class SendError extends Error {
  readonly kind: SendErrorKind;
  readonly context: SendErrorContext;
  readonly retryable: boolean;

  constructor(kind: SendErrorKind, message: string, context: SendErrorContext = {}, retryable = true) {
    super(message);
    this.name = "SendError";
    this.kind = kind;
    this.context = context;
    this.retryable = retryable;
  }
}

/** Classify a thrown error from getUserMedia/MediaRecorder.start() into a typed
 *  SendError. Android WebView surfaces RECORD_AUDIO denial as NotAllowedError /
 *  PermissionDeniedError; both map to "micDenied". */
export function classifyMicError(err: unknown): SendError {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || /permission/i.test(message)) {
    return new SendError("micDenied", message || "Microphone permission denied", { kind: "audio", cause: err });
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return new SendError("micDenied", "No microphone available", { kind: "audio", cause: err });
  }
  return new SendError("unknown", message || "Voice recording failed", { kind: "audio", cause: err });
}

/** Resolve i18n key for banner text. Keeps the translation table flat so
 *  locale files do not have to mirror the discriminated union structure. */
export function sendErrorI18nKey(kind: SendErrorKind): string {
  return `errors.send.${kind}`;
}

/** Diagnostic prefix used across the send pipeline. Tagging logs with the
 *  same `[send]` prefix lets logcat / devtools filter the whole pipeline:
 *  picker → file-upload → sync-engine → matrix sendEvent. */
export function sendDiag(stage: string, payload?: unknown): void {
  const tag = isNative ? "[send][native]" : "[send][web]";
  if (payload === undefined) {
    // eslint-disable-next-line no-console
    console.info(`${tag} ${stage}`);
  } else {
    // eslint-disable-next-line no-console
    console.info(`${tag} ${stage}`, payload);
  }
}
