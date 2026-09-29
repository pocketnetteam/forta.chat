import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

/**
 * Regression: on iOS finalizeCall sent dismissCallUI and
 * closeAllPeerConnections to NativeWebRTC, an Android-only plugin, and every
 * call logged two UNIMPLEMENTED rejections (iPhone XR, 2026-09-24). A sibling
 * of finalize-call.test.ts because that file pins the platform to Android.
 */
vi.mock("@/shared/lib/platform", () => ({
  isNative: true,
  isAndroid: false,
  isIOS: true,
  isElectron: false,
  isWeb: false,
  currentPlatform: "ios",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
  },
  registerPlugin: () => new Proxy({}, {
    get: () => vi.fn().mockResolvedValue({}),
  }),
}));

const mockStopAudioRouting: Mock = vi.fn().mockResolvedValue(undefined);
const mockReportCallEnded: Mock = vi.fn().mockResolvedValue(undefined);
const mockRetirePendingMarkers: Mock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/shared/lib/native-calls", () => ({
  nativeCallBridge: {
    stopAudioRouting: mockStopAudioRouting,
    reportCallEnded: mockReportCallEnded,
    forceStopAudio: vi.fn().mockResolvedValue(undefined),
  },
  retirePendingMarkers: mockRetirePendingMarkers,
}));

const mockDismissCallUI: Mock = vi.fn().mockResolvedValue(undefined);
const mockCloseAllPeerConnections: Mock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/shared/lib/native-webrtc", () => ({
  NativeWebRTC: {
    dismissCallUI: mockDismissCallUI,
    closeAllPeerConnections: mockCloseAllPeerConnections,
  },
}));

const mockReleasePageAwake: Mock = vi.fn();

vi.mock("./page-awake-tone", () => ({
  releasePageAwake: mockReleasePageAwake,
}));

describe("finalizeCall on iOS", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./finalize-call");
    mod.__resetFinalizeCallStateForTests();
  });

  it("leaves the Android-only NativeWebRTC plugin alone", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "ios-call-1", "!room:matrix.org");

    expect(mockDismissCallUI).not.toHaveBeenCalled();
    expect(mockCloseAllPeerConnections).not.toHaveBeenCalled();
  });

  it("still runs the steps iOS has", async () => {
    const { finalizeCall } = await import("./finalize-call");
    await finalizeCall("hangup", "ios-call-2", "!room:matrix.org");

    expect(mockRetirePendingMarkers).toHaveBeenCalledWith("ios-call-2", "!room:matrix.org");
    expect(mockStopAudioRouting).toHaveBeenCalledOnce();
    expect(mockReportCallEnded).toHaveBeenCalledWith("ios-call-2");
    expect(mockReleasePageAwake).toHaveBeenCalledWith("ios-call-2");
  });
});
