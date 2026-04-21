import { ref, type Ref } from "vue";
import { isNative } from "@/shared/lib/platform";
import { nativeCallBridge } from "@/shared/lib/native-calls";

export type PermissionDevice = "microphone" | "camera";

/**
 * Reactive pointer to the last call-permission error, consumed by
 * {@link PermissionDeniedModal} to show a UI banner. Cleared by the user
 * closing the modal. Deliberately module-local (not in a Pinia store)
 * because it is read-only UX state with no cross-store concerns.
 */
export const callPermissionError: Ref<{ device: PermissionDevice } | null> = ref(null);

export function clearCallPermissionError(): void {
  callPermissionError.value = null;
}

/**
 * Thrown by {@link ensureCallPermissions} when the user has not granted
 * required runtime permissions or the browser returned a stream without
 * the necessary track. The caller is expected to surface this to the UI
 * (modal with deep-link to system settings) and suppress any further
 * SDK calls — otherwise Matrix would invite/answer with an empty track
 * and the peer would appear "connected" but with no media.
 */
export class PermissionDeniedError extends Error {
  readonly device: PermissionDevice;

  constructor(device: PermissionDevice) {
    super(`Permission denied: ${device}`);
    this.name = "PermissionDeniedError";
    this.device = device;
  }
}

/**
 * Preflight check before any Matrix SDK call placement or answering.
 *
 * Root cause of mass "no audio" reports (#279, #283, #289, #301, #305,
 * #329, #366, #371): `getUserMedia` silently returned a stream without
 * the audio track when `RECORD_AUDIO` was revoked/denied. Matrix SDK
 * continued the invite/answer flow with an empty track, so the peer
 * "connected" but heard silence (and the local user heard silence too
 * because the remote was in the same situation, or saw a 1-2 second
 * "connected then dropped" when SDP negotiation eventually failed).
 *
 * This function refuses to let the flow continue unless both:
 *   - The OS-level runtime permission is GRANTED
 *   - (web only) `getUserMedia` actually returns a stream with non-empty
 *     audio and, for video calls, video tracks
 *
 * On Android (Capacitor native), permission is requested via the single
 * `CallPlugin` entrypoint. A second path through `WebRTCPlugin` would
 * pop a duplicate system dialog in the middle of call setup, so that is
 * kept only as a fail-fast check in `startLocalMedia`.
 */
export async function ensureCallPermissions(isVideo: boolean): Promise<void> {
  if (isNative) {
    await ensureNativePermissions(isVideo);
    return;
  }
  await ensureWebPermissions(isVideo);
}

async function ensureNativePermissions(isVideo: boolean): Promise<void> {
  const audio = await nativeCallBridge.requestAudioPermission();
  if (!audio.granted) {
    throw new PermissionDeniedError("microphone");
  }
  if (!isVideo) return;
  const video = await nativeCallBridge.requestCameraPermission();
  if (!video.granted) {
    throw new PermissionDeniedError("camera");
  }
}

async function ensureWebPermissions(isVideo: boolean): Promise<void> {
  // 1. Fast denial — browsers that support Permissions API report
  //    persistent "denied" state without prompting. Saves us from
  //    hitting getUserMedia just to get back an empty stream.
  await assertWebPermissionNotDenied("microphone");
  if (isVideo) {
    await assertWebPermissionNotDenied("camera");
  }

  // 2. Probe calls — issued sequentially (audio first, then video) so
  //    that a NotAllowedError can be reliably attributed to the
  //    specific device that failed. A combined probe
  //    (`{ audio: true, video: true }`) loses this information:
  //    Chromium's `NotAllowedError` does not distinguish whether the
  //    user denied microphone or camera when both are requested in
  //    one call, which would leave us showing the wrong "grant X in
  //    settings" hint to the user.
  await probeDevice("microphone", { audio: true });
  if (isVideo) {
    await probeDevice("camera", { video: true });
  }
}

async function probeDevice(
  device: PermissionDevice,
  constraints: MediaStreamConstraints,
): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e: unknown) {
    const name = (e as { name?: string } | undefined)?.name ?? "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      throw new PermissionDeniedError(device);
    }
    // NotFoundError / OverconstrainedError / etc. — propagate so the
    // caller can surface a more specific "device missing" error.
    throw e;
  }

  try {
    const tracks =
      device === "microphone" ? stream.getAudioTracks() : stream.getVideoTracks();
    if (tracks.length === 0) {
      throw new PermissionDeniedError(device);
    }
  } finally {
    // Release the probe stream so the SDK's own getUserMedia can
    // acquire the device without contention. Never leave tracks
    // alive here — some browsers will refuse a second getUserMedia
    // while the first stream is still open.
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
  }
}

async function assertWebPermissionNotDenied(device: PermissionDevice): Promise<void> {
  const perms = (navigator as unknown as { permissions?: { query: (q: { name: string }) => Promise<{ state: string }> } }).permissions;
  if (!perms || typeof perms.query !== "function") return; // Safari < 16
  try {
    const status = await perms.query({ name: device });
    if (status.state === "denied") {
      throw new PermissionDeniedError(device);
    }
  } catch (e: unknown) {
    if (e instanceof PermissionDeniedError) throw e;
    // Some browsers throw for unsupported PermissionName — fall through.
  }
}
