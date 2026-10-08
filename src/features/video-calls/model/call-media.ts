/**
 * Local media controls of the active call: mute, camera, screen share, device switching and the
 * saved-device restore. Split out of call-service.ts; each function reads the call store itself.
 */
import type { MatrixCall } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import { getMatrixClientService } from "@/entities/matrix";
import { useCallStore } from "@/entities/call";
import { onScreenShareEnded } from "./screen-share-end";
import { updateFeeds } from "./call-feeds";

/**
 * Lightweight: just store device IDs in mediaHandler so the SDK uses them
 * in its initial getUserMedia constraints. This is best-effort ({ideal}).
 * The real fix is applySavedDevicesExact() which runs after call connects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function hintStoredDevices(client: any) {
  try {
    const mediaHandler = client?.getMediaHandler?.();
    if (!mediaHandler) return;
    const savedAudio = localStorage.getItem("bastyon_call_audio_device") ?? "";
    const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
    if (savedAudio || savedVideo) {
      mediaHandler.restoreMediaSettings(savedAudio, savedVideo);
    }
  } catch (e) {
    console.warn("[call-service] hintStoredDevices error:", e);
  }
}

/**
 * After call connects, check if current tracks match saved preferences.
 * If not, apply with {exact} constraint via sender.replaceTrack().
 */
export async function applySavedDevicesExact(call: MatrixCall) {
  try {
    const savedAudio = localStorage.getItem("bastyon_call_audio_device") ?? "";
    const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
    if (!savedAudio && !savedVideo) return;

    const localStream = call.localUsermediaStream;
    if (!localStream) return;

    // Check audio
    if (savedAudio) {
      const currentAudioTrack = localStream.getAudioTracks()[0];
      const currentAudioId = currentAudioTrack?.getSettings()?.deviceId ?? "";
      if (currentAudioId !== savedAudio) {
        await setAudioDevice(savedAudio);
      }
    }

    // Check video
    if (savedVideo) {
      const currentVideoTrack = localStream.getVideoTracks()[0];
      if (currentVideoTrack) {
        const currentVideoId = currentVideoTrack.getSettings()?.deviceId ?? "";
        if (currentVideoId !== savedVideo) {
          await setVideoDevice(savedVideo);
        }
      }
    }
  } catch (e) {
    console.warn("[call-service] applySavedDevicesExact error:", e);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getClient(): any {
  return getMatrixClientService().client;
}

// ---------------------------------------------------------------------------
// Toggle camera lock (#2)
// ---------------------------------------------------------------------------

let toggleCameraLock = false;

// Module-level like the lock above: every useCallService() caller shares one call.
let stopScreenShareWatch: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Answer-call re-entry lock (WEE-45 / forta-bugs#724)
// ---------------------------------------------------------------------------

export async function toggleMute() {
  const callStore = useCallStore();
  const call = callStore.matrixCall as MatrixCall | null;
  if (!call) return;

  try {
    const muted = call.isMicrophoneMuted();
    await call.setMicrophoneMuted(!muted);
    callStore.audioMuted = !muted;
  } catch (e) {
    console.error("[call-service] toggleMute error:", e);
  }
}

/** Toggle camera — trust SDK, single setLocalVideoMuted call (#2) */
export async function toggleCamera() {
  const callStore = useCallStore();
  const call = callStore.matrixCall as MatrixCall | null;
  if (!call) return;

  if (toggleCameraLock) {
    console.warn("[call-service] toggleCamera already in progress");
    return;
  }
  toggleCameraLock = true;

  try {
    const wantMuted = !callStore.videoMuted;

    await call.setLocalVideoMuted(wantMuted);
    callStore.videoMuted = wantMuted;

    if (!wantMuted && callStore.activeCall?.type === "voice") {
      callStore.setActiveCall({ ...callStore.activeCall, type: "video" });
    }
    updateFeeds(call);

    // Re-apply saved video device when turning camera back on —
    // SDK may have acquired the default device instead of the saved one
    if (!wantMuted) {
      const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
      if (savedVideo) {
        const newTrack = call.localUsermediaStream?.getVideoTracks()[0];
        const currentId = newTrack?.getSettings()?.deviceId ?? "";
        if (currentId && currentId !== savedVideo) {
          await setVideoDevice(savedVideo);
        }
      }
    }
  } catch (e) {
    console.error("[call-service] toggleCamera error:", e);
  } finally {
    toggleCameraLock = false;
  }
}

export async function toggleScreenShare() {
  const callStore = useCallStore();
  const call = callStore.matrixCall as MatrixCall | null;
  if (!call) return;

  try {
    const wasEnabled = callStore.screenSharing;
    const newState = await call.setScreensharingEnabled(!wasEnabled);
    // setScreensharingEnabled returns the actual new state (true=sharing, false=not)
    callStore.screenSharing = newState;
    stopScreenShareWatch?.();
    stopScreenShareWatch = null;
    if (newState) {
      // Stopped from the browser's own "Stop sharing" control: tear the
      // feed down the same way the in-app button does.
      stopScreenShareWatch = onScreenShareEnded(call.localScreensharingStream, () => {
        stopScreenShareWatch = null;
        if (callStore.matrixCall !== call || !callStore.screenSharing) return;
        void toggleScreenShare();
      });
    }
    updateFeeds(call);
  } catch (e) {
    console.error("[call-service] toggleScreenShare error:", e);
    // On error, ensure state reflects reality
    callStore.screenSharing = false;
  }
}

/**
 * Switch audio input device mid-call.
 *
 * Bypasses SDK's mediaHandler.setAudioInput which uses {ideal} constraint
 * (browser can silently return the old device). Instead we:
 * 1. getUserMedia with {exact: deviceId}
 * 2. sender.replaceTrack on the peer connection
 * 3. swap the track in the local MediaStream
 * 4. sync mediaHandler's stored input ID
 */
export async function setAudioDevice(deviceId: string) {
  const callStore = useCallStore();
  try {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    // 1. Acquire new track with {exact} constraint
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
    });
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) {
      newStream.getTracks().forEach(t => t.stop());
      console.error("[call-service] setAudioDevice: no audio track obtained");
      return;
    }
    // A fresh track starts enabled, and the SDK mutes by disabling the
    // track: without this a muted user goes live on the new mic.
    newTrack.enabled = !call.isMicrophoneMuted();

    // 2. Replace track on the WebRTC sender
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pc: RTCPeerConnection | undefined = (call as any).peerConn;
    if (pc) {
      const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
      if (audioSender) {
        await audioSender.replaceTrack(newTrack);
      } else {
        console.warn("[call-service] No audio sender found on peer connection");
      }
    }

    // 3. Swap track in local MediaStream so UI reflects new device
    const localStream = call.localUsermediaStream;
    if (localStream) {
      const oldTrack = localStream.getAudioTracks()[0];
      if (oldTrack) {
        localStream.removeTrack(oldTrack);
        oldTrack.stop();
      }
      localStream.addTrack(newTrack);
    }

    // 4. Sync mediaHandler's stored ID (so future calls use this device)
    const client = getClient();
    const mediaHandler = client?.getMediaHandler?.();
    if (mediaHandler?.restoreMediaSettings) {
      const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
      mediaHandler.restoreMediaSettings(deviceId, savedVideo);
    }

    updateFeeds(call);
  } catch (e) {
    console.error("[call-service] setAudioDevice error:", e);
  }
}

/**
 * Switch video input device mid-call.
 *
 * Same bypass as setAudioDevice — uses {exact} constraint directly.
 */
export async function setVideoDevice(deviceId: string) {
  const callStore = useCallStore();
  try {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    // 1. Acquire new track with {exact} constraint
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
    });
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) {
      newStream.getTracks().forEach(t => t.stop());
      console.error("[call-service] setVideoDevice: no video track obtained");
      return;
    }
    // Same as the mic: a camera turned off must stay off on the new device.
    newTrack.enabled = !call.isLocalVideoMuted();

    // 2. Replace track on the WebRTC sender
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pc: RTCPeerConnection | undefined = (call as any).peerConn;
    if (pc) {
      const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (videoSender) {
        await videoSender.replaceTrack(newTrack);
      } else {
        console.warn("[call-service] No video sender found on peer connection");
      }
    }

    // 3. Swap track in local MediaStream so UI reflects new device
    const localStream = call.localUsermediaStream;
    if (localStream) {
      const oldTrack = localStream.getVideoTracks()[0];
      if (oldTrack) {
        localStream.removeTrack(oldTrack);
        oldTrack.stop();
      }
      localStream.addTrack(newTrack);
    }

    // 4. Sync mediaHandler's stored ID
    const client = getClient();
    const mediaHandler = client?.getMediaHandler?.();
    if (mediaHandler?.restoreMediaSettings) {
      const savedAudio = localStorage.getItem("bastyon_call_audio_device") ?? "";
      mediaHandler.restoreMediaSettings(savedAudio, deviceId);
    }

    updateFeeds(call);
  } catch (e) {
    console.error("[call-service] setVideoDevice error:", e);
  }
}

/** Called from native CallActivity video toggle — triggers SDK renegotiation */
export async function setLocalVideoMuted(muted: boolean) {
  const callStore = useCallStore();
  const call = callStore.matrixCall as MatrixCall | null;
  if (!call) return;
  try {
    await call.setLocalVideoMuted(muted);
    callStore.videoMuted = muted;
    if (!muted && callStore.activeCall?.type === "voice") {
      callStore.setActiveCall({ ...callStore.activeCall, type: "video" });
    }
    updateFeeds(call);
  } catch (e) {
    console.error("[call-service] setLocalVideoMuted error:", e);
  }
}
