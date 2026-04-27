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

vi.mock("@/shared/lib/native-calls", () => ({
  nativeCallBridge: {
    stopAudioRouting: mockStopAudioRouting,
    reportCallEnded: mockReportCallEnded,
    forceStopAudio: mockForceStopAudio,
  },
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

describe("forceResetAudioState — recovery without callId", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockForceStopAudio.mockResolvedValue(undefined);
  });

  it("delegates to nativeCallBridge.forceStopAudio", async () => {
    const { forceResetAudioState } = await import("./finalize-call");
    await forceResetAudioState();
    expect(mockForceStopAudio).toHaveBeenCalledOnce();
  });

  it("does not throw when the native bridge errors", async () => {
    mockForceStopAudio.mockRejectedValueOnce(new Error("native fail"));
    const { forceResetAudioState } = await import("./finalize-call");
    await expect(forceResetAudioState()).resolves.toBeUndefined();
  });
});
