import { describe, it, expect } from "vitest";
import { inviteCallRecord } from "./invite-call-record";
import { MessageStatus, MessageType } from "../model/types";

const invite = (sdp: string, extra: Record<string, unknown> = {}) => ({
  type: "m.call.invite",
  sender: "@peer:server",
  event_id: "$invite",
  origin_server_ts: 5_000,
  content: { call_id: "call-1", version: 1, lifetime: 60_000, offer: { type: "offer", sdp }, ...extra },
});

describe("inviteCallRecord", () => {
  it("builds a missed-call record that stands in for the hangup that never came", () => {
    const record = inviteCallRecord(invite("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"), "!room:server");

    expect(record).toEqual({
      id: "$invite",
      roomId: "!room:server",
      senderId: "peer",
      content: "",
      timestamp: 5_000,
      status: MessageStatus.sent,
      type: MessageType.system,
      callInfo: { callType: "voice", missed: true, duration: 0, callId: "call-1", fromInvite: true },
      systemMeta: { template: "system.missedVoiceCall", senderAddr: "peer" },
    });
  });

  it("reads a video call from the offer", () => {
    const record = inviteCallRecord(invite("v=0\r\nm=audio 9 x\r\nm=video 9 x\r\n"), "!room:server");

    expect(record.callInfo?.callType).toBe("video");
    expect(record.systemMeta?.template).toBe("system.missedVideoCall");
  });

  it("reads a video call from offer_type when the offer is absent", () => {
    const record = inviteCallRecord({ ...invite(""), content: { call_id: "call-1", offer_type: "video" } }, "!room:server");

    expect(record.callInfo?.callType).toBe("video");
  });
});
