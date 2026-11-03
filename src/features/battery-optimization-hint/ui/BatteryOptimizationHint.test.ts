// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";

/**
 * Missed push calls T3: the battery hint shows once after sign-in on an
 * optimized Android app, opens the system dialog on "Allow" and names the
 * vendor's autostart setting where one is known.
 */
const auth = reactive({ isAuthenticated: true, matrixReady: true });
const getBatteryOptimizationStatus = vi.fn();
const requestIgnoreBatteryOptimizations = vi.fn(async () => {});
const getDeviceManufacturer = vi.fn(async () => ({ manufacturer: "samsung", model: "SM-A528B", sdk: 34 }));

vi.mock("@/entities/auth", () => ({ useAuthStore: () => auth }));
vi.mock("@/shared/lib/platform", () => ({ isNative: true, isAndroid: true, isIOS: false, isElectron: false, isWeb: false }));
vi.mock("@/shared/lib/push/push-data-plugin", () => ({
  PushData: { getBatteryOptimizationStatus, requestIgnoreBatteryOptimizations, getDeviceManufacturer },
}));
vi.mock("@/shared/lib/push/incoming-calls-setting", () => ({ isIncomingCallsEnabled: () => true }));
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}));

async function mountHint() {
  const { default: BatteryOptimizationHint } = await import("./BatteryOptimizationHint.vue");
  const wrapper = mount(BatteryOptimizationHint);
  await flushPromises();
  return wrapper;
}

describe("BatteryOptimizationHint", () => {
  beforeEach(() => {
    localStorage.clear();
    getBatteryOptimizationStatus.mockReset();
    requestIgnoreBatteryOptimizations.mockClear();
    auth.isAuthenticated = true;
    auth.matrixReady = true;
  });

  it("shows for an optimized app, names the vendor, and opens the system dialog on Allow", async () => {
    getBatteryOptimizationStatus.mockResolvedValue({ ignoring: false });
    const wrapper = await mountHint();

    expect(wrapper.find('[data-testid="battery-hint"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="battery-hint-vendor"]').text()).toContain('"vendor":"Samsung"');
    expect(Number(localStorage.getItem("forta.batteryHint.lastShownAt"))).toBeGreaterThan(0);

    await wrapper.find('[data-testid="battery-hint-allow"]').trigger("click");
    await flushPromises();
    expect(requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="battery-hint"]').exists()).toBe(false);
  });

  it("stays hidden when the app is already exempt", async () => {
    getBatteryOptimizationStatus.mockResolvedValue({ ignoring: true });
    const wrapper = await mountHint();
    expect(wrapper.find('[data-testid="battery-hint"]').exists()).toBe(false);
    expect(localStorage.getItem("forta.batteryHint.lastShownAt")).toBeNull();
  });

  it("stays hidden when the user turned the reminder off", async () => {
    getBatteryOptimizationStatus.mockResolvedValue({ ignoring: false });
    localStorage.setItem("forta.batteryHint.disabled", "1");
    const wrapper = await mountHint();
    expect(wrapper.find('[data-testid="battery-hint"]').exists()).toBe(false);
  });

  it("waits for a ready session before asking Android", async () => {
    auth.matrixReady = false;
    getBatteryOptimizationStatus.mockResolvedValue({ ignoring: false });
    const wrapper = await mountHint();
    expect(getBatteryOptimizationStatus).not.toHaveBeenCalled();

    auth.matrixReady = true;
    await flushPromises();
    expect(wrapper.find('[data-testid="battery-hint"]').exists()).toBe(true);
  });

  // Review 2026-10-10: a Matrix reconnect is not a sign-out. The hint used to
  // vanish on any network blip and, already counted as shown, stay away for
  // 30 days.
  it("stays on screen through a Matrix reconnect", async () => {
    getBatteryOptimizationStatus.mockResolvedValue({ ignoring: false });
    const wrapper = await mountHint();
    expect(wrapper.find('[data-testid="battery-hint"]').exists()).toBe(true);

    auth.matrixReady = false;
    await flushPromises();
    auth.matrixReady = true;
    await flushPromises();
    expect(wrapper.find('[data-testid="battery-hint"]').exists()).toBe(true);
    expect(getBatteryOptimizationStatus).toHaveBeenCalledTimes(1);
  });

  it("does not come up for a check that finishes after sign-out", async () => {
    getBatteryOptimizationStatus.mockResolvedValue({ ignoring: false });
    let answer: (v: { manufacturer: string; model: string; sdk: number }) => void = () => {};
    getDeviceManufacturer.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const wrapper = await mountHint();

    auth.isAuthenticated = false;
    await flushPromises();
    answer({ manufacturer: "samsung", model: "SM-A528B", sdk: 34 });
    await flushPromises();

    expect(wrapper.find('[data-testid="battery-hint"]').exists()).toBe(false);
    expect(localStorage.getItem("forta.batteryHint.lastShownAt")).toBeNull();
  });
});
