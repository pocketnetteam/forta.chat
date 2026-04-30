import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAudioStatus = vi.fn();
const mockGetInviteThrottleSnapshot = vi.fn();

vi.mock("@/shared/lib/native-calls", () => ({
  nativeCallBridge: {
    getAudioStatus: mockGetAudioStatus,
    getInviteThrottleSnapshot: mockGetInviteThrottleSnapshot,
  },
}));

describe("collectCallDiagnostics", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("returns EMPTY_CALL_DIAGNOSTICS on non-native platforms", async () => {
    vi.doMock("@/shared/lib/platform", () => ({ isNative: false }));
    const { collectCallDiagnostics, EMPTY_CALL_DIAGNOSTICS } = await import(
      "../collect-call-diagnostics"
    );

    const out = await collectCallDiagnostics();
    expect(out).toEqual(EMPTY_CALL_DIAGNOSTICS);
    expect(mockGetAudioStatus).not.toHaveBeenCalled();
    expect(mockGetInviteThrottleSnapshot).not.toHaveBeenCalled();
  });

  it("merges audio status + invite history on native platforms", async () => {
    vi.doMock("@/shared/lib/platform", () => ({ isNative: true }));
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_IN_COMMUNICATION",
      isSpeakerOn: true,
      isBtScoOn: false,
    });
    mockGetInviteThrottleSnapshot.mockResolvedValue({
      records: [
        {
          receivedAtMs: 100,
          sentAtMs: 50,
          deliveryLatencyMs: 50,
          expired: false,
          callId: "abc",
        },
        {
          receivedAtMs: 200,
          sentAtMs: 50,
          deliveryLatencyMs: 150,
          expired: true,
          callId: "def",
        },
      ],
    });

    const { collectCallDiagnostics } = await import("../collect-call-diagnostics");
    const out = await collectCallDiagnostics();

    expect(out.audioMode).toBe("MODE_IN_COMMUNICATION");
    expect(out.isSpeakerOn).toBe(true);
    expect(out.isBtScoOn).toBe(false);
    expect(out.inviteHistory).toHaveLength(2);
    expect(out.expiredInviteCount).toBe(1);
  });

  it("falls back gracefully when native bridge throws", async () => {
    vi.doMock("@/shared/lib/platform", () => ({ isNative: true }));
    mockGetAudioStatus.mockRejectedValue(new Error("plugin not registered"));
    mockGetInviteThrottleSnapshot.mockRejectedValue(new Error("missing"));

    const { collectCallDiagnostics } = await import("../collect-call-diagnostics");
    const out = await collectCallDiagnostics();

    expect(out.audioMode).toBe("MODE_NORMAL");
    expect(out.isSpeakerOn).toBe(false);
    expect(out.isBtScoOn).toBe(false);
    expect(out.inviteHistory).toEqual([]);
    expect(out.expiredInviteCount).toBe(0);
  });

  it("treats malformed snapshot.records as empty array", async () => {
    vi.doMock("@/shared/lib/platform", () => ({ isNative: true }));
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_NORMAL",
      isSpeakerOn: false,
      isBtScoOn: false,
    });
    // Older native build returns null records
    mockGetInviteThrottleSnapshot.mockResolvedValue({ records: null });

    const { collectCallDiagnostics } = await import("../collect-call-diagnostics");
    const out = await collectCallDiagnostics();

    expect(out.inviteHistory).toEqual([]);
    expect(out.expiredInviteCount).toBe(0);
  });
});
