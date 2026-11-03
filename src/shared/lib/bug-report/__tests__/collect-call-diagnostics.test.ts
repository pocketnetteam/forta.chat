import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAudioStatus = vi.fn();
const mockGetInviteThrottleSnapshot = vi.fn();
const mockGetAudioTimeline = vi.fn();
const mockGetRingAudioLog = vi.fn();

const mockGetFullScreenIntentStatus = vi.fn();
vi.mock("@/shared/lib/push/push-data-plugin", () => ({
  PushData: {
    getFullScreenIntentStatus: (...args: unknown[]) => mockGetFullScreenIntentStatus(...args),
  },
}));

vi.mock("@/shared/lib/native-calls", () => ({
  nativeCallBridge: {
    getAudioStatus: mockGetAudioStatus,
    getInviteThrottleSnapshot: mockGetInviteThrottleSnapshot,
    getAudioTimeline: mockGetAudioTimeline,
    getRingAudioLog: mockGetRingAudioLog,
  },
}));

describe("collectCallDiagnostics", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    mockGetAudioTimeline.mockResolvedValue([]);
    mockGetRingAudioLog.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("returns EMPTY_CALL_DIAGNOSTICS on non-native platforms", async () => {
    vi.doMock("@/shared/lib/platform", () => ({
      isNative: false,
      isAndroid: false,
      isIOS: false,
    }));
    const { collectCallDiagnostics, EMPTY_CALL_DIAGNOSTICS } = await import(
      "../collect-call-diagnostics"
    );

    const out = await collectCallDiagnostics();
    expect(out).toEqual(EMPTY_CALL_DIAGNOSTICS);
    expect(mockGetAudioStatus).not.toHaveBeenCalled();
    expect(mockGetInviteThrottleSnapshot).not.toHaveBeenCalled();
  });

  it("merges audio status + invite history on Android", async () => {
    vi.doMock("@/shared/lib/platform", () => ({
      isNative: true,
      isAndroid: true,
      isIOS: false,
    }));
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
    expect(mockGetInviteThrottleSnapshot).toHaveBeenCalledOnce();
  });

  it("falls back gracefully when native bridge throws", async () => {
    vi.doMock("@/shared/lib/platform", () => ({
      isNative: true,
      isAndroid: true,
      isIOS: false,
    }));
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
    vi.doMock("@/shared/lib/platform", () => ({
      isNative: true,
      isAndroid: true,
      isIOS: false,
    }));
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

  // iOS uses PushKit, not FCM data messages, so the throttle snapshot
  // is not applicable. The collector must NOT call into the native
  // bridge for it (a guaranteed-empty round-trip is wasted work) and
  // the `inviteHistory` block in the envelope must stay empty. The
  // audio-status branch must still run — IOSCallAudio.getStatus()
  // exposes the AVAudioSession mode (Step 6 Task 4).
  it("skips invite throttle on iOS but still collects audio status", async () => {
    vi.doMock("@/shared/lib/platform", () => ({
      isNative: true,
      isAndroid: false,
      isIOS: true,
    }));
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_IN_COMMUNICATION",
      isSpeakerOn: false,
      isBtScoOn: true,
    });
    mockGetInviteThrottleSnapshot.mockResolvedValue({
      records: [
        {
          receivedAtMs: 1,
          sentAtMs: 0,
          deliveryLatencyMs: 1,
          expired: false,
          callId: "should-be-ignored",
        },
      ],
    });

    const { collectCallDiagnostics } = await import("../collect-call-diagnostics");
    const out = await collectCallDiagnostics();

    expect(out.audioMode).toBe("MODE_IN_COMMUNICATION");
    expect(out.isSpeakerOn).toBe(false);
    expect(out.isBtScoOn).toBe(true);
    expect(out.inviteHistory).toEqual([]);
    expect(out.expiredInviteCount).toBe(0);
    expect(mockGetAudioStatus).toHaveBeenCalledOnce();
    expect(mockGetInviteThrottleSnapshot).not.toHaveBeenCalled();
  });
  it("attaches the audio timeline on Android", async () => {
    vi.doMock("@/shared/lib/platform", () => ({
      isNative: true,
      isAndroid: true,
      isIOS: false,
    }));
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_RINGTONE",
      isSpeakerOn: false,
      isBtScoOn: false,
    });
    mockGetInviteThrottleSnapshot.mockResolvedValue({ records: [] });
    // A device that ends the call back in MODE_RINGTONE: the snapshot alone
    // cannot say whether it ever left, the timeline can.
    mockGetAudioTimeline.mockResolvedValue([
      { atMs: 0, event: "start", detail: "voice" },
      { atMs: 12, event: "mode", detail: "MODE_IN_COMMUNICATION" },
      { atMs: 8400, event: "stop", detail: "" },
    ]);

    const { collectCallDiagnostics } = await import("../collect-call-diagnostics");
    const out = await collectCallDiagnostics();

    expect(out.audioTimeline.map((e) => e.event)).toEqual([
      "start",
      "mode",
      "stop",
    ]);
    expect(mockGetAudioTimeline).toHaveBeenCalledOnce();
  });

  // "Rings very quietly": the report needs the mode the ringtone played in
  // and whether Telecom held the call, not the mode when the form opened.
  it("carries the audio state of the last rings on Android", async () => {
    vi.doMock("@/shared/lib/platform", () => ({
      isNative: true,
      isAndroid: true,
      isIOS: false,
    }));
    mockGetAudioStatus.mockResolvedValue({ mode: "MODE_NORMAL", isSpeakerOn: false, isBtScoOn: false });
    mockGetInviteThrottleSnapshot.mockResolvedValue({ records: [] });
    const ring = {
      atMs: 1_000,
      callId: "call-1",
      modeAtArm: "MODE_IN_COMMUNICATION",
      modeReset: true,
      telecom: "none",
      modeInRing: "MODE_NORMAL",
    };
    mockGetRingAudioLog.mockResolvedValue([ring]);

    const { collectCallDiagnostics } = await import("../collect-call-diagnostics");
    const out = await collectCallDiagnostics();

    expect(out.ringAudio).toEqual([ring]);
  });

  it("keeps the rest of the report when the ring log query fails", async () => {
    vi.doMock("@/shared/lib/platform", () => ({
      isNative: true,
      isAndroid: true,
      isIOS: false,
    }));
    mockGetAudioStatus.mockResolvedValue({ mode: "MODE_NORMAL", isSpeakerOn: false, isBtScoOn: false });
    mockGetInviteThrottleSnapshot.mockResolvedValue({ records: [] });
    mockGetRingAudioLog.mockRejectedValue(new Error("not registered"));

    const { collectCallDiagnostics } = await import("../collect-call-diagnostics");
    const out = await collectCallDiagnostics();

    expect(out.ringAudio).toEqual([]);
    expect(out.audioMode).toBe("MODE_NORMAL");
  });

  it("keeps the rest of the report when the timeline query fails", async () => {
    vi.doMock("@/shared/lib/platform", () => ({
      isNative: true,
      isAndroid: true,
      isIOS: false,
    }));
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_IN_COMMUNICATION",
      isSpeakerOn: true,
      isBtScoOn: false,
    });
    mockGetInviteThrottleSnapshot.mockResolvedValue({ records: [] });
    // An older native build has no such plugin method — diagnostics being
    // unavailable must never block a report from being filed.
    mockGetAudioTimeline.mockRejectedValue(new Error("not registered"));

    const { collectCallDiagnostics } = await import("../collect-call-diagnostics");
    const out = await collectCallDiagnostics();

    expect(out.audioTimeline).toEqual([]);
    expect(out.audioMode).toBe("MODE_IN_COMMUNICATION");
  });
});

describe("collectCallDiagnostics — ICE and Tor extras (O05/O14)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    mockGetAudioTimeline.mockResolvedValue([]);
    mockGetRingAudioLog.mockResolvedValue([]);
    mockGetAudioStatus.mockResolvedValue({ mode: "MODE_NORMAL", isSpeakerOn: false, isBtScoOn: false });
    mockGetInviteThrottleSnapshot.mockResolvedValue({ records: [] });
  });

  const ice = { total: 4, relay: 1, host: 2, srflx: 1, selectedPairType: "relay/srflx", lastIceState: "connected", turnServers: 1 };

  it("merges what the registered provider reports, on native", async () => {
    vi.doMock("@/shared/lib/platform", () => ({ isNative: true, isAndroid: true, isIOS: false }));
    const mod = await import("../collect-call-diagnostics");
    mod.registerCallDiagnosticsExtras(async () => ({ ice, tor: { enabled: true, connected: false } }));

    const out = await mod.collectCallDiagnostics();
    expect(out.ice).toEqual(ice);
    expect(out.tor).toEqual({ enabled: true, connected: false });
    expect(out.audioMode).toBe("MODE_NORMAL");
  });

  it("carries the extras on web too — the envelope is not native-only", async () => {
    vi.doMock("@/shared/lib/platform", () => ({ isNative: false, isAndroid: false, isIOS: false }));
    const mod = await import("../collect-call-diagnostics");
    mod.registerCallDiagnosticsExtras(() => ({ ice, tor: null }));

    const out = await mod.collectCallDiagnostics();
    expect(out.ice).toEqual(ice);
    expect(out.tor).toBeNull();
    expect(mockGetAudioStatus).not.toHaveBeenCalled();
  });

  it("reports nulls when no provider is registered or the provider throws", async () => {
    vi.doMock("@/shared/lib/platform", () => ({ isNative: true, isAndroid: true, isIOS: false }));
    const mod = await import("../collect-call-diagnostics");
    expect((await mod.collectCallDiagnostics()).ice).toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mod.registerCallDiagnosticsExtras(() => { throw new Error("no call yet"); });
    const out = await mod.collectCallDiagnostics();
    warn.mockRestore();
    expect(out.ice).toBeNull();
    expect(out.tor).toBeNull();
    expect(out.audioMode).toBe("MODE_NORMAL");
  });
});

describe("collectCallDiagnostics — full-screen intent (O10)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    mockGetAudioTimeline.mockResolvedValue([]);
    mockGetRingAudioLog.mockResolvedValue([]);
    mockGetAudioStatus.mockResolvedValue({ mode: "MODE_NORMAL", isSpeakerOn: false, isBtScoOn: false });
    mockGetInviteThrottleSnapshot.mockResolvedValue({ records: [] });
  });

  it("reports a revoked full-screen intent on Android 14+", async () => {
    vi.doMock("@/shared/lib/platform", () => ({ isNative: true, isAndroid: true, isIOS: false }));
    mockGetFullScreenIntentStatus.mockResolvedValue({ allowed: false, manageable: true });
    const { collectCallDiagnostics } = await import("../collect-call-diagnostics");
    expect((await collectCallDiagnostics()).fullScreenIntentAllowed).toBe(false);
  });

  it("reports null before Android 14 (nothing to manage) and when the query fails", async () => {
    vi.doMock("@/shared/lib/platform", () => ({ isNative: true, isAndroid: true, isIOS: false }));
    mockGetFullScreenIntentStatus.mockResolvedValue({ allowed: true, manageable: false });
    let mod = await import("../collect-call-diagnostics");
    expect((await mod.collectCallDiagnostics()).fullScreenIntentAllowed).toBeNull();

    vi.resetModules();
    mockGetFullScreenIntentStatus.mockRejectedValue(new Error("not implemented"));
    mod = await import("../collect-call-diagnostics");
    const out = await mod.collectCallDiagnostics();
    expect(out.fullScreenIntentAllowed).toBeNull();
    expect(out.audioMode).toBe("MODE_NORMAL");
  });

  it("does not ask on iOS", async () => {
    vi.doMock("@/shared/lib/platform", () => ({ isNative: true, isAndroid: false, isIOS: true }));
    const { collectCallDiagnostics } = await import("../collect-call-diagnostics");
    expect((await collectCallDiagnostics()).fullScreenIntentAllowed).toBeNull();
    expect(mockGetFullScreenIntentStatus).not.toHaveBeenCalled();
  });
});
