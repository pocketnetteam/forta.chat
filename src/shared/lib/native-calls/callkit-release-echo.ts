/**
 * Releasing the CallKit record to WebKit makes CallKit deactivate the audio
 * session it activated, and that reaches the app as an AVAudioSession
 * interruption once WebKit starts its own audio: after the answer, or at the
 * connect. In the background the answer takes longer (iPhone XR 2026-10-14:
 * 6.7 s after the release, 1.1 s after the connect), so the window runs from
 * the release and again from the connect that followed it.
 */
export const CALLKIT_ECHO_MS = 5_000;

/** A connect this long after a release belongs to another call. */
const RELEASE_TO_CONNECT_MAX_MS = 60_000;

/**
 * True while an interruption could still be the echo of our own CallKit
 * release rather than a phone call taking the audio.
 * @param releaseAt when the adapter last released a CallKit record (0: never)
 * @param connectedAt when the current call connected, if it has
 */
export function isCallKitReleaseEcho(now: number, releaseAt: number, connectedAt: number | null): boolean {
  if (releaseAt <= 0) return false;
  if (now - releaseAt < CALLKIT_ECHO_MS) return true;
  if (connectedAt === null || connectedAt < releaseAt) return false;
  if (connectedAt - releaseAt > RELEASE_TO_CONNECT_MAX_MS) return false;
  return now - connectedAt < CALLKIT_ECHO_MS;
}
