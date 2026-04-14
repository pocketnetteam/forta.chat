/**
 * WebRTC call diagnostics — polls getStats() every 3s to track
 * ICE state, audio/video byte counters, candidate types, and
 * detects zero-audio conditions for bug reports.
 */

interface DiagnosticEntry {
  timestamp: number;
  iceConnectionState: string;
  iceGatheringState: string;
  signalingState: string;
  connectionState: string;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  audioBytesSent: number;
  audioBytesReceived: number;
  audioPacketsSent: number;
  audioPacketsReceived: number;
  audioPacketsLost: number;
  audioJitter: number | null;
  audioRoundTripTime: number | null;
  videoBytesSent: number;
  videoBytesReceived: number;
  selectedCandidatePair: string | null;
  dtlsState: string | null;
}

const POLL_INTERVAL_MS = 3_000;
const MAX_ENTRIES = 200;
const ZERO_AUDIO_ALERT_THRESHOLD = 3; // 3 consecutive polls = 9s

class WebRTCDiagnostics {
  private entries: DiagnosticEntry[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pc: RTCPeerConnection | null = null;
  private prevAudioBytesSent = 0;
  private prevAudioBytesReceived = 0;
  private zeroSentStreak = 0;
  private zeroRecvStreak = 0;
  private iceCandidatesLog: string[] = [];

  // Save original handlers to chain them
  private origIceHandler: ((ev: Event) => void) | null = null;
  private origSigHandler: ((ev: Event) => void) | null = null;
  private origConnHandler: ((ev: Event) => void) | null = null;
  private origIceCandHandler: ((ev: RTCPeerConnectionIceEvent) => void) | null = null;

  attach(pc: RTCPeerConnection): void {
    this.detach();
    this.pc = pc;
    this.entries = [];
    this.prevAudioBytesSent = 0;
    this.prevAudioBytesReceived = 0;
    this.zeroSentStreak = 0;
    this.zeroRecvStreak = 0;
    this.iceCandidatesLog = [];

    // Chain state-change handlers
    this.origIceHandler = pc.oniceconnectionstatechange as ((ev: Event) => void) | null;
    pc.oniceconnectionstatechange = (ev: Event) => {
      console.warn(`[WebRTC-Diag] ICE connection: ${pc.iceConnectionState}`);
      this.origIceHandler?.call(pc, ev);
    };

    this.origSigHandler = pc.onsignalingstatechange as ((ev: Event) => void) | null;
    pc.onsignalingstatechange = (ev: Event) => {
      console.warn(`[WebRTC-Diag] Signaling: ${pc.signalingState}`);
      this.origSigHandler?.call(pc, ev);
    };

    this.origConnHandler = pc.onconnectionstatechange as ((ev: Event) => void) | null;
    pc.onconnectionstatechange = (ev: Event) => {
      console.warn(`[WebRTC-Diag] Connection: ${pc.connectionState}`);
      this.origConnHandler?.call(pc, ev);
    };

    // Log ICE candidates with type info
    this.origIceCandHandler = pc.onicecandidate as ((ev: RTCPeerConnectionIceEvent) => void) | null;
    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (ev.candidate) {
        const c = ev.candidate;
        const info = `${c.type ?? "?"} ${c.protocol ?? "?"} ${c.address ?? "?"}:${c.port ?? "?"} ${c.relatedAddress ? `relay-from=${c.relatedAddress}:${c.relatedPort}` : ""}`;
        this.iceCandidatesLog.push(info);
        console.warn(`[WebRTC-Diag] ICE candidate: ${info}`);
      }
      this.origIceCandHandler?.call(pc, ev);
    };

    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    console.warn("[WebRTC-Diag] Attached, polling every 3s");
  }

  detach(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pc = null;
    this.origIceHandler = null;
    this.origSigHandler = null;
    this.origConnHandler = null;
    this.origIceCandHandler = null;
  }

  getReport(): { entries: DiagnosticEntry[]; summary: string } {
    const last = this.entries[this.entries.length - 1];
    const lines: string[] = [];

    lines.push(`Total samples: ${this.entries.length}`);
    if (last) {
      lines.push(`Last ICE state: ${last.iceConnectionState}`);
      lines.push(`Last connection state: ${last.connectionState}`);
      lines.push(`Candidate pair: ${last.selectedCandidatePair ?? "none"}`);
      lines.push(`Local candidate: ${last.localCandidateType ?? "?"}`);
      lines.push(`Remote candidate: ${last.remoteCandidateType ?? "?"}`);
      lines.push(`Audio sent: ${last.audioBytesSent}B (${last.audioPacketsSent} pkts)`);
      lines.push(`Audio recv: ${last.audioBytesReceived}B (${last.audioPacketsReceived} pkts)`);
      lines.push(`Audio lost: ${last.audioPacketsLost} pkts`);
      lines.push(`Jitter: ${last.audioJitter ?? "?"}`);
      lines.push(`RTT: ${last.audioRoundTripTime != null ? `${(last.audioRoundTripTime * 1000).toFixed(0)}ms` : "?"}`);
      lines.push(`DTLS: ${last.dtlsState ?? "?"}`);
    }

    // Detect sustained zero-audio
    if (this.entries.length > ZERO_AUDIO_ALERT_THRESHOLD) {
      const zeroSent = this.entries.filter(
        (e, i) => i > 0 && e.audioBytesSent === this.entries[i - 1].audioBytesSent
      ).length;
      const zeroRecv = this.entries.filter(
        (e, i) => i > 0 && e.audioBytesReceived === this.entries[i - 1].audioBytesReceived
      ).length;
      const threshold = this.entries.length * 0.8;

      if (zeroSent > threshold) {
        lines.push("!!! OUTBOUND AUDIO DEAD — bytesSent not increasing");
      }
      if (zeroRecv > threshold) {
        lines.push("!!! INBOUND AUDIO DEAD — bytesReceived not increasing");
      }
    }

    lines.push(`ICE candidates: ${this.iceCandidatesLog.length}`);
    if (this.iceCandidatesLog.length > 0) {
      const relay = this.iceCandidatesLog.filter(c => c.startsWith("relay")).length;
      const host = this.iceCandidatesLog.filter(c => c.startsWith("host")).length;
      lines.push(`  relay=${relay} host=${host} srflx=${this.iceCandidatesLog.length - relay - host}`);
    }

    return { entries: [...this.entries], summary: lines.join("\n") };
  }

  private async poll(): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.connectionState === "closed") {
      this.detach();
      return;
    }

    try {
      const stats = await pc.getStats();

      let audioBytesSent = 0;
      let audioBytesReceived = 0;
      let audioPacketsSent = 0;
      let audioPacketsReceived = 0;
      let audioPacketsLost = 0;
      let audioJitter: number | null = null;
      let audioRoundTripTime: number | null = null;
      let videoBytesSent = 0;
      let videoBytesReceived = 0;
      let selectedPairLocalId: string | null = null;
      let selectedPairRemoteId: string | null = null;
      let selectedCandidatePair: string | null = null;
      let localCandidateType: string | null = null;
      let remoteCandidateType: string | null = null;
      let dtlsState: string | null = null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const candidateMap = new Map<string, any>();

      stats.forEach((report) => {
        if (report.type === "local-candidate" || report.type === "remote-candidate") {
          candidateMap.set(report.id, report);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = report as any;

        if (report.type === "outbound-rtp" && r.kind === "audio") {
          audioBytesSent = r.bytesSent ?? 0;
          audioPacketsSent = r.packetsSent ?? 0;
        }
        if (report.type === "inbound-rtp" && r.kind === "audio") {
          audioBytesReceived = r.bytesReceived ?? 0;
          audioPacketsReceived = r.packetsReceived ?? 0;
          audioPacketsLost = r.packetsLost ?? 0;
          audioJitter = r.jitter ?? null;
        }
        if (report.type === "outbound-rtp" && r.kind === "video") {
          videoBytesSent = r.bytesSent ?? 0;
        }
        if (report.type === "inbound-rtp" && r.kind === "video") {
          videoBytesReceived = r.bytesReceived ?? 0;
        }
        if (report.type === "candidate-pair" && r.state === "succeeded") {
          selectedPairLocalId = r.localCandidateId;
          selectedPairRemoteId = r.remoteCandidateId;
          audioRoundTripTime = r.currentRoundTripTime ?? null;
          selectedCandidatePair = `${r.localCandidateId} <-> ${r.remoteCandidateId}`;
        }
        if (report.type === "transport") {
          dtlsState = r.dtlsState ?? null;
        }
      });

      // Resolve candidate types
      if (selectedPairLocalId) {
        const local = candidateMap.get(selectedPairLocalId);
        localCandidateType = local?.candidateType ?? null;
      }
      if (selectedPairRemoteId) {
        const remote = candidateMap.get(selectedPairRemoteId);
        remoteCandidateType = remote?.candidateType ?? null;
      }

      const entry: DiagnosticEntry = {
        timestamp: Date.now(),
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        signalingState: pc.signalingState,
        connectionState: pc.connectionState,
        localCandidateType,
        remoteCandidateType,
        audioBytesSent,
        audioBytesReceived,
        audioPacketsSent,
        audioPacketsReceived,
        audioPacketsLost,
        audioJitter,
        audioRoundTripTime,
        videoBytesSent,
        videoBytesReceived,
        selectedCandidatePair,
        dtlsState,
      };

      // Real-time zero-audio detection
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        if (audioBytesSent === this.prevAudioBytesSent) {
          this.zeroSentStreak++;
          if (this.zeroSentStreak === ZERO_AUDIO_ALERT_THRESHOLD) {
            console.error("[WebRTC-Diag] OUTBOUND AUDIO DEAD for 9s — mic may be muted or track not flowing");
          }
        } else {
          this.zeroSentStreak = 0;
        }

        if (audioBytesReceived === this.prevAudioBytesReceived) {
          this.zeroRecvStreak++;
          if (this.zeroRecvStreak === ZERO_AUDIO_ALERT_THRESHOLD) {
            console.error("[WebRTC-Diag] INBOUND AUDIO DEAD for 9s — remote not sending or TURN relay broken");
          }
        } else {
          this.zeroRecvStreak = 0;
        }
      }

      this.prevAudioBytesSent = audioBytesSent;
      this.prevAudioBytesReceived = audioBytesReceived;

      this.entries.push(entry);
      if (this.entries.length > MAX_ENTRIES) {
        this.entries.shift();
      }

      console.log(
        `[WebRTC-Diag] ice=${pc.iceConnectionState} ` +
        `audio:${audioBytesSent}B/${audioPacketsSent}pkt up, ` +
        `${audioBytesReceived}B/${audioPacketsReceived}pkt down, ` +
        `lost=${audioPacketsLost} jitter=${audioJitter != null ? Number(audioJitter).toFixed(4) : "?"} ` +
        `rtt=${audioRoundTripTime != null ? (Number(audioRoundTripTime) * 1000).toFixed(0) + "ms" : "?"} ` +
        `pair=${localCandidateType ?? "?"}↔${remoteCandidateType ?? "?"} ` +
        `dtls=${dtlsState ?? "?"}`
      );
    } catch (e) {
      console.warn("[WebRTC-Diag] getStats error:", e);
    }
  }
}

export const webrtcDiagnostics = new WebRTCDiagnostics();
