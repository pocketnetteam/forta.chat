import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockIsNative = { value: true };
const mockIsIOS = { value: false };
vi.mock("@/shared/lib/platform", () => ({
  get isNative() { return mockIsNative.value; },
  isAndroid: true,
  get isIOS() { return mockIsIOS.value; },
  isElectron: false,
  isWeb: false,
  currentPlatform: "android",
}));

let appStateChangeHandler: ((state: { isActive: boolean }) => void) | null = null;
const mockAppAddListener: Mock = vi.fn(async (event: string, handler: (state: { isActive: boolean }) => void) => {
  if (event === "appStateChange") {
    appStateChangeHandler = handler;
  }
  return { remove: vi.fn() };
});

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: mockAppAddListener,
  },
}));

const mockGetAudioStatus: Mock = vi.fn();
const mockForceStopAudio: Mock = vi.fn().mockResolvedValue(undefined);
const mockReleaseStaleRingingCall: Mock = vi.fn().mockResolvedValue(false);

vi.mock("@/shared/lib/native-calls", () => ({
  nativeCallBridge: {
    getAudioStatus: mockGetAudioStatus,
    forceStopAudio: mockForceStopAudio,
    releaseStaleRingingCall: mockReleaseStaleRingingCall,
  },
}));

let iosInterruptionHandler: (() => void) | null = null;
const mockIOSCallAudioAddListener: Mock = vi.fn(
  async (event: string, handler: () => void) => {
    if (event === "audioInterruptionBegan") {
      iosInterruptionHandler = handler;
    }
    return { remove: vi.fn() };
  },
);

vi.mock("@/shared/lib/native-calls/native-call-bridge.ios", () => ({
  IOSCallAudio: {
    addListener: mockIOSCallAudioAddListener,
  },
  // No CallKit release in these cases: every interruption here is a real
  // phone call taking the session, so the watchdog must hang up.
  isRecentCallKitRelease: () => false,
}));

// `vi.hoisted` so the spy survives `vi.resetModules()` — without this,
// every reload() builds a fresh useCallService() factory closure and
// our local mockCallServiceHangup reference becomes stale on the
// second run.
const { mockCallServiceHangup } = vi.hoisted(() => ({
  mockCallServiceHangup: vi.fn(),
}));
vi.mock("@/features/video-calls/model/call-service", () => ({
  useCallService: () => ({ hangup: mockCallServiceHangup }),
}));

const mockCallStore: Record<string, unknown> = {
  activeCall: null,
  matrixCall: null,
};

vi.mock("@/entities/call", () => ({
  useCallStore: () => mockCallStore,
}));

// ---------------------------------------------------------------------------

async function reload(): Promise<typeof import("./audio-watchdog")> {
  vi.resetModules();
  const mod = await import("./audio-watchdog");
  mod.__resetAudioWatchdogStateForTests();
  return mod;
}

describe("setupAudioWatchdog — app resume audio recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appStateChangeHandler = null;
    iosInterruptionHandler = null;
    mockCallStore.activeCall = null;
    mockCallStore.matrixCall = null;
    mockIsNative.value = true;
    mockIsIOS.value = false;
    mockGetAudioStatus.mockReset();
    mockForceStopAudio.mockReset().mockResolvedValue(undefined);
    mockReleaseStaleRingingCall.mockReset().mockResolvedValue(false);
    mockIOSCallAudioAddListener.mockClear();
    mockCallServiceHangup.mockClear();
  });

  it("registers an appStateChange listener on Capacitor App", async () => {
    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    expect(mockAppAddListener).toHaveBeenCalledWith("appStateChange", expect.any(Function));
  });

  it("does NOT register a listener on non-native platforms", async () => {
    mockIsNative.value = false;
    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    expect(mockAppAddListener).not.toHaveBeenCalled();
  });

  it("does NOT double-register if invoked twice", async () => {
    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    await setupAudioWatchdog();
    expect(mockAppAddListener).toHaveBeenCalledTimes(1);
  });

  it("calls forceStopAudio when resume happens with stuck IN_COMM mode and no active call", async () => {
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_IN_COMMUNICATION",
      isSpeakerOn: false,
      isBtScoOn: false,
    });

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();

    expect(appStateChangeHandler).not.toBeNull();
    await appStateChangeHandler!({ isActive: true });

    expect(mockGetAudioStatus).toHaveBeenCalledOnce();
    expect(mockForceStopAudio).toHaveBeenCalledOnce();
  });

  it("does NOT trigger forceStopAudio when there is an active call", async () => {
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_IN_COMMUNICATION",
      isSpeakerOn: false,
      isBtScoOn: false,
    });
    mockCallStore.activeCall = { callId: "live-call", status: "connected" };

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    await appStateChangeHandler!({ isActive: true });

    expect(mockForceStopAudio).not.toHaveBeenCalled();
  });

  it("does NOT trigger forceStopAudio when matrixCall is set but activeCall is null (mid-setup)", async () => {
    // Window during incoming call setup: handleIncomingCall on native sets
    // matrixCall first, then setActiveCall is gated behind user accept.
    // Watchdog must not kill audio during this gap.
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_IN_COMMUNICATION",
      isSpeakerOn: false,
      isBtScoOn: false,
    });
    mockCallStore.activeCall = null;
    mockCallStore.matrixCall = { callId: "mid-setup", roomId: "!r:m" };

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    await appStateChangeHandler!({ isActive: true });

    expect(mockForceStopAudio).not.toHaveBeenCalled();
  });

  it("does NOT trigger forceStopAudio when audio mode is NORMAL", async () => {
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_NORMAL",
      isSpeakerOn: false,
      isBtScoOn: false,
    });

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    await appStateChangeHandler!({ isActive: true });

    expect(mockForceStopAudio).not.toHaveBeenCalled();
  });

  it("does NOT trigger forceStopAudio when app is going to background (isActive=false)", async () => {
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_IN_COMMUNICATION",
      isSpeakerOn: false,
      isBtScoOn: false,
    });

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    await appStateChangeHandler!({ isActive: false });

    expect(mockGetAudioStatus).not.toHaveBeenCalled();
    expect(mockForceStopAudio).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Stale ringing connection — the largest open cluster ("phone stuck after a
  // call") is filed from MODE_RINGTONE, which the mode check below never
  // covered. Telecom holds that mode on behalf of our own unresolved
  // connection, so the recovery is to release the connection, not the mode.
  // -------------------------------------------------------------------------

  it("releases a connection left ringing past its deadline on resume", async () => {
    mockReleaseStaleRingingCall.mockResolvedValue(true);
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_NORMAL",
      isSpeakerOn: false,
      isBtScoOn: false,
    });

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    await appStateChangeHandler!({ isActive: true });

    expect(mockReleaseStaleRingingCall).toHaveBeenCalledOnce();
    // MODE_NORMAL: the mode itself needs no reset, and forcing one would be
    // a destructive no-op on a healthy device.
    expect(mockForceStopAudio).not.toHaveBeenCalled();
  });

  it("still resets a stranded IN_COMM mode after releasing a stale ring", async () => {
    mockReleaseStaleRingingCall.mockResolvedValue(true);
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_IN_COMMUNICATION",
      isSpeakerOn: false,
      isBtScoOn: false,
    });

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    await appStateChangeHandler!({ isActive: true });

    expect(mockReleaseStaleRingingCall).toHaveBeenCalledOnce();
    expect(mockForceStopAudio).toHaveBeenCalledOnce();
  });

  it("does NOT touch the Telecom connection while a call is live", async () => {
    // The staleness bar lives natively, but the cheapest guarantee that a
    // ringing call the user is about to answer survives is not to ask at all
    // while JS knows about a call.
    mockCallStore.matrixCall = { callId: "c1" };
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_RINGTONE",
      isSpeakerOn: false,
      isBtScoOn: false,
    });

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    await appStateChangeHandler!({ isActive: true });

    expect(mockReleaseStaleRingingCall).not.toHaveBeenCalled();
    expect(mockForceStopAudio).not.toHaveBeenCalled();
  });

  it("recovers a stranded IN_COMM mode even when the stale-ring sweep throws", async () => {
    // The two recoveries are independent; a broken sweep must not take the
    // one that worked before it down with it.
    mockReleaseStaleRingingCall.mockRejectedValue(new Error("plugin gone"));
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_IN_COMMUNICATION",
      isSpeakerOn: false,
      isBtScoOn: false,
    });

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    await appStateChangeHandler!({ isActive: true });

    expect(mockForceStopAudio).toHaveBeenCalledOnce();
  });

  it("swallows errors from getAudioStatus without throwing", async () => {
    mockGetAudioStatus.mockRejectedValue(new Error("native error"));

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();

    await expect(appStateChangeHandler!({ isActive: true })).resolves.toBeUndefined();
    expect(mockForceStopAudio).not.toHaveBeenCalled();
  });

  it("swallows errors from forceStopAudio without throwing", async () => {
    mockGetAudioStatus.mockResolvedValue({
      mode: "MODE_IN_COMMUNICATION",
      isSpeakerOn: false,
      isBtScoOn: false,
    });
    mockForceStopAudio.mockRejectedValue(new Error("force-stop error"));

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();

    await expect(appStateChangeHandler!({ isActive: true })).resolves.toBeUndefined();
  });
});

describe("setupAudioWatchdog — iOS AVAudioSession interruption (Step 6 Task 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appStateChangeHandler = null;
    iosInterruptionHandler = null;
    mockCallStore.activeCall = null;
    mockCallStore.matrixCall = null;
    mockIsNative.value = true;
    mockIsIOS.value = true;
    mockIOSCallAudioAddListener.mockClear();
    mockCallServiceHangup.mockClear();
  });

  it("subscribes to IOSCallAudio.audioInterruptionBegan on iOS", async () => {
    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    expect(mockIOSCallAudioAddListener).toHaveBeenCalledWith(
      "audioInterruptionBegan",
      expect.any(Function),
    );
  });

  it("does NOT subscribe to AVAudioSession interruption on Android (no IOSCallAudio plugin)", async () => {
    mockIsIOS.value = false;
    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    expect(mockIOSCallAudioAddListener).not.toHaveBeenCalled();
  });

  it("hangs up the active call when AVAudioSession interruption begins (real cellular call mid-VoIP)", async () => {
    mockCallStore.activeCall = { callId: "live", status: "connected" };

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();

    expect(iosInterruptionHandler).not.toBeNull();
    iosInterruptionHandler!();

    // Dynamic import + .then() — wait via vi.waitFor so we don't have
    // to count microtask depth. The hangup spy is hoisted so reset
    // doesn't break its identity across reload().
    await vi.waitFor(
      () => expect(mockCallServiceHangup).toHaveBeenCalledOnce(),
      { timeout: 1000 },
    );
  });

  it("hangs up if matrixCall is set but activeCall is null (mid-setup) — interruption still ends the call cleanly", async () => {
    // The user accepted the call, the SDK has the MatrixCall, audio
    // setup hasn't completed yet, and at that exact moment the
    // cellular phone rings. We must still end the call — leaving it
    // half-set-up means the JS layer never observes the proper teardown
    // and the audio session stays in a broken state.
    mockCallStore.activeCall = null;
    mockCallStore.matrixCall = { callId: "mid-setup", roomId: "!r:m" };

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    iosInterruptionHandler!();

    await vi.waitFor(
      () => expect(mockCallServiceHangup).toHaveBeenCalledOnce(),
      { timeout: 1000 },
    );
  });

  it("does NOTHING when no call is active (interruption arrives between calls — already-quiescent state)", async () => {
    mockCallStore.activeCall = null;
    mockCallStore.matrixCall = null;

    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    iosInterruptionHandler!();
    // Give the dynamic import time to resolve in case the gate is
    // accidentally bypassed — this is a negative test, so we wait long
    // enough that a buggy implementation would have called hangup.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockCallServiceHangup).not.toHaveBeenCalled();
  });

  it("does NOT double-subscribe the interruption listener if setupAudioWatchdog is called twice", async () => {
    const { setupAudioWatchdog } = await reload();
    await setupAudioWatchdog();
    await setupAudioWatchdog();
    expect(mockIOSCallAudioAddListener).toHaveBeenCalledTimes(1);
  });

  it("does NOT throw if IOSCallAudio.addListener fails (plugin not registered in dev / older builds)", async () => {
    mockIOSCallAudioAddListener.mockRejectedValueOnce(new Error("plugin missing"));
    const { setupAudioWatchdog } = await reload();
    await expect(setupAudioWatchdog()).resolves.toBeUndefined();
    // The resume-handler path must still be wired even when the iOS
    // interruption subscription fails — the two are independent.
    expect(mockAppAddListener).toHaveBeenCalledWith("appStateChange", expect.any(Function));
  });
});
