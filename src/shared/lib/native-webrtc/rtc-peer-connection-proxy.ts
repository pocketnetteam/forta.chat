/**
 * RTCPeerConnection proxy for native WebRTC.
 *
 * Replaces `window.RTCPeerConnection` so that matrix-js-sdk-bastyon
 * transparently uses the native WebRTC engine instead of the browser's.
 *
 * The proxy implements the subset of the RTCPeerConnection API that the
 * Matrix SDK actually uses. All SDP/ICE operations are forwarded to the
 * native Capacitor plugin.
 */

import { NativeWebRTC } from "./native-webrtc-bridge";
import type { PluginListenerHandle } from "@capacitor/core";

// Save original for fallback / non-call usage
const OriginalRTCPeerConnection = window.RTCPeerConnection;

// ICE connection state mapping: native string → RTCIceConnectionState
const ICE_STATE_MAP: Record<string, RTCIceConnectionState> = {
  new: "new",
  checking: "checking",
  connected: "connected",
  completed: "completed",
  failed: "failed",
  disconnected: "disconnected",
  closed: "closed",
};

/**
 * A proxy RTCPeerConnection that routes all WebRTC operations to the
 * native Android layer via Capacitor bridge.
 */
class NativeRTCPeerConnection extends EventTarget implements Partial<RTCPeerConnection> {
  // State
  private _iceConnectionState: RTCIceConnectionState = "new";
  private _connectionState: RTCPeerConnectionState = "new";
  private _signalingState: RTCSignalingState = "stable";
  private _localDescription: RTCSessionDescription | null = null;
  private _remoteDescription: RTCSessionDescription | null = null;

  // Callback-style event handlers (SDK uses these)
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => void) | null = null;
  oniceconnectionstatechange: ((ev: Event) => void) | null = null;
  onconnectionstatechange: ((ev: Event) => void) | null = null;
  ontrack: ((ev: RTCTrackEvent) => void) | null = null;
  onnegotiationneeded: ((ev: Event) => void) | null = null;
  onsignalingstatechange: ((ev: Event) => void) | null = null;
  onicegatheringstatechange: ((ev: Event) => void) | null = null;
  ondatachannel: ((ev: RTCDataChannelEvent) => void) | null = null;

  private listeners: PluginListenerHandle[] = [];
  private _closed = false;

  constructor(config?: RTCConfiguration) {
    super();
    this._initNative(config);
  }

  private async _initNative(config?: RTCConfiguration) {
    try {
      // Convert RTCConfiguration ice servers to plugin format
      const iceServers = (config?.iceServers ?? []).map((s) => ({
        urls: s.urls as string | string[],
        username: s.username,
        credential: s.credential as string | undefined,
      }));

      await NativeWebRTC.createPeerConnection({ iceServers });

      // Wire native events
      this.listeners.push(
        await NativeWebRTC.addListener("onIceCandidate", (data) => {
          const candidate = new RTCIceCandidate({
            candidate: data.candidate,
            sdpMid: data.sdpMid,
            sdpMLineIndex: data.sdpMLineIndex,
          });
          const event = new RTCPeerConnectionIceEvent("icecandidate", {
            candidate,
          });
          this.onicecandidate?.(event);
          this.dispatchEvent(event);
        })
      );

      this.listeners.push(
        await NativeWebRTC.addListener(
          "onIceConnectionStateChange",
          (data) => {
            this._iceConnectionState =
              ICE_STATE_MAP[data.state] ?? "new";
            const event = new Event("iceconnectionstatechange");
            this.oniceconnectionstatechange?.(event);
            this.dispatchEvent(event);
          }
        )
      );

      this.listeners.push(
        await NativeWebRTC.addListener("onTrack", (data) => {
          // Create a minimal RTCTrackEvent-like object
          // The SDK primarily checks event.track.kind
          const trackEvent = new Event("track") as any;
          trackEvent.track = { kind: data.kind, id: data.trackId };
          trackEvent.streams = [];
          this.ontrack?.(trackEvent);
          this.dispatchEvent(trackEvent);
        })
      );

      this.listeners.push(
        await NativeWebRTC.addListener("onRenegotiationNeeded", () => {
          const event = new Event("negotiationneeded");
          this.onnegotiationneeded?.(event);
          this.dispatchEvent(event);
        })
      );

      console.log("[NativeRTCProxy] Initialized with native WebRTC");
    } catch (e) {
      console.error("[NativeRTCProxy] Failed to initialize:", e);
    }
  }

  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  get iceConnectionState(): RTCIceConnectionState {
    return this._iceConnectionState;
  }
  get connectionState(): RTCPeerConnectionState {
    return this._connectionState;
  }
  get signalingState(): RTCSignalingState {
    return this._signalingState;
  }
  get localDescription(): RTCSessionDescription | null {
    return this._localDescription;
  }
  get remoteDescription(): RTCSessionDescription | null {
    return this._remoteDescription;
  }
  get currentLocalDescription(): RTCSessionDescription | null {
    return this._localDescription;
  }
  get currentRemoteDescription(): RTCSessionDescription | null {
    return this._remoteDescription;
  }

  // -----------------------------------------------------------------------
  // SDP
  // -----------------------------------------------------------------------

  async createOffer(
    _options?: RTCOfferOptions
  ): Promise<RTCSessionDescriptionInit> {
    const result = await NativeWebRTC.createOffer();
    return { sdp: result.sdp, type: result.type as RTCSdpType };
  }

  async createAnswer(
    _options?: RTCAnswerOptions
  ): Promise<RTCSessionDescriptionInit> {
    const result = await NativeWebRTC.createAnswer();
    return { sdp: result.sdp, type: result.type as RTCSdpType };
  }

  async setLocalDescription(
    desc: RTCSessionDescriptionInit
  ): Promise<void> {
    await NativeWebRTC.setLocalDescription({
      sdp: desc.sdp ?? "",
      type: desc.type ?? "offer",
    });
    this._localDescription = new RTCSessionDescription(desc);
    this._updateSignalingState();
  }

  async setRemoteDescription(
    desc: RTCSessionDescriptionInit
  ): Promise<void> {
    await NativeWebRTC.setRemoteDescription({
      sdp: desc.sdp ?? "",
      type: desc.type ?? "answer",
    });
    this._remoteDescription = new RTCSessionDescription(desc);
    this._updateSignalingState();
  }

  async addIceCandidate(
    candidate?: RTCIceCandidateInit | RTCIceCandidate
  ): Promise<void> {
    if (!candidate || !candidate.candidate) return;
    await NativeWebRTC.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? "",
      sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
    });
  }

  // -----------------------------------------------------------------------
  // Tracks — Matrix SDK calls addTrack, but native handles media directly.
  // We return a stub sender so the SDK doesn't crash.
  // -----------------------------------------------------------------------

  private _senders: RTCRtpSender[] = [];

  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
    // Native side manages its own tracks; return stub sender
    const sender = {
      track,
      dtmf: null,
      transport: null,
      replaceTrack: async () => {},
      getParameters: () => ({
        codecs: [],
        headerExtensions: [],
        rtcp: { cname: "", reducedSize: false },
        transactionId: "",
        encodings: [],
        degradationPreference: undefined,
      }),
      setParameters: async (p: RTCRtpSendParameters) => p,
      getStats: async () => new Map() as any,
      setStreams: () => {},
    } as unknown as RTCRtpSender;
    this._senders.push(sender);
    return sender;
  }

  removeTrack(_sender: RTCRtpSender): void {
    this._senders = this._senders.filter((s) => s !== _sender);
  }

  getSenders(): RTCRtpSender[] {
    return this._senders;
  }

  getReceivers(): RTCRtpReceiver[] {
    return [];
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return [];
  }

  addTransceiver(): RTCRtpTransceiver {
    return {} as RTCRtpTransceiver;
  }

  // -----------------------------------------------------------------------
  // Data channels (SDK may probe for this)
  // -----------------------------------------------------------------------

  createDataChannel(
    label: string,
    _options?: RTCDataChannelInit
  ): RTCDataChannel {
    return {} as RTCDataChannel;
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  async getStats(): Promise<RTCStatsReport> {
    return new Map() as any;
  }

  // -----------------------------------------------------------------------
  // Close
  // -----------------------------------------------------------------------

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._iceConnectionState = "closed";
    this._connectionState = "closed";
    this._signalingState = "closed";

    NativeWebRTC.closePeerConnection().catch(() => {});

    // Remove all native listeners
    for (const handle of this.listeners) {
      handle.remove();
    }
    this.listeners = [];
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private _updateSignalingState() {
    const hadLocal = this._localDescription !== null;
    const hadRemote = this._remoteDescription !== null;
    if (hadLocal && hadRemote) {
      this._signalingState = "stable";
    } else if (hadLocal) {
      this._signalingState = "have-local-offer";
    } else if (hadRemote) {
      this._signalingState = "have-remote-offer";
    }
    this.onsignalingstatechange?.(new Event("signalingstatechange"));
  }
}

// ---------------------------------------------------------------------------
// getUserMedia proxy — returns a dummy stream on native; real media is native
// ---------------------------------------------------------------------------

const originalGetUserMedia =
  navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);

async function nativeGetUserMedia(
  constraints?: MediaStreamConstraints
): Promise<MediaStream> {
  // Start native media capture
  const hasVideo = !!constraints?.video;
  await NativeWebRTC.startLocalMedia({ hasVideo });

  // Return an empty MediaStream — the SDK needs a stream object
  // but actual media flows through native renderers, not <video> tags
  const stream = new MediaStream();
  return stream;
}

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

let installed = false;

/**
 * Install the native WebRTC proxy.
 * After calling this, any new RTCPeerConnection will use the native engine.
 */
export function installNativeWebRTCProxy(): void {
  if (installed) return;

  (window as any).RTCPeerConnection = NativeRTCPeerConnection as any;
  (window as any).webkitRTCPeerConnection = NativeRTCPeerConnection as any;

  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = nativeGetUserMedia;
  }

  installed = true;
  console.log("[NativeRTCProxy] Installed — WebRTC routed to native");
}

/**
 * Uninstall the proxy and restore browser WebRTC.
 */
export function uninstallNativeWebRTCProxy(): void {
  if (!installed) return;

  (window as any).RTCPeerConnection = OriginalRTCPeerConnection;
  (window as any).webkitRTCPeerConnection = OriginalRTCPeerConnection;

  if (navigator.mediaDevices && originalGetUserMedia) {
    navigator.mediaDevices.getUserMedia = originalGetUserMedia;
  }

  installed = false;
  console.log("[NativeRTCProxy] Uninstalled — WebRTC restored to browser");
}

export function isNativeWebRTCInstalled(): boolean {
  return installed;
}
