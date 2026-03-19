import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

// ---------------------------------------------------------------------------
// Plugin interface — matches WebRTCPlugin.kt @PluginMethod signatures
// ---------------------------------------------------------------------------

export interface NativeWebRTCPlugin {
  createPeerConnection(options: {
    iceServers: Array<{
      urls: string | string[];
      username?: string;
      credential?: string;
    }>;
  }): Promise<void>;

  createOffer(): Promise<{ sdp: string; type: string }>;
  createAnswer(): Promise<{ sdp: string; type: string }>;

  setLocalDescription(options: {
    sdp: string;
    type: string;
  }): Promise<void>;

  setRemoteDescription(options: {
    sdp: string;
    type: string;
  }): Promise<void>;

  addIceCandidate(options: {
    candidate: string;
    sdpMid: string;
    sdpMLineIndex: number;
  }): Promise<void>;

  startLocalMedia(options: { hasVideo: boolean }): Promise<void>;
  setAudioEnabled(options: { enabled: boolean }): Promise<void>;
  setVideoEnabled(options: { enabled: boolean }): Promise<void>;
  switchCamera(): Promise<void>;

  startScreenShare(): Promise<{ sharing: boolean }>;
  stopScreenShare(): Promise<{ sharing: boolean }>;

  closePeerConnection(): Promise<void>;
  getConnectionState(): Promise<{ state: string }>;

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

  // Events from native → JS
  addListener(
    event: "onIceCandidate",
    handler: (data: {
      candidate: string;
      sdpMid: string;
      sdpMLineIndex: number;
    }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onIceConnectionStateChange",
    handler: (data: { state: string }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onTrack",
    handler: (data: { kind: string; trackId: string }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onRemoveTrack",
    handler: () => void
  ): Promise<PluginListenerHandle>;

  addListener(
    event: "onRenegotiationNeeded",
    handler: () => void
  ): Promise<PluginListenerHandle>;
}

export const NativeWebRTC =
  registerPlugin<NativeWebRTCPlugin>("NativeWebRTC");
