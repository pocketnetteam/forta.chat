import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";

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

// Force mobile so the input-mode branch (which docks the picker and publishes
// height) is exercised.
vi.mock("@/shared/lib/composables/use-media-query", () => ({
  useMobile: () => ref(true),
}));

// Local ResizeObserver mock — happy-dom doesn't deliver observe callbacks.
// The picker only relies on the initial publish via getBoundingClientRect(),
// so an empty stub is enough to keep the watcher from throwing.
class ResizeObserverStub {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_cb: ResizeObserverCallback) {}
}

// happy-dom's getBoundingClientRect returns all-zero for un-laid-out elements,
// so the picker would publish "0px" without this override. We patch the
// prototype to report a stable 320px height for any element queried during
// the test.
const FAKE_PICKER_HEIGHT = 320;
const originalRect = Element.prototype.getBoundingClientRect;

import EmojiPicker from "../EmojiPicker.vue";

const CSS_VAR = "--emoji-picker-height";

const getVar = () => document.documentElement.style.getPropertyValue(CSS_VAR);

const setRectHeight = (h: number) => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: h,
      right: 0,
      width: 0,
      height: h,
      toJSON() {
        return {};
      },
    } as DOMRect;
  };
};

describe("EmojiPicker — publishes --emoji-picker-height", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    document.documentElement.style.setProperty(CSS_VAR, "0px");
    setRectHeight(FAKE_PICKER_HEIGHT);
  });

  afterEach(() => {
    document.documentElement.style.setProperty(CSS_VAR, "0px");
    Element.prototype.getBoundingClientRect = originalRect;
    vi.unstubAllGlobals();
  });

  it("publishes a non-zero height when shown in input mode on mobile", async () => {
    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "input", x: 0, y: 0 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    expect(getVar()).toBe(`${FAKE_PICKER_HEIGHT}px`);

    wrapper.unmount();
  });

  it("resets --emoji-picker-height to 0px on unmount", async () => {
    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "input", x: 0, y: 0 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();
    expect(getVar()).toBe(`${FAKE_PICKER_HEIGHT}px`);

    wrapper.unmount();
    await nextTick();
    expect(getVar()).toBe("0px");
  });

  it("does not publish height for reaction mode (popover near button)", async () => {
    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "reaction", x: 100, y: 200 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    expect(getVar()).toBe("0px");

    wrapper.unmount();
  });

  it("clears the var when `show` flips false (closed by user)", async () => {
    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "input", x: 0, y: 0 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();
    expect(getVar()).toBe(`${FAKE_PICKER_HEIGHT}px`);

    await wrapper.setProps({ show: false });
    await nextTick();
    await nextTick();
    expect(getVar()).toBe("0px");

    wrapper.unmount();
  });
});
