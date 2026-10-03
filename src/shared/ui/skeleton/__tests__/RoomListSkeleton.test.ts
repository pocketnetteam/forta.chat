// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

// useI18n is auto-imported from @/shared/lib/i18n — mock the module so t()
// echoes the key, letting us assert which translation key the skeleton chose
// (the real useI18n needs an active Pinia locale store).
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: { value: "en" } }),
}));

import RoomListSkeleton from "../RoomListSkeleton.vue";

describe("RoomListSkeleton", () => {
  it("shows the normal loading text on first load", () => {
    const wrapper = mount(RoomListSkeleton, { props: { firstLoad: true } });
    expect(wrapper.text()).toContain("contactList.loadingChats");
    expect(wrapper.text()).toContain("contactList.loadingChatsHint");
    expect(wrapper.text()).not.toContain("contactList.loadingChatsSlow");
  });

  it("shows the slow loading text when slow=true", () => {
    const wrapper = mount(RoomListSkeleton, { props: { firstLoad: true, slow: true } });
    expect(wrapper.text()).toContain("contactList.loadingChatsSlow");
    expect(wrapper.text()).toContain("contactList.loadingChatsSlowHint");
  });

  it("renders only the loading header when rows=0", () => {
    const wrapper = mount(RoomListSkeleton, { props: { firstLoad: true, rows: 0 } });
    expect(wrapper.text()).toContain("contactList.loadingChats");
    expect(wrapper.findAll(".animate-pulse")).toHaveLength(0);
    expect(wrapper.classes()).not.toContain("h-full");
  });

  it("renders 6 skeleton rows by default", () => {
    const wrapper = mount(RoomListSkeleton, { props: { firstLoad: true } });
    expect(wrapper.findAll(".space-y-1 > div")).toHaveLength(6);
  });

  it("does not render the loading message block when firstLoad is false", () => {
    const wrapper = mount(RoomListSkeleton, { props: { firstLoad: false } });
    expect(wrapper.text()).not.toContain("contactList.loadingChats");
    expect(wrapper.text()).not.toContain("contactList.loadingChatsSlow");
  });
});
