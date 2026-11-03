import { describe, it, expect } from 'vitest';
import { CALLKIT_ECHO_MS, isCallKitReleaseEcho } from './callkit-release-echo';

/**
 * Releasing the CallKit record to WebKit makes CallKit deactivate its audio
 * session, which reaches the app as an interruption once WebKit starts its own
 * audio. iPhone XR 2026-10-14, Forta in the background: the answer took
 * longer, the interruption came 6.7 s after the release (1.1 s after the
 * connect), the 5 s window had passed, and the watchdog hung the call up.
 */
describe('isCallKitReleaseEcho', () => {
  const release = 1_000_000;

  it('covers the first seconds after the release', () => {
    expect(isCallKitReleaseEcho(release + 1000, release, null)).toBe(true);
    expect(isCallKitReleaseEcho(release + CALLKIT_ECHO_MS + 1, release, null)).toBe(false);
  });

  it('covers the first seconds after a connect that followed the release', () => {
    const connected = release + 5600;
    expect(isCallKitReleaseEcho(release + 6700, release, connected)).toBe(true);
    expect(isCallKitReleaseEcho(connected + CALLKIT_ECHO_MS + 1, release, connected)).toBe(false);
  });

  it('is not an echo with no release, or a connect from long before it', () => {
    expect(isCallKitReleaseEcho(release, 0, release - 100)).toBe(false);
    // A call connected before the release (a later, unrelated release).
    expect(isCallKitReleaseEcho(release + 6000, release, release - 1000)).toBe(false);
    // A release long before the connect is another call's.
    expect(isCallKitReleaseEcho(release + 120_000, release, release + 119_000)).toBe(false);
  });
});
