/**
 * Generic async-operation retry helper used by the native-call bridge to
 * survive transient failures from Capacitor plugins.
 *
 * Motivation (WEE-16): `nativeCallBridge.startAudioRouting` used to be
 * fire-and-forget with a `.catch` that only logged a warning. On Android,
 * `AudioManager.setMode` (called inside `AudioRouter.start`) can throw a
 * transient `SecurityException` or `IllegalStateException` immediately
 * after `call.answer()` if the JVM is still parking the call foreground
 * service. A single failed call would leave the device in MODE_NORMAL
 * for the whole conversation — peer hears silence.
 *
 * The helper is deliberately tiny: pure logic, no module-level state,
 * no platform imports. Pass an injected `sleep` to make tests deterministic.
 */

export interface WithRetryOptions {
  /**
   * Delays between attempts. `delaysMs.length + 1` attempts are made in
   * total — i.e. `[]` is a single-shot, `[100, 200]` is 3 attempts.
   * Use an empty array to disable retry without changing the call site.
   */
  delaysMs: readonly number[];
  /** Free-form tag used only for log messages so logs stay greppable. */
  label: string;
  /**
   * Sleep primitive. Defaults to `setTimeout`-based sleep. Tests inject
   * a synchronous mock so the suite does not actually wait.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Override for production logging — defaults to `console.warn`. */
  onAttemptFailed?: (info: {
    attempt: number;
    error: Error;
    nextDelayMs: number | null;
    label: string;
  }) => void;
  /**
   * Optional cancellation signal. When the signal fires while a retry is
   * pending (between attempts), the helper aborts and returns
   * `outcome: "aborted"` immediately. This is critical for WEE-16: if
   * the user hangs up during the retry backoff, a stale retry would
   * otherwise re-arm AudioRouter after stopAudioRouting() already tore
   * it down — leaving the device stuck in MODE_IN_COMMUNICATION until
   * the orphan watchdog fires (up to 5 minutes later).
   */
  signal?: AbortSignal;
}

export type WithRetryResult<T> =
  | { outcome: "success"; value: T; attempts: number }
  | { outcome: "failure"; error: Error; attempts: number }
  | { outcome: "aborted"; attempts: number };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultOnFailed: NonNullable<WithRetryOptions["onAttemptFailed"]> = ({
  attempt,
  error,
  nextDelayMs,
  label,
}) => {
  const next = nextDelayMs === null ? "no retry left" : `retry in ${nextDelayMs}ms`;
  console.warn(
    `[withRetry/${label}] attempt ${attempt} failed: ${error.message} (${next})`,
  );
};

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  if (value === undefined) return new Error("undefined rejection");
  if (value === null) return new Error("null rejection");
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/**
 * Run `op`, retrying on rejection according to `delaysMs`.
 *
 * Returns a discriminated-union result so the caller can branch on
 * outcome without try/catch noise at every call site. Always resolves —
 * never throws.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  options: WithRetryOptions,
): Promise<WithRetryResult<T>> {
  const delays = options.delaysMs;
  const totalAttempts = delays.length + 1;
  const sleep = options.sleep ?? defaultSleep;
  const onFailed = options.onAttemptFailed ?? defaultOnFailed;
  const signal = options.signal;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (signal?.aborted) {
      return { outcome: "aborted", attempts: attempt - 1 };
    }
    try {
      const value = await op();
      return { outcome: "success", value, attempts: attempt };
    } catch (e: unknown) {
      const error = toError(e);
      lastError = error;
      const nextDelay = attempt < totalAttempts ? delays[attempt - 1] : null;
      onFailed({ attempt, error, nextDelayMs: nextDelay, label: options.label });
      if (nextDelay !== null) {
        await sleep(nextDelay);
        if (signal?.aborted) {
          return { outcome: "aborted", attempts: attempt };
        }
      }
    }
  }

  // Loop invariant: lastError is set when totalAttempts >= 1 and all
  // attempts rejected. `totalAttempts` is always >= 1 (delays.length + 1).
  return {
    outcome: "failure",
    error: lastError ?? new Error("withRetry: no error captured"),
    attempts: totalAttempts,
  };
}
