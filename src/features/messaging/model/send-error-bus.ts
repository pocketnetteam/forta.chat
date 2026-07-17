import { ref, readonly } from "vue";
import { SendError, type SendErrorKind, type SendErrorContext } from "./send-errors";

export interface ActiveSendError {
  readonly id: number;
  readonly kind: SendErrorKind;
  readonly message: string;
  readonly context: SendErrorContext;
  readonly retryable: boolean;
  readonly retry?: () => Promise<void> | void;
  readonly createdAt: number;
}

const currentError = ref<ActiveSendError | null>(null);
let nextId = 1;

/** Report a failed send so the UI banner can surface it.
 *
 *  Why a singleton bus and not a per-component ref:
 *   - sendFile/sendImage/sendAudio are called from several places (paste-drop,
 *     forward, share target, attachment panel) — they cannot all wire a Vue
 *     emit/ref through. The bus stays decoupled from the call sites.
 *   - Only the latest error is shown. A second failure within the same UX
 *     surface should replace the first (Telegram-style "last error wins"),
 *     not stack up an unread queue. */
export function reportSendError(
  err: SendError | unknown,
  retry?: ActiveSendError["retry"],
): ActiveSendError {
  const sendErr = err instanceof SendError
    ? err
    : new SendError("unknown", err instanceof Error ? err.message : String(err), {}, true);
  const entry: ActiveSendError = {
    id: nextId++,
    kind: sendErr.kind,
    message: sendErr.message,
    context: sendErr.context,
    retryable: sendErr.retryable,
    retry,
    createdAt: Date.now(),
  };
  currentError.value = entry;
  return entry;
}

export function clearSendError(id?: number): void {
  if (id !== undefined && currentError.value?.id !== id) return;
  currentError.value = null;
}

export function useSendErrorBus() {
  return {
    error: readonly(currentError),
    clear: clearSendError,
  };
}

/** Test helper: reset module state between unit tests. Vue refs leak across
 *  tests when modules are not re-imported. Exported here so tests do not have
 *  to reach into internals. */
export function __resetSendErrorBusForTests(): void {
  currentError.value = null;
  nextId = 1;
}
