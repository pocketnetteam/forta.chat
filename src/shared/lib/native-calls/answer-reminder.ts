/**
 * The "open Forta to answer" reminder for a call accepted on CallKit while
 * Forta is off screen.
 *
 * WebKit owns the call audio on iOS and starts the microphone capture only
 * while the page is on screen. An Accept on the CallKit banner with Forta in
 * the background asked for the microphone 1.3 s later, the capture never
 * started, and the call silently did not connect (iPhone XR, 2026-10-17).
 * Until calls run on native WebRTC, the user has to open Forta; a local
 * notification tells them so, and a tap on it opens the app.
 *
 * Native schedules the notification at once, so it fires even when the page
 * is suspended right after the answer. It is withdrawn when the call
 * connects, ends, or Forta comes on screen.
 */

/** Long enough for an answer that does capture in the background to connect first. */
export const ANSWER_REMINDER_DELAY_MS = 3_000;
/** How often the page is checked while the reminder waits: the visibility event can go missing. */
const VISIBILITY_POLL_MS = 250;

export interface AnswerReminderDeps {
  schedule(opts: { delayMs: number; title: string; body: string }): Promise<void>;
  cancel(): Promise<void>;
  isPageVisible(): boolean;
  /** May load the strings lazily: the adapter keeps i18n out of its import graph. */
  text(callerName: string): { title: string; body: string } | Promise<{ title: string; body: string }>;
}

export interface AnswerReminder {
  /** The user accepted a call on CallKit. */
  answered(callerName: string): void;
  /** The call connected or ended, or Forta came on screen. */
  settle(): void;
}

export function createAnswerReminder(deps: AnswerReminderDeps): AnswerReminder {
  let armed = false;
  // One queue for both: a cancel must not overtake the schedule it withdraws
  // (the strings load asynchronously, and a call can connect at once).
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (step: () => unknown, failure: string) => {
    // Inside then(): an older native build has no such method and throws at once.
    queue = queue.then(step).catch((e: unknown) => {
      console.warn(`[NativeCallBridge.iOS] answer reminder ${failure}:`, e);
    });
  };
  const reminder: AnswerReminder = {
    answered(callerName) {
      if (deps.isPageVisible()) return;
      armed = true;
      enqueue(async () => deps.schedule({ delayMs: ANSWER_REMINDER_DELAY_MS, ...(await deps.text(callerName)) }), 'not scheduled');
      // CallKit full screen hides Forta at the Accept and gives the screen back a moment
      // later; the visibility event for that did not always come (iPhone XR, 2026-10-19).
      const dueAt = Date.now() + ANSWER_REMINDER_DELAY_MS;
      const watch = () => {
        if (!armed) return;
        if (deps.isPageVisible()) {
          reminder.settle();
          return;
        }
        if (Date.now() < dueAt) setTimeout(watch, VISIBILITY_POLL_MS);
      };
      setTimeout(watch, VISIBILITY_POLL_MS);
    },
    settle() {
      if (!armed) return;
      armed = false;
      enqueue(() => deps.cancel(), 'not withdrawn');
    },
  };
  return reminder;
}
