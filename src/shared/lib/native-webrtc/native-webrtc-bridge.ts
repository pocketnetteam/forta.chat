import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

// ---------------------------------------------------------------------------
// Plugin interface — matches WebRTCPlugin.kt @PluginMethod signatures
// All methods include peerId to support multiple concurrent PeerConnections
// ---------------------------------------------------------------------------

export interface NativeWebRTCPlugin {
  createPeerConnection(options: {
    peerId: string;
    iceServers: Array<{
      urls: string | string[];
      username?: string;
      credential?: string;
    }>;
    iceTransportPolicy?: string;
  }): Promise<void>;

  createOffer(options: { peerId: string }): Promise<{ sdp: string; type: string }>;
  createAnswer(options: { peerId: string }): Promise<{ sdp: string; type: string }>;

  setLocalDescription(options: {
    peerId: string;
    sdp: string;
    type: string;
  }): Promise<void>;

  setRemoteDescription(options: {
    peerId: string;
    sdp: string;
    type: string;
  }): Promise<void>;

  addIceCandidate(options: {
    peerId: string;
    candidate: string;
    sdpMid: string;
    sdpMLineIndex: number;
  }): Promise<void>;

  startLocalMedia(options: { peerId?: string; hasVideo: boolean }): Promise<void>;
  setAudioEnabled(options: { enabled: boolean }): Promise<void>;
  setVideoEnabled(options: { enabled: boolean }): Promise<void>;
  switchCamera(): Promise<void>;

  startScreenShare(): Promise<{ sharing: boolean }>;
  stopScreenShare(): Promise<{ sharing: boolean }>;

  closePeerConnection(options: { peerId: string }): Promise<void>;
  getConnectionState(options: { peerId: string }): Promise<{ state: string }>;

  // ICE restart — perform a native ICE restart on the given PeerConnection.
  // The JS SDK calls `pc.restartIce()` on network flips (WiFi ↔ cellular),
  // on ICE disconnected/failed, or during glare resolution. Previously this
  // was a JS no-op and native never received the signal, so calls dropped
  // permanently on any jitter. Now this path is wired through to
  // PeerConnection.restartIce() (API 28+) with a createOffer({IceRestart:true})
  // fallback on older Android.
  restartIce(options: { peerId: string }): Promise<void>;

  // Return native WebRTC stats for this PeerConnection as a flat map of
  // stats-object-id → stats object. Consumed by the SDK's diagnostics and
  // by our own webrtc-diagnostics to detect zero-audio / zero-video.
  // Previously returned an empty Map unconditionally, causing false
  // ZERO_AUDIO_ALERT and preventing the SDK from confirming media flow.
  getStats(options: { peerId: string }): Promise<{
    report: Record<string, Record<string, unknown>>;
  }>;

  // Remote video state
  updateRemoteVideoState(options: { muted: boolean }): Promise<void>;

  // Native Call UI
  launchCallUI(options: {
    callerName: string;
    callType: string;
    callId: string;
    direction: string;
  }): Promise<void>;
  dismissCallUI(): Promise<void>;
  updateCallStatus(options: {
    status: string;
    duration: string;
  }): Promise<void>;

  // Events from native → JS (include peerId for routing)
  addListener(
    event: "onIceCandidate",
    handler: (data: {
      peerId: string;
      candidate: string;
      sdpMid: string;
      sdpMLineIndex: number;
    }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onIceConnectionStateChange",
    handler: (data: { peerId: string; state: string }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onTrack",
    handler: (data: { peerId: string; kind: string; trackId: string; streamId: string }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onRemoveTrack",
    handler: (data: { peerId: string }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onRenegotiationNeeded",
    handler: (data: { peerId: string }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onNativeHangup",
    handler: (data: Record<string, never>) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onNativeVideoToggle",
    handler: (data: { enabled: boolean }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onAudioError",
    handler: (data: {
      type: 'permission_denied' | 'audio_source_failed' | 'focus_lost';
      message: string;
    }) => void
  ): Promise<PluginListenerHandle>;
}

export const NativeWebRTC =
  registerPlugin<NativeWebRTCPlugin>("NativeWebRTC");
