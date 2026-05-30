import { withTimeout } from "@/shared/lib/with-timeout";

/**
 * Minimal subset of `MatrixClientService` consumed by the retry helper.
 * Keeps the helper testable without pulling the whole service surface.
 */
export interface RetryableMatrixService {
  init(): Promise<void>;
  isReady(): boolean;
  readonly error: string | false;
}

export interface ConnectMatrixWithRetryOptions {
  /** Per-attempt timeout for `service.init()`. Defaults to 45_000 ms (Matrix HS connect budget). */
  attemptTimeoutMs?: number;
  /** Maximum attempts (initial + retries). Defaults to 3. */
  maxAttempts?: number;
  /** Base delay between attempts in ms (exponential: base * 2^i). Defaults to 1_000. */
  baseDelayMs?: number;
  /** Cap on backoff delay between attempts. Defaults to 30_000 ms. */
  maxDelayMs?: number;
  /** Sleeper, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt progress hook, e.g. for UI status text. */
  onAttempt?: (attempt: number, maxAttempts: number) => void;
  /** Per-attempt failure hook with the captured error. */
  onAttemptFail?: (attempt: number, error: unknown) => void;
}

export interface ConnectMatrixWithRetryResult {
  /** True when `service.isReady()` became true within budget. */
  ready: boolean;
  /** Number of attempts actually executed. */
  attempts: number;
  /** Captured error from the last attempt (when `ready === false`). */
  lastError: unknown;
}

const DEFAULT_OPTIONS = {
  attemptTimeoutMs: 45_000,
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive `MatrixClientService.init()` until it reports ready or attempts are
 * exhausted. Wraps each attempt in a timeout and waits with exponential backoff
 * between failures. The helper is transport-agnostic and never touches Pinia
 * or the boot UI — callers translate the result into typed boot state.
 *
 * Behaviour:
 *  - `init()` is invoked sequentially, never concurrently.
 *  - When `init()` returns but `service.isReady()` stays `false`, the attempt
 *    is treated as a soft failure (transient transport / sync error). This is
 *    the failure shape observed on Xiaomi MIUI when `/sync` long-polls die
 *    before the SDK flips the ready flag.
 *  - Final attempt does not pay an extra backoff wait.
 */
export async function connectMatrixWithRetry(
  service: RetryableMatrixService,
  options: ConnectMatrixWithRetryOptions = {},
): Promise<ConnectMatrixWithRetryResult> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_OPTIONS.attemptTimeoutMs;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_OPTIONS.maxAttempts);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_OPTIONS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options.onAttempt?.(attempt, maxAttempts);

    try {
      await withTimeout(
        service.init(),
        attemptTimeoutMs,
        `Matrix server connection (attempt ${attempt}/${maxAttempts})`,
      );

      if (service.isReady()) {
        return { ready: true, attempts: attempt, lastError: null };
      }

      // init() resolved but the service is not ready — capture diagnostic
      // and treat it as a transient failure worth retrying.
      lastError =
        service.error !== false && service.error
          ? new Error(String(service.error))
          : new Error("Matrix service not ready after init()");
    } catch (e) {
      lastError = e;
    }

    options.onAttemptFail?.(attempt, lastError);

    if (attempt < maxAttempts) {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delay);
    }
  }

  return { ready: false, attempts: maxAttempts, lastError };
}
