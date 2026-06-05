import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";

// WEE-34 / forta-bugs#807: opening the emoji picker must NOT auto-focus the
// search input. On mobile the focus pops the on-screen keyboard, which covers
// the emoji grid — the user has to tap the input themselves to search.

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

const mockIsMobile = ref(true);
vi.mock("@/shared/lib/composables/use-media-query", () => ({
  useMobile: () => mockIsMobile,
}));

class ResizeObserverStub {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_cb: ResizeObserverCallback) {}
}

import EmojiPicker from "../EmojiPicker.vue";

describe("EmojiPicker — does not auto-focus search input on open", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    mockIsMobile.value = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  it("leaves no INPUT focused after the picker opens (reaction mode)", async () => {
    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "reaction", x: 100, y: 200 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const active = document.activeElement;
    expect(active?.tagName).not.toBe("INPUT");

    wrapper.unmount();
  });

  it("leaves no INPUT focused after the picker opens (input mode)", async () => {
    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "input", x: 0, y: 0 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    expect(document.activeElement?.tagName).not.toBe("INPUT");

    wrapper.unmount();
  });

  it("does not focus the input even when toggled open after mount", async () => {
    const wrapper = mount(EmojiPicker, {
      props: { show: false, mode: "reaction", x: 100, y: 200 },
      attachTo: document.body,
    });
    await nextTick();

    await wrapper.setProps({ show: true });
    await nextTick();
    await nextTick();

    expect(document.activeElement?.tagName).not.toBe("INPUT");

    wrapper.unmount();
  });
});
