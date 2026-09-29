/**
 * Keep a call alive through a short network outage while it signals.
 *
 * matrix-js-sdk ends the call the first time the restart offer fails to send
 * (`gotLocalOffer` → `signalling_timeout`) and gives up on candidates after a
 * few quick retries. ICE itself waits 30 s before the SDK hangs up, so a
 * network change that takes a few seconds to carry traffic (a VPN reconnecting,
 * Wi-Fi handing over to mobile data) ended calls that could have recovered.
 *
 * The answer is no better off: `sendAnswer` fails the call on the first send
 * error (`send_answer`). On iOS the WebKit network process drops a request
 * while the app switches to the CallKit screen (`fetch failed: Load failed`,
 * iPhone XR 2026-09-24), and the call died right after the user accepted it.
 *
 * The wrapper retries `m.call.negotiate` (restart offers and answers) and
 * `m.call.candidates` while the send fails for lack of a connection and the
 * call is still live, for at most the SDK's ICE wait; `m.call.answer` gets a
 * few quick attempts, since the user is waiting on it. A duplicate answer, if
 * a lost response hid a PUT that did land, is ignored by the caller
 * (`onAnswerReceived` keeps the first). Offline it waits for the `online`
 * event instead of polling. Server errors and every other call event keep the
 * SDK's behaviour.
 */

const WRAPPED_FLAG = "__voipSendRetryInstalled";

interface RetryPolicy {
  /** Sends in total, the first one included. */
  maxAttempts: number;
  /** No retry starts after this long from the first send. */
  windowMs: number;
  firstDelayMs: number;
  maxDelayMs: number;
}

/** Matches the SDK's ICE_DISCONNECTED_TIMEOUT: past it the call is over anyway. */
export const VOIP_SEND_RETRY_WINDOW_MS = 30_000;

const ICE_POLICY: RetryPolicy = {
  maxAttempts: Number.POSITIVE_INFINITY,
  windowMs: VOIP_SEND_RETRY_WINDOW_MS,
  firstDelayMs: 1_000,
  maxDelayMs: 8_000,
};

/** Three sends, 0.5 s and 1 s apart: enough for a dropped request, short enough for a waiting user. */
export const ANSWER_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  windowMs: 5_000,
  firstDelayMs: 500,
  maxDelayMs: 2_000,
};

const RETRY_POLICIES: Readonly<Record<string, RetryPolicy>> = {
  "m.call.negotiate": ICE_POLICY,
  "m.call.candidates": ICE_POLICY,
  "m.call.answer": ANSWER_RETRY_POLICY,
};

export interface RetryableVoipCall {
  callId: string;
  sendVoipEvent(eventType: string, content: Record<string, unknown>): Promise<void>;
  callHasEnded(): boolean;
}

export interface VoipSendRetryDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  isOnline: () => boolean;
  /** Resolves on the next `online` event or after `timeoutMs`, whichever comes first. */
  waitForOnline: (timeoutMs: number) => Promise<void>;
}

const defaultDeps: VoipSendRetryDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  waitForOnline: (timeoutMs) =>
    new Promise((resolve) => {
      if (typeof window === "undefined") {
        setTimeout(resolve, timeoutMs);
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        window.removeEventListener("online", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      window.addEventListener("online", done);
    }),
};

const isConnectionError = (e: unknown): boolean => e instanceof Error && e.name === "ConnectionError";

export function installVoipSendRetry(call: RetryableVoipCall, deps: Partial<VoipSendRetryDeps> = {}): void {
  const marker = call as unknown as Record<string, unknown>;
  if (marker[WRAPPED_FLAG] || typeof call.sendVoipEvent !== "function") return;
  marker[WRAPPED_FLAG] = true;

  const { now, sleep, isOnline, waitForOnline } = { ...defaultDeps, ...deps };
  const original = call.sendVoipEvent.bind(call);

  call.sendVoipEvent = async (eventType: string, content: Record<string, unknown>): Promise<void> => {
    const policy = RETRY_POLICIES[eventType];
    if (!policy) return original(eventType, content);

    const deadline = now() + policy.windowMs;
    let delay = policy.firstDelayMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await original(eventType, content);
      } catch (e) {
        const left = deadline - now();
        if (!isConnectionError(e) || call.callHasEnded() || left <= 0 || attempt >= policy.maxAttempts) throw e;
        console.warn(
          `[voip-retry] ${eventType} for ${call.callId} failed without a connection, retrying (${Math.ceil(left / 1000)} s left)`,
        );
        if (isOnline()) {
          await sleep(Math.min(delay, left));
          delay = Math.min(delay * 2, policy.maxDelayMs);
        } else {
          await waitForOnline(left);
        }
        // One more attempt even at the deadline: the wait above never runs past it.
        if (call.callHasEnded()) throw e;
      }
    }
  };
}
