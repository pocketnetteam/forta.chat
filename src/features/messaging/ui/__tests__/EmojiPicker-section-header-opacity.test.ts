import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";

// Regression for WEE-9 / forta-bugs#696:
// Sticky section headers in EmojiPicker must be fully opaque — emoji rows
// scrolling under a header must not bleed through (no /opacity suffix on the
// background, no backdrop-blur).

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: { value: "en" } }),
}));

vi.mock("@/entities/theme", () => ({
  useThemeStore: () => ({
    recentEmojis: [],
    quickReactions: [],
    animationsEnabled: true,
    chatWallpaper: null,
  }),
}));

vi.mock("@/shared/lib/composables/use-android-back-handler", () => ({
  useAndroidBackHandler: vi.fn(),
}));

vi.mock("@/shared/lib/composables/use-media-query", () => ({
  useMobile: () => ref(true),
}));

class ResizeObserverStub {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_cb: ResizeObserverCallback) {}
}

import EmojiPicker from "../EmojiPicker.vue";

describe("EmojiPicker — sticky section headers are fully opaque", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders sticky section headers without /opacity suffix and without backdrop-blur", async () => {
    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "input", x: 0, y: 0 },
      attachTo: document.body,
    });
    // First tick mounts the Teleport target; the second flushes the watcher
    // that publishes the panel size and reveals the category sections.
    await nextTick();
    await nextTick();

    // Picker uses `<Teleport to="body">` so its DOM lives outside wrapper.vm.
    // Scope the query via `.emoji-panel` (the picker root class) so other
    // unrelated sticky elements that might appear in body never feed into
    // this assertion.
    const stickyHeaders = document.querySelectorAll(
      ".emoji-panel .sticky.top-0",
    );
    expect(stickyHeaders.length).toBeGreaterThan(0);

    stickyHeaders.forEach((header) => {
      const cls = header.getAttribute("class") ?? "";
      expect(cls).toContain("bg-background-total-theme");
      // No Tailwind /opacity suffix on the background — would bleed through.
      expect(cls).not.toMatch(/bg-background-total-theme\/\d+/);
      // No backdrop-blur — same root cause (glass effect leaks emoji below).
      expect(cls).not.toMatch(/backdrop-blur/);
    });

    wrapper.unmount();
  });
});
