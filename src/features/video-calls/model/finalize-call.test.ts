import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mocks must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("@/shared/lib/platform", () => ({
  isNative: true,
  isAndroid: true,
  isIOS: false,
  isElectron: false,
  isWeb: false,
  currentPlatform: "android",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  },
  registerPlugin: () => new Proxy({}, {
    get: () => vi.fn().mockResolvedValue({}),
  }),
}));

const mockStopAudioRouting: Mock = vi.fn().mockResolvedValue(undefined);
const mockReportCallEnded: Mock = vi.fn().mockResolvedValue(undefined);
const mockForceStopAudio: Mock = vi.fn().mockResolvedValue(undefined);
const mockCloseAllPeerConnections: Mock = vi.fn().mockResolvedValue(undefined);
const mockRetirePendingMarkers: Mock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/shared/lib/native-calls", () => ({
  nativeCallBridge: {
    stopAudioRouting: mockStopAudioRouting,
    reportCallEnded: mockReportCallEnded,
    forceStopAudio: mockForceStopAudio,
  },
  retirePendingMarkers: mockRetirePendingMarkers,
}));

const mockDismissCallUI: Mock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/shared/lib/native-webrtc", () => ({
  NativeWebRTC: new Proxy({}, {
    get: (_target, prop) => {
      if (prop === "dismissCallUI") return mockDismissCallUI;
      if (prop === "closeAllPeerConnections") return mockCloseAllPeerConnections;
      return vi.fn().mockResolvedValue({});
    },
  }),
}));

const mockReleasePageAwake: Mock = vi.fn();

vi.mock("./page-awake-tone", () => ({
  releasePageAwake: mockReleasePageAwake,
}));

// ---------------------------------------------------------------------------

describe("finalizeCall — central call cleanup", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockStopAudioRouting.mockResolvedValue(undefined);
    mockReportCallEnded.mockResolvedValue(undefined);
    mockDismissCallUI.mockResolvedValue(undefined);
    mockCloseAllPeerConnections.mockResolvedValue(undefined);
    mockForceStopAudio.mockResolvedValue(undefined);
    const mod = await import("./finalize-call");
    mod.__resetFinalizeCallStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes all four cleanup steps for a hangup", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "callId-1");

    expect(mockStopAudioRouting).toHaveBeenCalledOnce();
    expect(mockReportCallEnded).toHaveBeenCalledWith("callId-1");
    expect(mockDismissCallUI).toHaveBeenCalledOnce();
    expect(mockCloseAllPeerConnections).toHaveBeenCalledOnce();
  });

  // C02: the router stops only for the call that owns it, so the finalized
  // call's id travels with the stop.
  it("stops the audio routing for the finalized call only", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "call-c02", "!room:server");
    expect(mockStopAudioRouting).toHaveBeenCalledWith({ callId: "call-c02" });
  });

  it("retires the call's pending answer/reject markers, with the room", async () => {
    // Without this the marker outlives the call and matches the NEXT invite
    // from the same room: the redial is auto-answered without a ringer, or
    // declined unheard. Both were seen on the Samsung bench, 2026-09-09.
    // finalizeCall is the one place every termination path passes through.
    // The room has to travel with the callId — a connection created from a
    // push is keyed by an event_id that never equals the Matrix callId, so
    // the room is the only key both arrival paths share.
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "callId-markers", "!room:matrix.org");

    expect(mockRetirePendingMarkers).toHaveBeenCalledWith("callId-markers", "!room:matrix.org");
  });

  it("retires the markers on every termination path, not just hangup", async () => {
    const { finalizeCall } = await import("./finalize-call");
    for (const reason of ["reject", "sdk-ended", "error", "ice-failed"] as const) {
      await finalizeCall(reason, `callId-${reason}`, "!room:matrix.org");
      expect(mockRetirePendingMarkers).toHaveBeenCalledWith(`callId-${reason}`, "!room:matrix.org");
    }
  });

  it("retires the markers before the slower native steps", async () => {
    // The bridge arms its ordering guard inside retirePendingMarkers. Running
    // it after stopAudioRouting (which can wait up to 500ms on its own) would
    // leave a redial arriving in between with nothing to wait for.
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "callId-first", "!room:matrix.org");

    expect(mockRetirePendingMarkers.mock.invocationCallOrder[0]).toBeLessThan(
      mockStopAudioRouting.mock.invocationCallOrder[0],
    );
  });

  it("preserves cleanup ordering: stopAudio → reportEnded → dismissUI → closePeers", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "callId-order");

    const stopOrder = mockStopAudioRouting.mock.invocationCallOrder[0];
    const reportOrder = mockReportCallEnded.mock.invocationCallOrder[0];
    const dismissOrder = mockDismissCallUI.mock.invocationCallOrder[0];
    const closeOrder = mockCloseAllPeerConnections.mock.invocationCallOrder[0];

    expect(stopOrder).toBeLessThan(reportOrder);
    expect(reportOrder).toBeLessThan(dismissOrder);
    expect(dismissOrder).toBeLessThan(closeOrder);
  });

  it("lets the page fall silent for this call only after the native teardown", async () => {
    // The page-awake tone keeps Chromium from freezing the page while the
    // native call screen hides it. Every step above waits on a native reply
    // that a frozen page never receives, so the tone goes last.
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "callId-tone");

    expect(mockReleasePageAwake).toHaveBeenCalledWith("callId-tone");
    expect(mockReleasePageAwake.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockCloseAllPeerConnections.mock.invocationCallOrder[0],
    );
  });

  it("releases the page-awake tone even when every native step fails", async () => {
    mockStopAudioRouting.mockRejectedValueOnce(new Error("a"));
    mockReportCallEnded.mockRejectedValueOnce(new Error("b"));
    mockDismissCallUI.mockRejectedValueOnce(new Error("c"));
    mockCloseAllPeerConnections.mockRejectedValueOnce(new Error("d"));

    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("error", "callId-tone-allfail");

    expect(mockReleasePageAwake).toHaveBeenCalledWith("callId-tone-allfail");
  });

  it("invokes the same four steps for reject", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("reject", "callId-2");

    expect(mockStopAudioRouting).toHaveBeenCalledOnce();
    expect(mockReportCallEnded).toHaveBeenCalledWith("callId-2");
    expect(mockDismissCallUI).toHaveBeenCalledOnce();
    expect(mockCloseAllPeerConnections).toHaveBeenCalledOnce();
  });

  it("invokes the same four steps for sdk-ended", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("sdk-ended", "callId-3");

    expect(mockStopAudioRouting).toHaveBeenCalledOnce();
    expect(mockReportCallEnded).toHaveBeenCalledWith("callId-3");
    expect(mockDismissCallUI).toHaveBeenCalledOnce();
    expect(mockCloseAllPeerConnections).toHaveBeenCalledOnce();
  });

  it("invokes the same four steps for error", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("error", "callId-4");

    expect(mockStopAudioRouting).toHaveBeenCalledOnce();
    expect(mockReportCallEnded).toHaveBeenCalledWith("callId-4");
    expect(mockDismissCallUI).toHaveBeenCalledOnce();
    expect(mockCloseAllPeerConnections).toHaveBeenCalledOnce();
  });

  it("is idempotent for the same callId — second call is a no-op", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "callId-dup");
    await finalizeCall("hangup", "callId-dup");

    expect(mockStopAudioRouting).toHaveBeenCalledTimes(1);
    expect(mockReportCallEnded).toHaveBeenCalledTimes(1);
    expect(mockDismissCallUI).toHaveBeenCalledTimes(1);
    expect(mockCloseAllPeerConnections).toHaveBeenCalledTimes(1);
  });

  it("dedups two concurrent finalize calls for the same callId without await", async () => {
    // Realistic race: SDK fires Hangup synchronously inside its
    // State→Ended handler in some paths, so onState→ended and onHangup
    // both call finalizeCall in the same JS event loop tick. The Set
    // guard must run before any `await` to dedup correctly.
    const { finalizeCall } = await import("./finalize-call");
    const p1 = finalizeCall("sdk-ended", "concurrent-id");
    const p2 = finalizeCall("sdk-ended", "concurrent-id");
    await Promise.all([p1, p2]);

    expect(mockStopAudioRouting).toHaveBeenCalledTimes(1);
    expect(mockReportCallEnded).toHaveBeenCalledTimes(1);
    expect(mockDismissCallUI).toHaveBeenCalledTimes(1);
    expect(mockCloseAllPeerConnections).toHaveBeenCalledTimes(1);
  });

  it("does not let a finalize re-enter while still in progress (long-running cleanup)", async () => {
    // Simulate stopAudioRouting hanging for >GC window. Without the
    // in-progress sentinel, a re-entry within the GC delay would skip
    // step 1 of the second call (Set membership) but the slow first
    // call would still be running step 1 — overlap. With the sentinel
    // the second call sees the slot occupied and short-circuits.
    let resolveFirst: () => void = () => {};
    mockStopAudioRouting.mockReturnValueOnce(
      new Promise<void>((resolve) => { resolveFirst = resolve; }),
    );

    const { finalizeCall } = await import("./finalize-call");
    const p1 = finalizeCall("hangup", "long-call");
    // Yield once so finalizeCall runs its sync prologue (sets slot).
    await Promise.resolve();
    // Second call hits the slot and short-circuits.
    await finalizeCall("hangup", "long-call");
    expect(mockStopAudioRouting).toHaveBeenCalledTimes(1);

    resolveFirst();
    await p1;
    expect(mockReportCallEnded).toHaveBeenCalledTimes(1);
  });

  it("does NOT skip a finalize for a different callId", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "first-call");
    await finalizeCall("hangup", "second-call");

    expect(mockStopAudioRouting).toHaveBeenCalledTimes(2);
    expect(mockReportCallEnded).toHaveBeenNthCalledWith(1, "first-call");
    expect(mockReportCallEnded).toHaveBeenNthCalledWith(2, "second-call");
  });

  it("continues remaining steps when stopAudioRouting throws", async () => {
    mockStopAudioRouting.mockRejectedValueOnce(new Error("router crash"));

    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "callId-resilience-1");

    expect(mockReportCallEnded).toHaveBeenCalledOnce();
    expect(mockDismissCallUI).toHaveBeenCalledOnce();
    expect(mockCloseAllPeerConnections).toHaveBeenCalledOnce();
  });

  it("continues remaining steps when reportCallEnded throws", async () => {
    mockReportCallEnded.mockRejectedValueOnce(new Error("telecom crash"));

    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "callId-resilience-2");

    expect(mockStopAudioRouting).toHaveBeenCalledOnce();
    expect(mockDismissCallUI).toHaveBeenCalledOnce();
    expect(mockCloseAllPeerConnections).toHaveBeenCalledOnce();
  });

  it("continues remaining steps when dismissCallUI throws", async () => {
    mockDismissCallUI.mockRejectedValueOnce(new Error("activity crash"));

    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "callId-resilience-3");

    expect(mockStopAudioRouting).toHaveBeenCalledOnce();
    expect(mockReportCallEnded).toHaveBeenCalledOnce();
    expect(mockCloseAllPeerConnections).toHaveBeenCalledOnce();
  });

  it("does not propagate exceptions to the caller even if every step fails", async () => {
    mockStopAudioRouting.mockRejectedValueOnce(new Error("a"));
    mockReportCallEnded.mockRejectedValueOnce(new Error("b"));
    mockDismissCallUI.mockRejectedValueOnce(new Error("c"));
    mockCloseAllPeerConnections.mockRejectedValueOnce(new Error("d"));

    const { finalizeCall } = await import("./finalize-call");
    await expect(finalizeCall("error", "callId-allfail")).resolves.toBeUndefined();
  });

  it("emits a telemetry event for the finalize_start and finalized phases", async () => {
    const { finalizeCall, onCallTelemetry } = await import("./finalize-call");
    const events: Array<{ type: string; reason: string; callId: string }> = [];
    const unsubscribe = onCallTelemetry((e) => events.push(e));

    await finalizeCall("hangup", "callId-telemetry");

    expect(events).toContainEqual(expect.objectContaining({
      type: "call_finalize_start",
      reason: "hangup",
      callId: "callId-telemetry",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "call_finalized",
      reason: "hangup",
      callId: "callId-telemetry",
    }));

    unsubscribe();
  });

  it("does not emit telemetry to listeners that have unsubscribed", async () => {
    const { finalizeCall, onCallTelemetry } = await import("./finalize-call");
    const events: Array<{ type: string }> = [];
    const unsubscribe = onCallTelemetry((e) => events.push(e));
    unsubscribe();

    await finalizeCall("hangup", "callId-unsub");
    expect(events).toHaveLength(0);
  });

  it("does not let a throwing telemetry listener block cleanup", async () => {
    const { finalizeCall, onCallTelemetry } = await import("./finalize-call");
    onCallTelemetry(() => {
      throw new Error("listener crash");
    });

    await finalizeCall("hangup", "callId-listener-crash");

    expect(mockStopAudioRouting).toHaveBeenCalledOnce();
    expect(mockReportCallEnded).toHaveBeenCalledOnce();
    expect(mockDismissCallUI).toHaveBeenCalledOnce();
    expect(mockCloseAllPeerConnections).toHaveBeenCalledOnce();
  });

  it("releases idempotency lock for the callId after the GC delay", async () => {
    vi.useFakeTimers();
    const { finalizeCall, __resetFinalizeCallStateForTests } = await import("./finalize-call");
    __resetFinalizeCallStateForTests();

    await finalizeCall("hangup", "callId-gc");
    expect(mockStopAudioRouting).toHaveBeenCalledTimes(1);

    // Inside the GC window — duplicate is suppressed
    await finalizeCall("hangup", "callId-gc");
    expect(mockStopAudioRouting).toHaveBeenCalledTimes(1);

    // Past the GC window — a new finalize for the same id may run again
    await vi.advanceTimersByTimeAsync(60_000);
    await finalizeCall("hangup", "callId-gc");
    expect(mockStopAudioRouting).toHaveBeenCalledTimes(2);
  });
});

describe("waitForFinalizeSettled — the dial path waits for the previous call", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockStopAudioRouting.mockResolvedValue(undefined);
    mockReportCallEnded.mockResolvedValue(undefined);
    mockDismissCallUI.mockResolvedValue(undefined);
    mockCloseAllPeerConnections.mockResolvedValue(undefined);
    const mod = await import("./finalize-call");
    mod.__resetFinalizeCallStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the call in dismissCallUI and closeAllPeerConnections so native acts on that call only", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "callId-named");
    expect(mockDismissCallUI).toHaveBeenCalledWith({ callId: "callId-named" });
    expect(mockCloseAllPeerConnections).toHaveBeenCalledWith({ callId: "callId-named" });
  });

  it("resolves at once when nothing is finalizing", async () => {
    const { waitForFinalizeSettled } = await import("./finalize-call");
    await expect(waitForFinalizeSettled(2000)).resolves.toBe(true);
  });

  it("resolves once the in-flight finalize has run its last step", async () => {
    vi.useFakeTimers();
    let releaseDismiss!: () => void;
    mockDismissCallUI.mockReturnValueOnce(new Promise<void>((resolve) => { releaseDismiss = resolve; }));
    const { finalizeCall, waitForFinalizeSettled, __hasFinalizeInFlightForTests } = await import("./finalize-call");

    const finalize = finalizeCall("hangup", "callId-inflight");
    await vi.advanceTimersByTimeAsync(0);
    expect(__hasFinalizeInFlightForTests()).toBe(true);

    let settled: boolean | null = null;
    const wait = waitForFinalizeSettled(2000).then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBeNull();
    expect(mockCloseAllPeerConnections).not.toHaveBeenCalled();

    releaseDismiss();
    await finalize;
    await wait;
    expect(settled).toBe(true);
    expect(__hasFinalizeInFlightForTests()).toBe(false);
    expect(mockCloseAllPeerConnections).toHaveBeenCalledOnce();
  });

  it("gives up after the timeout while a native step never answers", async () => {
    vi.useFakeTimers();
    mockDismissCallUI.mockReturnValueOnce(new Promise<void>(() => {}));
    const { finalizeCall, waitForFinalizeSettled } = await import("./finalize-call");

    void finalizeCall("hangup", "callId-stuck");
    await vi.advanceTimersByTimeAsync(0);

    let settled: boolean | null = null;
    const wait = waitForFinalizeSettled(2000).then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(settled).toBe(false);
  });
});

