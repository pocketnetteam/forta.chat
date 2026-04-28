import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockIsNative = { value: true };
vi.mock("@/shared/lib/platform", () => ({
  get isNative() { return mockIsNative.value; },
  isAndroid: true,
  isIOS: false,
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

vi.mock("@/shared/lib/native-calls", () => ({
  nativeCallBridge: {
    getAudioStatus: mockGetAudioStatus,
    forceStopAudio: mockForceStopAudio,
  },
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
    mockCallStore.activeCall = null;
    mockCallStore.matrixCall = null;
    mockIsNative.value = true;
    mockGetAudioStatus.mockReset();
    mockForceStopAudio.mockReset().mockResolvedValue(undefined);
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
