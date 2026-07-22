import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import { createElectronApiMock } from "@/shared/lib/platform/create-electron-api-mock";

const totalUnreadRef = ref(0);

vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({
    get totalUnread() {
      return totalUnreadRef.value;
    },
  }),
}));

describe("useElectronUnreadBadge", () => {
  beforeEach(() => {
    totalUnreadRef.value = 0;
    vi.resetModules();
    delete window.electronAPI;
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.resetModules();
  });

  it("no-ops outside Electron", async () => {
    const { useElectronUnreadBadge } = await import(
      "./use-electron-unread-badge"
    );
    expect(() => useElectronUnreadBadge()).not.toThrow();
  });

  it("pushes totalUnread to setBadgeCount", async () => {
    const setBadgeCount = vi.fn(async () => undefined);
    window.electronAPI = createElectronApiMock({ setBadgeCount });

    const { useElectronUnreadBadge } = await import(
      "./use-electron-unread-badge"
    );

    const Host = defineComponent({
      setup() {
        useElectronUnreadBadge();
        return () => null;
      },
    });
    const wrapper = mount(Host);
    await nextTick();
    expect(setBadgeCount).toHaveBeenCalledWith(0);

    totalUnreadRef.value = 7;
    await nextTick();
    expect(setBadgeCount).toHaveBeenCalledWith(7);

    wrapper.unmount();
    await nextTick();
    expect(setBadgeCount).toHaveBeenCalledWith(0);
  });
});
