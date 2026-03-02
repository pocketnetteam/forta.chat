import { createNewMatrixCall, CallEvent, CallState as SDKCallState, CallErrorCode } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import type { MatrixCall, CallEventHandlerMap } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import { getMatrixClientService } from "@/entities/matrix";
import { useCallStore, CallStatus } from "@/entities/call";
import type { CallType, CallInfo, CallHistoryEntry } from "@/entities/call";
import { matrixIdToAddress } from "@/entities/chat/lib/chat-helpers";
import { useUserStore } from "@/entities/user";
import type { CallFeed } from "matrix-js-sdk-bastyon/lib/webrtc/callFeed";
import { playRingtone, playDialtone, playEndTone, stopAllSounds } from "./call-sounds";
import { checkOtherTabHasCall } from "./call-tab-lock";

// ---------------------------------------------------------------------------
// SDK state → store status mapping
// ---------------------------------------------------------------------------

function mapSDKState(state: SDKCallState, direction: "outgoing" | "incoming"): CallStatus {
  switch (state) {
    case SDKCallState.Ringing:
      return direction === "outgoing" ? CallStatus.ringing : CallStatus.incoming;
    case SDKCallState.Connecting:
    case SDKCallState.CreateOffer:
    case SDKCallState.CreateAnswer:
    case SDKCallState.InviteSent:
    case SDKCallState.WaitLocalMedia:
      return CallStatus.connecting;
    case SDKCallState.Connected:
      return CallStatus.connected;
    case SDKCallState.Ended:
      return CallStatus.ended;
    default:
      return CallStatus.connecting;
  }
}

// ---------------------------------------------------------------------------
// Feed helpers — use SDK typed getters (#7)
// ---------------------------------------------------------------------------

function updateFeeds(call: MatrixCall) {
  const callStore = useCallStore();
  try {
    // Local: always camera feed (for PiP), never screenshare
    callStore.setLocalStream(call.localUsermediaStream ?? null);
    // Local screen share stream (for self-preview when sharing)
    callStore.setLocalScreenStream(call.localScreensharingStream ?? null);
    // Remote camera (usermedia only — carries audio track too)
    callStore.setRemoteStream(call.remoteUsermediaStream ?? null);
    // Remote screen share as a separate stream
    callStore.setRemoteScreenStream(call.remoteScreensharingStream ?? null);
    callStore.remoteScreenSharing = !!call.remoteScreensharingStream;
    // Sync remote video mute state + wire listener
    syncRemoteVideoMuted(call);
  } catch (e) {
    console.warn("[call-service] updateFeeds error:", e);
  }
}

// ---------------------------------------------------------------------------
// Remote video mute detection
// ---------------------------------------------------------------------------

let trackedRemoteFeed: CallFeed | null = null;
let remoteFeedMuteHandler: ((audioMuted: boolean, videoMuted: boolean) => void) | null = null;

function cleanupRemoteFeedListener() {
  if (trackedRemoteFeed && remoteFeedMuteHandler) {
    try {
      trackedRemoteFeed.off("mute_state_changed" as any, remoteFeedMuteHandler);
    } catch { /* ignore */ }
  }
  trackedRemoteFeed = null;
  remoteFeedMuteHandler = null;
}

function syncRemoteVideoMuted(call: MatrixCall) {
  const callStore = useCallStore();
  const remoteFeed = call.remoteUsermediaFeed as CallFeed | undefined;

  /** Upgrade call type to "video" when remote peer enables camera */
  const maybeUpgradeToVideo = (videoMuted: boolean) => {
    if (!videoMuted && callStore.activeCall?.type === "voice") {
      callStore.setActiveCall({ ...callStore.activeCall, type: "video" });
    }
  };

  // If feed changed, re-wire listener
  if (remoteFeed !== trackedRemoteFeed) {
    cleanupRemoteFeedListener();

    if (remoteFeed) {
      callStore.remoteVideoMuted = remoteFeed.isVideoMuted();
      maybeUpgradeToVideo(remoteFeed.isVideoMuted());
      remoteFeedMuteHandler = (_audioMuted: boolean, videoMuted: boolean) => {
        callStore.remoteVideoMuted = videoMuted;
        maybeUpgradeToVideo(videoMuted);
      };
      trackedRemoteFeed = remoteFeed;
      remoteFeed.on("mute_state_changed" as any, remoteFeedMuteHandler);
    } else {
      // No remote feed yet → treat as muted
      callStore.remoteVideoMuted = true;
    }
  } else if (remoteFeed) {
    // Same feed, just re-check state
    callStore.remoteVideoMuted = remoteFeed.isVideoMuted();
    maybeUpgradeToVideo(remoteFeed.isVideoMuted());
  }
}

// ---------------------------------------------------------------------------
// Event listener lifecycle (#1)
// ---------------------------------------------------------------------------

/** Stored handler refs so we can remove them with call.off() */
let boundHandlers: {
  onState: CallEventHandlerMap[CallEvent.State];
  onFeeds: CallEventHandlerMap[CallEvent.FeedsChanged];
  onHangup: CallEventHandlerMap[CallEvent.Hangup];
  onError: CallEventHandlerMap[CallEvent.Error];
} | null = null;

function unwireCallEvents(call: MatrixCall) {
  cleanupRemoteFeedListener();
  if (!boundHandlers) return;
  try {
    call.off(CallEvent.State, boundHandlers.onState);
    call.off(CallEvent.FeedsChanged, boundHandlers.onFeeds);
    call.off(CallEvent.Hangup, boundHandlers.onHangup);
    call.off(CallEvent.Error, boundHandlers.onError);
  } catch { /* ignore */ }
  boundHandlers = null;
}

function wireCallEvents(call: MatrixCall, direction: "outgoing" | "incoming") {
  // Defensive: remove any prior handlers first
  unwireCallEvents(call);

  const callStore = useCallStore();

  const onState = ((newState: SDKCallState, _oldState: SDKCallState) => {
    console.log("[call-service] state:", _oldState, "→", newState);
    const status = mapSDKState(newState, direction);
    callStore.updateStatus(status);

    if (status === CallStatus.connected) {
      stopAllSounds();
      clearIncomingTimeout();
      callStore.startTimer();
      if (callStore.activeCall) {
        callStore.setActiveCall({
          ...callStore.activeCall,
          startedAt: Date.now(),
        });
      }
      updateFeeds(call);
      // Apply saved device preferences with {exact} constraint
      applySavedDevicesExact(call);
    }

    if (status === CallStatus.ended) {
      stopAllSounds();
      clearIncomingTimeout();
      playEndTone();
      callStore.stopTimer();
      unwireCallEvents(call);
      const activeCall = callStore.activeCall;
      if (activeCall) {
        const entry: CallHistoryEntry = {
          id: activeCall.callId,
          roomId: activeCall.roomId,
          peerId: activeCall.peerId,
          peerName: activeCall.peerName,
          type: activeCall.type,
          direction: activeCall.direction,
          status: activeCall.startedAt ? "answered" : "missed",
          startedAt: activeCall.startedAt ?? Date.now(),
          duration: callStore.callTimer,
        };
        callStore.addHistoryEntry(entry);
      }
      callStore.scheduleClearCall(1500);
    }
  }) as CallEventHandlerMap[CallEvent.State];

  const onFeeds = (() => {
    console.log("[call-service] feeds changed");
    updateFeeds(call);
  }) as CallEventHandlerMap[CallEvent.FeedsChanged];

  const onHangup = (() => {
    console.log("[call-service] hangup event");
    stopAllSounds();
    clearIncomingTimeout();
  }) as CallEventHandlerMap[CallEvent.Hangup];

  const onError = ((error: unknown) => {
    console.error("[call-service] call error:", error);
    stopAllSounds();
    clearIncomingTimeout();
    unwireCallEvents(call);
    callStore.updateStatus(CallStatus.failed);
    const activeCall = callStore.activeCall;
    if (activeCall) {
      callStore.addHistoryEntry({
        id: activeCall.callId,
        roomId: activeCall.roomId,
        peerId: activeCall.peerId,
        peerName: activeCall.peerName,
        type: activeCall.type,
        direction: activeCall.direction,
        status: "failed",
        startedAt: activeCall.startedAt ?? Date.now(),
        duration: callStore.callTimer,
      });
    }
    callStore.scheduleClearCall(2000);
  }) as CallEventHandlerMap[CallEvent.Error];

  boundHandlers = { onState, onFeeds, onHangup, onError };
  call.on(CallEvent.State, onState);
  call.on(CallEvent.FeedsChanged, onFeeds);
  call.on(CallEvent.Hangup, onHangup);
  call.on(CallEvent.Error, onError);
}

// ---------------------------------------------------------------------------
// Incoming call timeout (#10)
// ---------------------------------------------------------------------------

let incomingTimeoutId: ReturnType<typeof setTimeout> | null = null;

function clearIncomingTimeout() {
  if (incomingTimeoutId !== null) {
    clearTimeout(incomingTimeoutId);
    incomingTimeoutId = null;
  }
}

// ---------------------------------------------------------------------------
// Device restore helper (#5)
// ---------------------------------------------------------------------------

/**
 * Lightweight: just store device IDs in mediaHandler so the SDK uses them
 * in its initial getUserMedia constraints. This is best-effort ({ideal}).
 * The real fix is applySavedDevicesExact() which runs after call connects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hintStoredDevices(client: any) {
  try {
    const mediaHandler = client?.getMediaHandler?.();
    if (!mediaHandler) return;
    const savedAudio = localStorage.getItem("bastyon_call_audio_device") ?? "";
    const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
    if (savedAudio || savedVideo) {
      console.log("[call-service] Hinting stored devices: audio=%s video=%s", savedAudio, savedVideo);
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
async function applySavedDevicesExact(call: MatrixCall) {
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
        console.log("[call-service] Post-connect: switching audio %s → %s", currentAudioId, savedAudio);
        await useCallService().setAudioDevice(savedAudio);
      }
    }

    // Check video
    if (savedVideo) {
      const currentVideoTrack = localStream.getVideoTracks()[0];
      if (currentVideoTrack) {
        const currentVideoId = currentVideoTrack.getSettings()?.deviceId ?? "";
        if (currentVideoId !== savedVideo) {
          console.log("[call-service] Post-connect: switching video %s → %s", currentVideoId, savedVideo);
          await useCallService().setVideoDevice(savedVideo);
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

function resolvePeerInfo(peerId: string): { peerAddress: string; peerName: string } {
  const peerAddress = matrixIdToAddress(peerId);
  const userStore = useUserStore();
  userStore.loadUserIfMissing(peerAddress);
  const user = userStore.getUser(peerAddress);
  return {
    peerAddress,
    peerName: user?.name || peerAddress,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getClient(): any {
  return getMatrixClientService().client;
}

// ---------------------------------------------------------------------------
// Toggle camera lock (#2)
// ---------------------------------------------------------------------------

let toggleCameraLock = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function useCallService() {
  const callStore = useCallStore();

  async function startCall(roomId: string, type: CallType) {
    if (callStore.isInCall) {
      console.warn("[call-service] Already in a call");
      return;
    }

    const otherTabActive = await checkOtherTabHasCall();
    if (otherTabActive) {
      console.warn("[call-service] Another tab already has an active call");
      return;
    }

    callStore.cancelScheduledClear();

    const matrixService = getMatrixClientService();
    const client = matrixService.client;
    if (!client) {
      console.error("[call-service] No Matrix client");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supportsVoip = (client as any).supportsVoip?.();
    console.log("[call-service] supportsVoip:", supportsVoip);
    if (!supportsVoip) {
      console.error("[call-service] VoIP not supported by client");
      return;
    }

    const call = createNewMatrixCall(client, roomId);
    if (!call) {
      console.error("[call-service] createNewMatrixCall returned null — WebRTC not available");
      return;
    }

    console.log("[call-service] Starting %s call in room %s, callId=%s", type, roomId, call.callId);

    const room = client.getRoom(roomId);
    const myUserId = matrixService.getUserId();
    const members: Array<{ userId: string }> = room?.getJoinedMembers() ?? [];
    const peer = members.find((m) => m.userId !== myUserId);
    const peerId = peer?.userId ?? "";
    const { peerAddress, peerName } = resolvePeerInfo(peerId);

    const callInfo: CallInfo = {
      callId: call.callId,
      roomId,
      peerId,
      peerAddress,
      peerName,
      type,
      direction: "outgoing",
      status: CallStatus.ringing,
      startedAt: null,
      endedAt: null,
    };

    callStore.setActiveCall(callInfo);
    callStore.setMatrixCall(call);
    callStore.videoMuted = type === "voice";
    wireCallEvents(call, "outgoing");

    playDialtone();

    // Hint stored device IDs (lightweight, sync) — real fix is post-connect
    hintStoredDevices(client);

    try {
      if (type === "video") {
        await call.placeVideoCall();
      } else {
        await call.placeVoiceCall();
      }
      console.log("[call-service] Call placed successfully");
    } catch (e) {
      console.error("[call-service] Failed to place call:", e);
      stopAllSounds();
      unwireCallEvents(call);
      callStore.updateStatus(CallStatus.failed);
      callStore.scheduleClearCall(2000);
    }
  }

  async function handleIncomingCall(matrixCall: MatrixCall) {
    console.log("[call-service] Incoming call, callId=%s, type=%s", matrixCall.callId, matrixCall.type);

    if (callStore.isInCall) {
      console.log("[call-service] Already in a call, rejecting incoming");
      matrixCall.reject();
      return;
    }

    const otherTabActive = await checkOtherTabHasCall();
    if (otherTabActive) {
      console.warn("[call-service] Another tab already has an active call, rejecting incoming");
      matrixCall.reject();
      return;
    }

    callStore.cancelScheduledClear();

    const peerId = matrixCall.getOpponentMember()?.userId ?? "";
    const { peerAddress, peerName } = resolvePeerInfo(peerId);
    const isVideo = matrixCall.type === "video";

    const callInfo: CallInfo = {
      callId: matrixCall.callId,
      roomId: matrixCall.roomId,
      peerId,
      peerAddress,
      peerName,
      type: isVideo ? "video" : "voice",
      direction: "incoming",
      status: CallStatus.incoming,
      startedAt: null,
      endedAt: null,
    };

    callStore.setActiveCall(callInfo);
    callStore.setMatrixCall(matrixCall);
    callStore.videoMuted = !isVideo;
    wireCallEvents(matrixCall, "incoming");

    playRingtone();

    // Auto-reject after 30s if still incoming (#10)
    clearIncomingTimeout();
    incomingTimeoutId = setTimeout(() => {
      incomingTimeoutId = null;
      if (callStore.activeCall?.status === CallStatus.incoming) {
        console.log("[call-service] Incoming call timeout — auto-rejecting");
        rejectCall();
      }
    }, 30_000);
  }

  async function answerCall() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    clearIncomingTimeout();
    stopAllSounds();
    callStore.updateStatus(CallStatus.connecting);

    // Hint stored device IDs (lightweight, sync) — real fix is post-connect
    const client = getClient();
    hintStoredDevices(client);

    const isVideo = callStore.activeCall?.type === "video";
    console.log("[call-service] Answering call, video=%s", isVideo);

    try {
      await call.answer(true, isVideo);
    } catch (e) {
      console.error("[call-service] Failed to answer call:", e);
      unwireCallEvents(call);
      callStore.updateStatus(CallStatus.failed);
      callStore.scheduleClearCall(2000);
    }
  }

  function rejectCall() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    console.log("[call-service] Rejecting call");
    clearIncomingTimeout();
    stopAllSounds();

    try {
      call.reject();
    } catch (e) {
      console.warn("[call-service] reject error:", e);
    }

    unwireCallEvents(call);

    if (callStore.activeCall) {
      callStore.addHistoryEntry({
        id: callStore.activeCall.callId,
        roomId: callStore.activeCall.roomId,
        peerId: callStore.activeCall.peerId,
        peerName: callStore.activeCall.peerName,
        type: callStore.activeCall.type,
        direction: callStore.activeCall.direction,
        status: "declined",
        startedAt: Date.now(),
        duration: 0,
      });
    }
    callStore.clearCall();
  }

  function hangup() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    console.log("[call-service] Hanging up");
    clearIncomingTimeout();
    stopAllSounds();

    try {
      call.hangup(CallErrorCode.UserHangup, false);
    } catch (e) {
      console.warn("[call-service] hangup error:", e);
    }

    // Fallback cleanup if SDK doesn't fire Ended event (#11)
    callStore.scheduleClearCall(3000);
  }

  async function toggleMute() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    try {
      const muted = call.isMicrophoneMuted();
      console.log("[call-service] toggleMute: %s → %s", muted ? "muted" : "unmuted", !muted ? "muted" : "unmuted");
      await call.setMicrophoneMuted(!muted);
      callStore.audioMuted = !muted;
    } catch (e) {
      console.error("[call-service] toggleMute error:", e);
    }
  }

  /** Toggle camera — trust SDK, single setLocalVideoMuted call (#2) */
  async function toggleCamera() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    if (toggleCameraLock) {
      console.warn("[call-service] toggleCamera already in progress");
      return;
    }
    toggleCameraLock = true;

    try {
      const wantMuted = !callStore.videoMuted;
      console.log("[call-service] toggleCamera → %s", wantMuted ? "off" : "on");

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
            console.log("[call-service] toggleCamera: re-applying saved video device %s → %s", currentId, savedVideo);
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

  async function toggleScreenShare() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    try {
      const wasEnabled = callStore.screenSharing;
      console.log("[call-service] toggleScreenShare: %s → %s", wasEnabled, !wasEnabled);
      const newState = await call.setScreensharingEnabled(!wasEnabled);
      // setScreensharingEnabled returns the actual new state (true=sharing, false=not)
      callStore.screenSharing = newState;
      updateFeeds(call);
      console.log("[call-service] screenSharing state now:", newState);
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
  async function setAudioDevice(deviceId: string) {
    try {
      const call = callStore.matrixCall as MatrixCall | null;
      if (!call) return;

      console.log("[call-service] Setting audio device (exact):", deviceId);

      // 1. Acquire new track with {exact} constraint
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      });
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) {
        console.error("[call-service] setAudioDevice: no audio track obtained");
        return;
      }

      // 2. Replace track on the WebRTC sender
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pc: RTCPeerConnection | undefined = (call as any).peerConn;
      if (pc) {
        const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (audioSender) {
          await audioSender.replaceTrack(newTrack);
          console.log("[call-service] Audio sender track replaced");
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
  async function setVideoDevice(deviceId: string) {
    try {
      const call = callStore.matrixCall as MatrixCall | null;
      if (!call) return;

      console.log("[call-service] Setting video device (exact):", deviceId);

      // 1. Acquire new track with {exact} constraint
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) {
        console.error("[call-service] setVideoDevice: no video track obtained");
        return;
      }

      // 2. Replace track on the WebRTC sender
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pc: RTCPeerConnection | undefined = (call as any).peerConn;
      if (pc) {
        const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (videoSender) {
          await videoSender.replaceTrack(newTrack);
          console.log("[call-service] Video sender track replaced");
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

  return {
    startCall,
    handleIncomingCall,
    answerCall,
    rejectCall,
    hangup,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    setAudioDevice,
    setVideoDevice,
  };
}
