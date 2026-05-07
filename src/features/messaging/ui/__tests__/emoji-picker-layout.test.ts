import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import EmojiPicker from "../EmojiPicker.vue";

vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));

vi.mock("@/entities/theme", () => ({
  useThemeStore: () => ({
    recentEmojis: [],
    quickReactions: [],
    animationsEnabled: true,
  }),
}));

vi.mock("@/shared/lib/composables/use-media-query", () => ({
  useMobile: () => ({ value: true }),
}));

describe("EmojiPicker mobile layout", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--message-input-height");
    document.body.innerHTML = "";
  });

  it("input mode docks above MessageInput via --message-input-height", async () => {
    document.documentElement.style.setProperty("--message-input-height", "64px");
    const wrapper = mount(EmojiPicker, {
      props: { show: true, x: 0, y: 0, mode: "input" },
      attachTo: document.body,
    });
    await wrapper.vm.$nextTick();

    const panel = document.querySelector(".emoji-panel") as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.style.bottom).toBe("var(--message-input-height, 0px)");
    expect(panel.style.width).toBe("100%");

    wrapper.unmount();
  });

  it("reaction mode places picker above tap point on mobile", async () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const wrapper = mount(EmojiPicker, {
      props: { show: true, x: 100, y: 700, mode: "reaction" },
      attachTo: document.body,
    });
    await wrapper.vm.$nextTick();

    const panel = document.querySelector(".emoji-panel") as HTMLElement;
    expect(panel).toBeTruthy();

    const top = parseInt(panel.style.top, 10);
    expect(Number.isNaN(top)).toBe(false);
    expect(top).toBeLessThan(700);
    expect(top).toBeGreaterThan(0);

    wrapper.unmount();
  });
});
