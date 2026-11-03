import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHangup, mockReject, store, client } = vi.hoisted(() => ({
  mockHangup: vi.fn(),
  mockReject: vi.fn(),
  store: { matrixCall: null as Record<string, unknown> | null },
  client: { current: null as unknown },
}));
vi.mock("./call-answer", () => ({ hangup: mockHangup, rejectCall: mockReject }));
vi.mock("./call-media", () => ({ getClient: () => client.current }));
vi.mock("@/entities/call", () => ({ useCallStore: () => store }));

import { callEndSent, endCallForLogout, LOGOUT_CALL_END_TIMEOUT_MS, logoutCallAction } from "./call-logout";

const ME = "@me:s";
const ev = (type: string, callId: string, status: string | null, sender = ME) => ({
  getType: () => type,
  getSender: () => sender,
  getContent: () => ({ call_id: callId }),
  status,
});

describe("logoutCallAction", () => {
  it("declines a call still ringing here and hangs up any other", () => {
    expect(logoutCallAction("inbound", "ringing")).toBe("reject");
    expect(logoutCallAction("inbound", "fledgling")).toBe("reject");
    expect(logoutCallAction("inbound", "connected")).toBe("hangup");
    expect(logoutCallAction("outbound", "invite_sent")).toBe("hangup");
    expect(logoutCallAction("inbound", "ended")).toBeNull();
  });
});

describe("callEndSent", () => {
  it("is true once our reject or hangup of the call left this device", () => {
    expect(callEndSent([ev("m.call.reject", "c1", "sent")], "c1", ME)).toBe(true);
    expect(callEndSent([ev("m.call.hangup", "c1", null)], "c1", ME)).toBe(true);
    expect(callEndSent([ev("m.call.hangup", "c1", "sending")], "c1", ME)).toBe(false);
    expect(callEndSent([ev("m.call.hangup", "c2", "sent")], "c1", ME)).toBe(false);
    expect(callEndSent([ev("m.call.hangup", "c1", "sent", "@peer:s")], "c1", ME)).toBe(false);
  });
});

describe("endCallForLogout", () => {
  // Logout cleared the call store and tore Matrix down: the caller rang on until the
  // invite expired, and a peer mid-call waited for the ICE timeout.
  let events: ReturnType<typeof ev>[];
  beforeEach(() => {
    vi.useFakeTimers();
    mockHangup.mockReset();
    mockReject.mockReset();
    events = [];
    client.current = {
      getUserId: () => ME,
      getRoom: () => ({ getLiveTimeline: () => ({ getEvents: () => events }) }),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    store.matrixCall = null;
  });

  it("declines a ringing call and returns once the reject is sent", async () => {
    store.matrixCall = { callId: "c1", roomId: "!r:s", direction: "inbound", state: "ringing" };
    let done = false;
    void endCallForLogout().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(200);
    expect(mockReject).toHaveBeenCalledOnce();
    expect(done).toBe(false);

    events.push(ev("m.call.reject", "c1", "sent"));
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });

  it("hangs up a call in progress", async () => {
    store.matrixCall = { callId: "c1", roomId: "!r:s", direction: "inbound", state: "connected" };
    events.push(ev("m.call.hangup", "c1", "sent"));
    await endCallForLogout();
    expect(mockHangup).toHaveBeenCalledOnce();
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("gives up waiting after the timeout so logout still finishes", async () => {
    store.matrixCall = { callId: "c1", roomId: "!r:s", direction: "outbound", state: "invite_sent" };
    let done = false;
    void endCallForLogout().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(LOGOUT_CALL_END_TIMEOUT_MS + 200);
    expect(done).toBe(true);
  });

  it("does nothing without a call", async () => {
    await endCallForLogout();
    expect(mockHangup).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
  });
});
