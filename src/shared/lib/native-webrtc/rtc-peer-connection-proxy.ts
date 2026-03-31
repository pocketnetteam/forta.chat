/**
 * RTCPeerConnection proxy for native WebRTC.
 *
 * Replaces `window.RTCPeerConnection` so that matrix-js-sdk-bastyon
 * transparently uses the native Android/iOS WebRTC engine instead of the
 * browser's.
 *
 * Key design:
 * 1. Each instance gets a unique peerId so multiple PeerConnections
 *    can coexist (SDK creates several during call setup / glare).
 * 2. The native peer connection is created asynchronously via the
 *    Capacitor bridge — all async methods await `_ready` first.
 * 3. Native events include peerId — each proxy filters for its own.
 */

import { NativeWebRTC } from "./native-webrtc-bridge";
import type { PluginListenerHandle } from "@capacitor/core";

// Save original for fallback / non-call usage
const OriginalRTCPeerConnection = window.RTCPeerConnection;

let peerIdCounter = 0;

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

class NativeRTCPeerConnection extends EventTarget {
  // Manual event listener tracking — EventTarget.dispatchEvent may not
  // work correctly in Capacitor WebView for custom classes
  private _eventHandlers: Map<string, Set<EventListenerOrEventListenerObject>> = new Map();

  addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, _options?: boolean | AddEventListenerOptions): void {
    if (!callback) return;
    if (!this._eventHandlers.has(type)) {
      this._eventHandlers.set(type, new Set());
    }
    this._eventHandlers.get(type)!.add(callback);
    super.addEventListener(type, callback, _options);
  }

  removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, _options?: boolean | EventListenerOptions): void {
    if (!callback) return;
    this._eventHandlers.get(type)?.delete(callback);
    super.removeEventListener(type, callback, _options);
  }

  private _fireEvent(event: Event): void {
    const handlers = this._eventHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          if (typeof handler === "function") {
            handler(event);
          } else {
            handler.handleEvent(event);
          }
        } catch (e) {
          console.error("[NativeRTCProxy] event handler error:", e);
        }
      }
    }
  }

  // Unique ID for this peer connection instance
  private _peerId: string;

  // Readiness gate — all async methods await this before calling native
  private _ready: Promise<void>;
  private _resolveReady!: () => void;
  private _initError: Error | null = null;

  // State
  private _iceGatheringState: RTCIceGatheringState = "new";
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
  private _iceGatheringTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: RTCConfiguration) {
    super();
    this._peerId = `pc_${++peerIdCounter}_${Date.now()}`;
    this._ready = new Promise<void>((resolve) => {
      this._resolveReady = resolve;
    });
    this._initNative(config);
  }

  private async _initNative(config?: RTCConfiguration) {
    try {
      const iceServers = (config?.iceServers ?? []).map((s) => ({
        urls: s.urls as string | string[],
        username: s.username,
        credential: s.credential as string | undefined,
      }));

      await NativeWebRTC.createPeerConnection({
        peerId: this._peerId,
        iceServers,
      });

      // Wire native events BEFORE resolving ready
      // Each handler filters by peerId so events from other PCs are ignored
      this.listeners.push(
        await NativeWebRTC.addListener("onIceCandidate", (data) => {
          if (this._closed || data.peerId !== this._peerId) return;

          // Track ICE gathering state
          if (this._iceGatheringState !== "gathering") {
            this._iceGatheringState = "gathering";
            this.onicegatheringstatechange?.(new Event("icegatheringstatechange"));
            this._fireEvent(new Event("icegatheringstatechange"));
          }

          const candidate = new RTCIceCandidate({
            candidate: data.candidate,
            sdpMid: data.sdpMid,
            sdpMLineIndex: data.sdpMLineIndex,
          });
          const event = new RTCPeerConnectionIceEvent("icecandidate", {
            candidate,
          });
          this.onicecandidate?.(event);
          this._fireEvent(event);

          // Schedule end-of-candidates after last candidate (reset on each new one)
          if (this._iceGatheringTimer) clearTimeout(this._iceGatheringTimer);
          this._iceGatheringTimer = setTimeout(() => {
            if (this._closed) return;
            this._iceGatheringState = "complete";
            // null candidate signals end-of-candidates
            const endEvent = new RTCPeerConnectionIceEvent("icecandidate", { candidate: null });
            this.onicecandidate?.(endEvent);
            this._fireEvent(endEvent);
            this.onicegatheringstatechange?.(new Event("icegatheringstatechange"));
            this._fireEvent(new Event("icegatheringstatechange"));
          }, 500);
        })
      );

      this.listeners.push(
        await NativeWebRTC.addListener(
          "onIceConnectionStateChange",
          (data) => {
            if (this._closed || data.peerId !== this._peerId) return;
            this._iceConnectionState =
              ICE_STATE_MAP[data.state] ?? "new";
            // Map to connection state too
            if (data.state === "connected" || data.state === "completed") {
              this._connectionState = "connected";
            } else if (data.state === "failed") {
              this._connectionState = "failed";
            } else if (data.state === "disconnected") {
              this._connectionState = "disconnected";
            } else if (data.state === "closed") {
              this._connectionState = "closed";
            }
            const event = new Event("iceconnectionstatechange");
            this.oniceconnectionstatechange?.(event);
            this._fireEvent(event);
            const connEvent = new Event("connectionstatechange");
            this.onconnectionstatechange?.(connEvent);
            this._fireEvent(connEvent);
          }
        )
      );

      this.listeners.push(
        await NativeWebRTC.addListener("onTrack", (data) => {
          if (this._closed || data.peerId !== this._peerId) return;
          console.log("[NativeRTCProxy] onTrack received:", data.kind,
            "streamId:", data.streamId, "trackId:", data.trackId);

          // Create a MediaStream with the correct stream ID from the SDP.
          // The SDK looks up remoteSDPStreamMetadata[stream.id] so the
          // id MUST match the msid from the remote SDP.
          let stream: MediaStream;
          let track: MediaStreamTrack | undefined;

          try {
            // Create dummy track first
            if (data.kind === "video") {
              const canvas = document.createElement("canvas");
              canvas.width = 1;
              canvas.height = 1;
              const cs = canvas.captureStream(0);
              track = cs.getVideoTracks()[0];
            } else {
              try {
                const ctx = new AudioContext();
                const osc = ctx.createOscillator();
                const dest = ctx.createMediaStreamDestination();
                osc.connect(dest);
                osc.start();
                track = dest.stream.getAudioTracks()[0];
                if (track) track.enabled = false;
              } catch {
                const canvas = document.createElement("canvas");
                canvas.width = 1;
                canvas.height = 1;
                const cs = canvas.captureStream(0);
                track = cs.getVideoTracks()[0];
              }
            }

            // Create stream with the remote SDP's stream ID
            // MediaStream constructor with existing tracks
            stream = new MediaStream(track ? [track] : []);

            // Override the stream id to match remote SDP's msid
            // The SDK does: this.remoteSDPStreamMetadata![stream.id].purpose
            if (data.streamId) {
              Object.defineProperty(stream, "id", {
                value: data.streamId,
                writable: false,
              });
            }
          } catch (err) {
            console.error("[NativeRTCProxy] onTrack: failed to create track:", err);
            stream = new MediaStream();
          }

          console.log("[NativeRTCProxy] onTrack: stream.id:", stream.id,
            "tracks:", stream.getTracks().length);

          const trackObj = track ?? ({ kind: data.kind, id: data.trackId } as any);
          const trackEvent = new Event("track") as any;
          trackEvent.track = trackObj;
          trackEvent.streams = [stream];
          trackEvent.receiver = { track: trackObj };
          trackEvent.transceiver = { receiver: trackEvent.receiver };
          this.ontrack?.(trackEvent);
          this._fireEvent(trackEvent);
        })
      );

      this.listeners.push(
        await NativeWebRTC.addListener("onRenegotiationNeeded", (data) => {
          if (this._closed || data.peerId !== this._peerId) return;
          const event = new Event("negotiationneeded");
          this.onnegotiationneeded?.(event);
          this._fireEvent(event);
        })
      );

      console.log("[NativeRTCProxy] Native PeerConnection ready, peerId:", this._peerId);
      this._resolveReady();
    } catch (e) {
      console.error("[NativeRTCProxy] Failed to initialize:", e);
      this._initError = e as Error;
      this._resolveReady(); // resolve anyway so methods don't hang forever
    }
  }

  /** Wait for native PC to be ready. Throws if init failed. */
  private async _waitReady(): Promise<void> {
    await this._ready;
    if (this._initError) {
      throw this._initError;
    }
  }

  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  get iceGatheringState(): RTCIceGatheringState {
    return this._iceGatheringState;
  }
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
  // SDP — all await _waitReady() before calling native
  // -----------------------------------------------------------------------

  async createOffer(
    _options?: RTCOfferOptions
  ): Promise<RTCSessionDescriptionInit> {
    await this._waitReady();
    console.log("[NativeRTCProxy] createOffer, peerId:", this._peerId);
    const result = await NativeWebRTC.createOffer({ peerId: this._peerId });
    // Sync local dummy stream IDs to match native SDP msid so that
    // the SDK's sdp_stream_metadata keys match the SDP. We do NOT
    // rewrite the SDP — native must receive its own unmodified SDP.
    this._syncLocalStreamIds(result.sdp);
    console.log("[NativeRTCProxy] createOffer result:", result.type, result.sdp?.substring(0, 80));
    return { sdp: result.sdp, type: result.type as RTCSdpType };
  }

  async createAnswer(
    _options?: RTCAnswerOptions
  ): Promise<RTCSessionDescriptionInit> {
    await this._waitReady();
    console.log("[NativeRTCProxy] createAnswer, peerId:", this._peerId);
    const result = await NativeWebRTC.createAnswer({ peerId: this._peerId });
    this._syncLocalStreamIds(result.sdp);
    console.log("[NativeRTCProxy] createAnswer result:", result.type, result.sdp?.substring(0, 80));
    return { sdp: result.sdp, type: result.type as RTCSdpType };
  }

  async setLocalDescription(
    desc: RTCSessionDescriptionInit
  ): Promise<void> {
    await this._waitReady();
    console.log("[NativeRTCProxy] setLocalDescription:", desc.type, "peerId:", this._peerId);
    await NativeWebRTC.setLocalDescription({
      peerId: this._peerId,
      sdp: desc.sdp ?? "",
      type: desc.type ?? "offer",
    });
    this._localDescription = new RTCSessionDescription(desc);
    this._updateSignalingState();
  }

  async setRemoteDescription(
    desc: RTCSessionDescriptionInit
  ): Promise<void> {
    await this._waitReady();
    console.log("[NativeRTCProxy] setRemoteDescription:", desc.type, "peerId:", this._peerId);
    await NativeWebRTC.setRemoteDescription({
      peerId: this._peerId,
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
    await this._waitReady();
    await NativeWebRTC.addIceCandidate({
      peerId: this._peerId,
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? "",
      sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
    });
  }

  // -----------------------------------------------------------------------
  // Tracks — return stub senders so the SDK doesn't crash.
  // Native side manages real media tracks independently.
  // -----------------------------------------------------------------------

  private _senders: RTCRtpSender[] = [];
  private _localStreams: MediaStream[] = [];

  addTrack(track: MediaStreamTrack, ..._streams: MediaStream[]): RTCRtpSender {
    // Save reference to local streams for SDP msid rewriting
    for (const s of _streams) {
      if (!this._localStreams.find((ls) => ls.id === s.id)) {
        this._localStreams.push(s);
      }
    }

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

    // Fire negotiationneeded for:
    // 1. Outgoing calls (no remote description yet) — initial setup
    // 2. Mid-call track additions (ICE already connected) — e.g. voice→video upgrade
    // Skip ONLY during incoming call setup (remote description set but ICE not yet connected)
    // to avoid unwanted renegotiation that breaks ICE establishment.
    queueMicrotask(() => {
      if (this._closed) return;
      const iceConnected = this._iceConnectionState === "connected" || this._iceConnectionState === "completed";
      if (this._remoteDescription && !iceConnected) {
        console.log("[NativeRTCProxy] addTrack: skipping negotiationneeded (answering, ICE not yet connected)");
        return;
      }
      console.log(`[NativeRTCProxy] addTrack: firing negotiationneeded (iceState=${this._iceConnectionState})`);
      const event = new Event("negotiationneeded");
      this.onnegotiationneeded?.(event);
      this._fireEvent(event);
    });

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

  restartIce(): void {
    console.log("[NativeRTCProxy] restartIce (no-op — native handles ICE)");
  }

  // -----------------------------------------------------------------------
  // Data channels
  // -----------------------------------------------------------------------

  createDataChannel(
    _label: string,
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
    if (this._iceGatheringTimer) clearTimeout(this._iceGatheringTimer);

    console.log("[NativeRTCProxy] close, peerId:", this._peerId);
    NativeWebRTC.closePeerConnection({ peerId: this._peerId }).catch(() => {});

    for (const handle of this.listeners) {
      handle.remove();
    }
    this.listeners = [];
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Override local dummy MediaStream IDs to match the native SDP's msid.
   * Instead of rewriting the SDP (which breaks native setLocalDescription),
   * we change the dummy stream IDs so the SDK's sdp_stream_metadata keys
   * match what's in the SDP. The remote peer's browser will create streams
   * with IDs from the SDP msid, and the metadata keys will match.
   */
  private _syncLocalStreamIds(sdp: string): void {
    if (!sdp || this._localStreams.length === 0) return;

    // Extract native stream IDs from a=msid:<streamId> <trackId>
    const msidLineRegex = /a=msid:(\S+)\s+\S+/g;
    const nativeStreamIds: string[] = [];
    let match;
    while ((match = msidLineRegex.exec(sdp)) !== null) {
      if (!nativeStreamIds.includes(match[1])) {
        nativeStreamIds.push(match[1]);
      }
    }

    if (nativeStreamIds.length === 0) return;

    // Override each dummy stream's ID to match the native stream ID
    for (let i = 0; i < nativeStreamIds.length && i < this._localStreams.length; i++) {
      const dummyStream = this._localStreams[i];
      const nativeId = nativeStreamIds[i];
      if (dummyStream.id !== nativeId) {
        console.log(`[NativeRTCProxy] syncing local stream ID: ${dummyStream.id} → ${nativeId}`);
        Object.defineProperty(dummyStream, "id", {
          value: nativeId,
          writable: false,
          configurable: true,
        });
      }
    }
  }

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

// Captured lazily inside installNativeWebRTCProxy() when mediaDevices is confirmed present.
// Module-level capture is unreliable on Android WebView (mediaDevices may not exist yet).
let originalGetUserMedia: typeof navigator.mediaDevices.getUserMedia | undefined =
  navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);

/**
 * Returns the real browser getUserMedia, bypassing the native WebRTC proxy.
 * Use this in voice/video recorders that need actual media streams,
 * not the dummy streams returned by the proxy (which are for WebRTC calls only).
 */
export function getRealGetUserMedia(): typeof navigator.mediaDevices.getUserMedia | undefined {
  return originalGetUserMedia;
}

async function nativeGetUserMedia(
  constraints?: MediaStreamConstraints
): Promise<MediaStream> {
  const hasVideo = !!constraints?.video;
  console.log("[NativeRTCProxy] getUserMedia, video:", hasVideo);

  await NativeWebRTC.startLocalMedia({ hasVideo });

  // Return a MediaStream with dummy tracks so the SDK sees non-empty streams.
  // The SDK checks track count to determine if media is available.
  const stream = new MediaStream();

  // Create a dummy audio track via AudioContext
  try {
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    oscillator.connect(dest);
    oscillator.start();
    const audioTrack = dest.stream.getAudioTracks()[0];
    if (audioTrack) {
      // Mute it — real audio goes through native
      audioTrack.enabled = false;
      stream.addTrack(audioTrack);
    }
  } catch {
    // Fallback — SDK may still work without tracks
  }

  // Create a dummy video track via canvas if video requested
  if (hasVideo) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const canvasStream = canvas.captureStream(1);
      const videoTrack = canvasStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = false;
        stream.addTrack(videoTrack);
      }
    } catch {
      // Fallback
    }
  }

  console.log("[NativeRTCProxy] getUserMedia returning stream with", stream.getTracks().length, "tracks");
  return stream;
}

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

let installed = false;

export function installNativeWebRTCProxy(): void {
  if (installed) return;

  (window as any).RTCPeerConnection = NativeRTCPeerConnection as any;
  (window as any).webkitRTCPeerConnection = NativeRTCPeerConnection as any;

  if (navigator.mediaDevices) {
    // Capture real getUserMedia before replacing (in case module-level capture missed it)
    if (!originalGetUserMedia) {
      originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    }
    navigator.mediaDevices.getUserMedia = nativeGetUserMedia;
  }

  installed = true;
  console.log("[NativeRTCProxy] Installed — WebRTC routed to native");
}

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
