// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

/**
 * Audit S6-02: in a browser nothing ever asked for the notification
 * permission, so it stayed "default" and no message banner could show.
 */

vi.mock("../../model/use-notification-settings", () => ({
  useNotificationSettings: () => ({
    canOpenSystemSettings: ref(false),
    vendorGuidanceId: ref(null),
    openSystemNotificationSettings: vi.fn(),
    detectVendor: vi.fn(),
    fullScreenIntentAllowed: ref(null),
    detectFullScreenIntent: vi.fn().mockResolvedValue(undefined),
    openFullScreenIntentSettings: vi.fn(),
    incomingCallsEnabled: ref(true),
    setIncomingCallsEnabled: vi.fn(),
  }),
}));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));
vi.mock("@/shared/lib/platform", () => ({
  isNative: false,
  isAndroid: false,
  isIOS: false,
  isElectron: false,
  isWeb: true,
  hasTor: false,
  isAndroidWeb: false,
  currentPlatform: "web",
  getElectronAPI: () => undefined,
  resolveAppUpdaterEnabled: () => false,
}));
vi.mock("@/shared/ui/settings-section", () => ({
  SettingsSection: { template: "<section><slot /></section>" },
}));

const stubNotification = (permission: NotificationPermission, answer: NotificationPermission = permission) => {
  const requestPermission = vi.fn(async () => {
    fake.permission = answer;
    return answer;
  });
  const fake = { permission, requestPermission };
  vi.stubGlobal("Notification", fake);
  return requestPermission;
};

const mountSettings = async () => {
  vi.resetModules();
  const { default: NotificationSettings } = await import("../NotificationSettings.vue");
  const wrapper = mount(NotificationSettings);
  await flushPromises();
  return wrapper;
};

describe("NotificationSettings — browser notification permission (audit S6-02)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the permission from the button and then says it is on", async () => {
    const requestPermission = stubNotification("default", "granted");
    const wrapper = await mountSettings();

    const allow = wrapper.find('[data-testid="web-notifications-allow"]');
    expect(allow.exists()).toBe(true);
    await allow.trigger("click");
    await flushPromises();

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="web-notifications-allow"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("notificationsSettings.webBannersOn");
    wrapper.unmount();
  });

  it("explains where to unblock a denied permission instead of offering a dead button", async () => {
    stubNotification("denied");
    const wrapper = await mountSettings();

    expect(wrapper.find('[data-testid="web-notifications-allow"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("notificationsSettings.webBannersBlocked");
    wrapper.unmount();
  });
});
