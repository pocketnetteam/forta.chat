import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  notifyNewMessage,
  requestNotificationPermission,
  __resetWebNotifierForTests,
} from "../web-notifier";

// Minimal AudioContext stub — captures whether the beep pipeline ran at all.
class FakeOscillator {
  frequency = { value: 0 };
  type = "sine";
  connect(node: FakeGain | FakeContextDestination) { return node; }
  start = vi.fn();
  stop = vi.fn();
}
class FakeGain {
  gain = {
    value: 0,
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect(node: FakeContextDestination) { return node; }
}
class FakeContextDestination {}
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "running";
  currentTime = 0;
  destination = new FakeContextDestination();
  oscillators: FakeOscillator[] = [];
  constructor() { FakeAudioContext.instances.push(this); }
  createOscillator() { const o = new FakeOscillator(); this.oscillators.push(o); return o; }
  createGain() { return new FakeGain(); }
  resume = vi.fn(async () => undefined);
}

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static instances: { title: string; opts?: NotificationOptions }[] = [];
  constructor(public title: string, public opts?: NotificationOptions) {
    FakeNotification.instances.push({ title, opts });
  }
}

describe("web-notifier", () => {
  let visibilityState: DocumentVisibilityState = "hidden";
  let hasFocus = false;

  beforeEach(() => {
    __resetWebNotifierForTests();
    FakeAudioContext.instances = [];
    FakeNotification.instances = [];
    FakeNotification.permission = "granted";

    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("Notification", FakeNotification);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    document.hasFocus = () => hasFocus;
    document.title = "Forta";
    visibilityState = "hidden";
    hasFocus = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetWebNotifierForTests();
  });

  it("does NOT beep or banner when the tab is focused", () => {
    visibilityState = "visible";
    hasFocus = true;
    notifyNewMessage({ roomId: "!room1", body: "hi", fallbackTitle: "Forta" });
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(FakeNotification.instances).toHaveLength(0);
    // Title is owned by useUnreadDocumentTitle — notifier must not mutate it.
    expect(document.title).toBe("Forta");
  });

  it("beeps + fires Notification when tab is hidden, without mutating title", () => {
    notifyNewMessage({ roomId: "!room1", body: "hi", title: "Alice", fallbackTitle: "Forta" });
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].oscillators[0].start).toHaveBeenCalledOnce();
    expect(document.title).toBe("Forta");
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0].title).toBe("Alice");
    expect(FakeNotification.instances[0].opts?.body).toBe("hi");
    expect(FakeNotification.instances[0].opts?.tag).toBe("!room1");
  });

  it("throttles consecutive beeps", () => {
    notifyNewMessage({ roomId: "!room1", body: "1", fallbackTitle: "Forta" });
    notifyNewMessage({ roomId: "!room1", body: "2", fallbackTitle: "Forta" });
    notifyNewMessage({ roomId: "!room1", body: "3", fallbackTitle: "Forta" });
    // Only one oscillator should fire within the throttle window.
    const allOscillators = FakeAudioContext.instances.flatMap((c) => c.oscillators);
    const started = allOscillators.filter((o) => (o.start as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(started).toHaveLength(1);
    expect(document.title).toBe("Forta");
  });

  it("does NOT fire the OS banner when permission is not granted", () => {
    FakeNotification.permission = "denied";
    notifyNewMessage({ roomId: "!room1", body: "hi", fallbackTitle: "Forta" });
    expect(FakeNotification.instances).toHaveLength(0);
    // …but the beep still happens because it isn't gated on permission.
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(document.title).toBe("Forta");
  });

  it("requestNotificationPermission delegates to the platform API", async () => {
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockResolvedValueOnce("granted");
    const result = await requestNotificationPermission();
    expect(result).toBe("granted");
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("uses fallbackTitle when explicit title is omitted (i18n hook)", () => {
    notifyNewMessage({ roomId: "!room1", body: "hi", fallbackTitle: "Forta Chat" });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0].title).toBe("Forta Chat");
  });
});
