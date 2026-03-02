export enum CallStatus {
  idle = "idle",
  ringing = "ringing",
  incoming = "incoming",
  connecting = "connecting",
  connected = "connected",
  ended = "ended",
  failed = "failed",
}

export type CallType = "voice" | "video";
export type CallDirection = "outgoing" | "incoming";

export interface CallInfo {
  callId: string;
  roomId: string;
  peerId: string;
  peerAddress: string;
  peerName: string;
  type: CallType;
  direction: CallDirection;
  status: CallStatus;
  startedAt: number | null;
  endedAt: number | null;
}

export interface CallHistoryEntry {
  id: string;
  roomId: string;
  peerId: string;
  peerName: string;
  type: CallType;
  direction: CallDirection;
  status: "answered" | "missed" | "declined" | "failed";
  startedAt: number;
  duration: number;
}
