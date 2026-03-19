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
}

export const NativeWebRTC =
  registerPlugin<NativeWebRTCPlugin>("NativeWebRTC");
