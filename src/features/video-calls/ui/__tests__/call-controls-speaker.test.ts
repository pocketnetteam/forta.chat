import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { useCallStore } from "@/entities/call";
import { CallStatus } from "@/entities/call";
import type { CallInfo, CallType } from "@/entities/call/model/types";

/**
 * WEE-60 — regression tests for the native speaker toggle.
 *
 * Root cause H1: on Android the in-call speaker button only wrote to
 * `callStore.audioOutputId`. The store→setSinkId path (CallWindow) is a no-op
 * on the native WebView, and `enumerateDevices()` returns no `audiooutput`
 * entries, so the gear-menu speaker section was hidden and the user had no way
 * to reach `AudioRouter.setDevice()`. These tests lock the fix: a standalone
 * speaker toggle, present on native regardless of enumerateDevices (A4), wired
 * straight to `nativeCallBridge.setAudioDevice({ type })` (A1).
 */

vi.mock("@/shared/lib/native-webrtc", () => ({
  installNativeWebRTCProxy: vi.fn(),
  NativeWebRTC: new Proxy({}, {
    get: () => vi.fn().mockResolvedValue({}),
  }),
}));

// Mutable platform flag — flipped per test before mount.
const platformMock = { isNative: true };
vi.mock("@/shared/lib/platform", () => ({
  get isNative() {
    return platformMock.isNative;
  },
}));

const setAudioDevice = vi.fn().mockResolvedValue(undefined);
// Native AudioRouter snapshot the mocked bridge reports on mount, plus the
// captured audioDevicesChanged callback so tests can simulate hot-swaps.
const nativeState = { active: "" };
let audioDevicesCb: ((s: { active: string; devices: never[] }) => void) | null = null;
vi.mock("@/shared/lib/native-calls/native-call-bridge", () => ({
  nativeCallBridge: {
    setAudioDevice: (opts: { type: string }) => setAudioDevice(opts),
    getAudioDevices: () =>
      Promise.resolve({ active: nativeState.active, devices: [] }),
    onAudioDevicesChanged: (cb: (s: { active: string; devices: never[] }) => void) => {
      audioDevicesCb = cb;
      return Promise.resolve(() => {
        audioDevicesCb = null;
      });
    },
  },
}));

vi.mock("../model/call-service", () => ({
  useCallService: () => ({
    toggleMute: vi.fn(),
    toggleCamera: vi.fn(),
    toggleScreenShare: vi.fn(),
    hangup: vi.fn(),
    setAudioDevice: vi.fn(),
    setVideoDevice: vi.fn(),
  }),
}));

// Default: empty device lists — mirrors Android, where enumerateDevices()
// yields no audiooutput entries. Individual tests can override.
const mediaDevicesState = {
  audioDevices: ref<unknown[]>([]),
  videoDevices: ref<unknown[]>([]),
  audioOutputDevices: ref<{ deviceId: string; label: string; kind: string }[]>([]),
};
vi.mock("../model/use-media-devices", () => ({
  useMediaDevices: () => ({
    audioDevices: mediaDevicesState.audioDevices,
    videoDevices: mediaDevicesState.videoDevices,
    audioOutputDevices: mediaDevicesState.audioOutputDevices,
    enumerateDevices: vi.fn().mockResolvedValue(undefined),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let CallControls: any;

function makeCall(type: CallType): CallInfo {
  return {
    callId: "c1",
    roomId: "r1",
    peerId: "p1",
    peerAddress: "addr",
    peerName: "Peer",
    type,
    direction: "outgoing",
    status: CallStatus.connected,
    startedAt: 0,
    endedAt: null,
  };
}

describe("CallControls — native speaker toggle (WEE-60)", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    platformMock.isNative = true;
    mediaDevicesState.audioOutputDevices.value = [];
    setAudioDevice.mockClear();
    nativeState.active = "";
    audioDevicesCb = null;
    vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));
    CallControls = (await import("../CallControls.vue")).default;
  });

  it("renders a standalone speaker toggle on native even with no enumerated audiooutput (A4)", () => {
    const store = useCallStore();
    store.setActiveCall(makeCall("voice"));
    const wrapper = mount(CallControls);
    expect(wrapper.find('[data-testid="speaker-toggle"]').exists()).toBe(true);
  });

  it("voice call: first tap routes to speaker, second tap back to earpiece (A1)", async () => {
    const store = useCallStore();
    store.setActiveCall(makeCall("voice"));
    const wrapper = mount(CallControls);

    const btn = wrapper.find('[data-testid="speaker-toggle"]');
    await btn.trigger("click");
    expect(setAudioDevice).toHaveBeenLastCalledWith({ type: "speaker" });

    await btn.trigger("click");
    expect(setAudioDevice).toHaveBeenLastCalledWith({ type: "earpiece" });
  });

  it("video call opens on speaker, so first tap drops to earpiece", async () => {
    const store = useCallStore();
    store.setActiveCall(makeCall("video"));
    const wrapper = mount(CallControls);

    await wrapper.find('[data-testid="speaker-toggle"]').trigger("click");
    expect(setAudioDevice).toHaveBeenLastCalledWith({ type: "earpiece" });
  });

  it("seeds the toggle from the native active route on mount (survives minimize/restore)", async () => {
    // Voice call → initial guess is earpiece (off). But the native router
    // already reports speaker (e.g. user had it on before a minimize/restore).
    nativeState.active = "speaker";
    const store = useCallStore();
    store.setActiveCall(makeCall("voice"));
    const wrapper = mount(CallControls);
    await flushPromises();

    // Toggle now reflects speaker=on, so the next tap drops to earpiece.
    await wrapper.find('[data-testid="speaker-toggle"]').trigger("click");
    expect(setAudioDevice).toHaveBeenLastCalledWith({ type: "earpiece" });
  });

  it("re-syncs the toggle when the native route changes (BT/headset hot-swap)", async () => {
    // Video call → initial speaker=on.
    const store = useCallStore();
    store.setActiveCall(makeCall("video"));
    const wrapper = mount(CallControls);
    await flushPromises();

    // Native reports the route moved off the loudspeaker (e.g. BT connected).
    audioDevicesCb?.({ active: "earpiece", devices: [] });
    await nextTick();

    // speakerOn is now false → next tap routes back to speaker.
    await wrapper.find('[data-testid="speaker-toggle"]').trigger("click");
    expect(setAudioDevice).toHaveBeenLastCalledWith({ type: "speaker" });
  });

  it("does not render the native toggle on web, and selectOutput stays store-only", async () => {
    // `isNative` is a live getter on the mocked platform module, so flipping
    // the flag before mount is enough — no module reset needed.
    platformMock.isNative = false;

    const store = useCallStore();
    store.setActiveCall(makeCall("voice"));
    const wrapper = mount(CallControls);

    expect(wrapper.find('[data-testid="speaker-toggle"]').exists()).toBe(false);
    expect(setAudioDevice).not.toHaveBeenCalled();
  });
});
