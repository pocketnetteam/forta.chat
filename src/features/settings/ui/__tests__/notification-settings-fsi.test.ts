import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

/**
 * O10 — the notification settings page tells the user when Android has
 * revoked the full-screen incoming-call surface, and offers the system
 * screen that grants it back.
 */

const state = {
  fullScreenIntentAllowed: ref<boolean | null>(null),
  detectFullScreenIntent: vi.fn().mockResolvedValue(undefined),
  openFullScreenIntentSettings: vi.fn().mockResolvedValue(true),
  incomingCallsEnabled: ref(true),
  setIncomingCallsEnabled: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../../model/use-notification-settings", () => ({
  useNotificationSettings: () => ({
    canOpenSystemSettings: ref(true),
    vendorGuidanceId: ref(null),
    openSystemNotificationSettings: vi.fn(),
    detectVendor: vi.fn(),
    fullScreenIntentAllowed: state.fullScreenIntentAllowed,
    detectFullScreenIntent: state.detectFullScreenIntent,
    openFullScreenIntentSettings: state.openFullScreenIntentSettings,
    incomingCallsEnabled: state.incomingCallsEnabled,
    setIncomingCallsEnabled: state.setIncomingCallsEnabled,
  }),
}));

type AppStateListener = (s: { isActive: boolean }) => void;
const app = {
  listeners: [] as AppStateListener[],
  remove: vi.fn(),
};
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (_event: string, cb: AppStateListener) => {
      app.listeners.push(cb);
      return { remove: app.remove };
    }),
  },
}));
vi.mock("@/shared/lib/platform", () => ({
  isNative: true,
  isAndroid: true,
  isIOS: false,
  isElectron: false,
  isWeb: false,
  hasTor: false,
  isAndroidWeb: false,
  currentPlatform: "android",
  getElectronAPI: () => undefined,
  resolveAppUpdaterEnabled: () => false,
}));
vi.mock("@/shared/ui/settings-section", () => ({
  SettingsSection: { template: "<section><slot /></section>" },
}));

describe("NotificationSettings — full-screen intent banner (O10)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    state.fullScreenIntentAllowed.value = null;
    state.detectFullScreenIntent.mockClear();
    state.openFullScreenIntentSettings.mockClear();
    app.listeners.length = 0;
    app.remove.mockClear();
    vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));
  });

  it("shows the banner only when the intent is known to be revoked", async () => {
    const { default: NotificationSettings } = await import("../NotificationSettings.vue");
    const wrapper = mount(NotificationSettings);
    expect(wrapper.find('[data-testid="fsi-banner"]').exists()).toBe(false);

    state.fullScreenIntentAllowed.value = false;
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="fsi-banner"]').exists()).toBe(true);

    state.fullScreenIntentAllowed.value = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="fsi-banner"]').exists()).toBe(false);
  });

  it("opens the system screen from the banner", async () => {
    state.fullScreenIntentAllowed.value = false;
    const { default: NotificationSettings } = await import("../NotificationSettings.vue");
    const wrapper = mount(NotificationSettings);
    await wrapper.find('[data-testid="fsi-open"]').trigger("click");
    expect(state.openFullScreenIntentSettings).toHaveBeenCalledTimes(1);
  });

  // The banner's button leaves the app for a system screen, and the user
  // flips the permission there. The status used to be read only on mount, so
  // coming back showed the old state both ways until the screen was reopened.
  it("re-reads the permission when the app comes back to the foreground", async () => {
    const { default: NotificationSettings } = await import("../NotificationSettings.vue");
    mount(NotificationSettings);
    await flushPromises();
    expect(state.detectFullScreenIntent).toHaveBeenCalledTimes(1);
    expect(app.listeners).toHaveLength(1);

    app.listeners[0]({ isActive: false });
    expect(state.detectFullScreenIntent).toHaveBeenCalledTimes(1);

    app.listeners[0]({ isActive: true });
    expect(state.detectFullScreenIntent).toHaveBeenCalledTimes(2);
  });

  it("stops listening once the screen closes", async () => {
    const { default: NotificationSettings } = await import("../NotificationSettings.vue");
    const wrapper = mount(NotificationSettings);
    await flushPromises();
    wrapper.unmount();
    expect(app.remove).toHaveBeenCalledTimes(1);
  });

  it("drops a listener that resolves after the screen already closed", async () => {
    const { default: NotificationSettings } = await import("../NotificationSettings.vue");
    const wrapper = mount(NotificationSettings);
    wrapper.unmount();
    await flushPromises();
    expect(app.remove).toHaveBeenCalledTimes(1);
  });
});

describe("NotificationSettings — incoming calls switch (#1388)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    state.incomingCallsEnabled.value = true;
    state.setIncomingCallsEnabled.mockClear();
    vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));
  });

  it("shows the switch on and turns calls off when it is flipped", async () => {
    const { default: NotificationSettings } = await import("../NotificationSettings.vue");
    const { Toggle } = await import("@/shared/ui/toggle");
    const wrapper = mount(NotificationSettings);
    const toggle = wrapper.findComponent(Toggle);

    expect(toggle.exists()).toBe(true);
    expect(toggle.props("modelValue")).toBe(true);

    toggle.vm.$emit("update:modelValue", false);
    await flushPromises();

    expect(state.setIncomingCallsEnabled).toHaveBeenCalledWith(false);
  });
});
