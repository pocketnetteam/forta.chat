// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));
vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({ inviteCount: 0 }),
}));
vi.mock("@/entities/channel", () => ({
  useChannelStore: () => ({ channels: [] }),
}));
vi.mock("@/shared/lib/platform", () => ({
  isNativePlatform: () => false,
  isLocalAiFeatureEnabled: false,
}));

import FolderTabs from "../FolderTabs.vue";

// happy-dom has no layout: give each tab a fixed 100px box laid out in order.
const TAB_WIDTH = 100;
const TAB_ORDER = ["tabs.all", "tabs.personal", "tabs.groups"];
let widthScale = 1;

function boxOf(el: HTMLElement) {
  const idx = TAB_ORDER.indexOf(el.textContent?.trim() ?? "");
  return idx < 0 ? { left: 0, width: 0 } : { left: idx * TAB_WIDTH * widthScale, width: TAB_WIDTH * widthScale };
}

describe("FolderTabs — sliding indicator", () => {
  beforeEach(() => {
    widthScale = 1;
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      return boxOf(this).left;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return boxOf(this).width;
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  const indicator = (w: ReturnType<typeof mount>) => w.find("div.absolute").element as HTMLElement;

  it("после окончания свайпа (progress=null) индикатор стоит под выбранной вкладкой, а не под последней позицией свайпа", async () => {
    const wrapper = mount(FolderTabs, { props: { modelValue: "all", scrollProgress: 0 } });
    await nextTick();

    // Swipe settled on "groups"; the old code kept the stale progress forever.
    await wrapper.setProps({ modelValue: "groups", scrollProgress: null });
    await nextTick();

    expect(indicator(wrapper).style.left).toBe(`${2 * TAB_WIDTH + TAB_WIDTH * 0.25}px`);
    expect(indicator(wrapper).style.width).toBe(`${TAB_WIDTH * 0.5}px`);
    wrapper.unmount();
  });

  it("во время свайпа индикатор идёт за пальцем без CSS-перехода, в покое — с переходом", async () => {
    const wrapper = mount(FolderTabs, { props: { modelValue: "all", scrollProgress: 0.5 } });
    await nextTick();

    expect(indicator(wrapper).style.left).toBe(`${0.5 * TAB_WIDTH + TAB_WIDTH * 0.25}px`);
    expect(indicator(wrapper).classList.contains("transition-all")).toBe(false);

    await wrapper.setProps({ scrollProgress: null });
    expect(indicator(wrapper).classList.contains("transition-all")).toBe(true);
    wrapper.unmount();
  });
});
