// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { createPinia, setActivePinia } from "pinia";

const registerPlugin = vi.fn((name: string) => {
  void name;
  return { getStatus: vi.fn().mockResolvedValue({ progress: 0, state: "STOPPED" }) };
});

vi.mock("@capacitor/core", () => ({
  registerPlugin: (name: string) => registerPlugin(name),
}));

vi.mock("@/shared/lib/platform", () => ({
  hasTor: true,
  isNative: true,
  isElectron: false,
  getElectronAPI: () => undefined,
}));

vi.mock("@/shared/lib/transport/network-stats-listener", () => ({
  initNetworkStatsListener: () => () => {},
}));

const torService = {
  state: ref("STOPPED"),
  progress: ref(0),
  getSettings: vi.fn().mockResolvedValue({ mode: "neveruse", bridgeType: "NONE", isReady: false }),
  getStatus: vi.fn().mockResolvedValue({ progress: 40, isReady: false, state: "STARTING" }),
};

vi.mock("@/shared/lib/tor", () => ({ torService }));

import { useTorStore } from "./stores";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("tor store status polling on native", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    registerPlugin.mockClear();
    torService.getStatus.mockClear();
  });

  afterEach(() => {
    useTorStore().stopTorMonitoring();
    vi.useRealTimers();
  });

  // Every 2 s poll called registerPlugin("Tor") again, so Capacitor logged
  // «Capacitor plugin "Tor" already registered» for the whole app session and
  // flooded the phone's short logcat buffer (Samsung bench, 2026-09-17).
  it("reads the status through the Tor service without registering the plugin again", async () => {
    const store = useTorStore();
    await store.init();
    await flush();
    const registeredBeforePolls = registerPlugin.mock.calls.length;

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
    }

    expect(registerPlugin).toHaveBeenCalledTimes(registeredBeforePolls);
    expect(torService.getStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(store.info).toBe("Bootstrapped 40%");
  });
});
