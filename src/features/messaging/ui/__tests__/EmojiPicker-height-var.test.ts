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

// Shared ref so individual tests can flip the platform (mobile/desktop) and
// exercise the platform-aware publish guard.
const mockIsMobile = ref(true);
vi.mock("@/shared/lib/composables/use-media-query", () => ({
  useMobile: () => mockIsMobile,
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
    mockIsMobile.value = true;
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

  // Two EmojiPicker instances coexist in the chat tree — one bound to the
  // input panel ("input" mode), one anchored to the long-pressed message
  // ("reaction" mode). Reaction-mode lifecycle must NOT stomp the height
  // published by the input panel, otherwise the chat list collapses while
  // the docked picker is still visible.
  it("reaction-mode lifecycle never overwrites the height published by an open input picker", async () => {
    const input = mount(EmojiPicker, {
      props: { show: true, mode: "input", x: 0, y: 0 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();
    expect(getVar()).toBe(`${FAKE_PICKER_HEIGHT}px`);

    // User long-presses a message — reaction picker mounts on top.
    const reaction = mount(EmojiPicker, {
      props: { show: true, mode: "reaction", x: 100, y: 200 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();
    expect(getVar()).toBe(`${FAKE_PICKER_HEIGHT}px`);

    // Reaction picker closes — input picker is still docked.
    await reaction.setProps({ show: false });
    await nextTick();
    await nextTick();
    expect(getVar()).toBe(`${FAKE_PICKER_HEIGHT}px`);

    reaction.unmount();
    await nextTick();
    expect(getVar()).toBe(`${FAKE_PICKER_HEIGHT}px`);

    input.unmount();
  });
});

// WEE-41: on desktop the picker is a floating popup anchored to the emoji
// button; it does NOT overlay the bottom of the viewport. Publishing
// `--emoji-picker-height` would force MessageList to reserve padding-bottom
// for nothing, leaving a large empty gap below the chat. Session 59's
// push-up mechanism must stay scoped to mobile bottom-sheets only.
describe("EmojiPicker — desktop floating popup must NOT publish picker height", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    document.documentElement.style.setProperty(CSS_VAR, "0px");
    setRectHeight(FAKE_PICKER_HEIGHT);
    mockIsMobile.value = false;
  });

  afterEach(() => {
    document.documentElement.style.setProperty(CSS_VAR, "0px");
    Element.prototype.getBoundingClientRect = originalRect;
    vi.unstubAllGlobals();
    mockIsMobile.value = true;
  });

  it("does NOT publish --emoji-picker-height when opened on desktop in input mode", async () => {
    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "input", x: 0, y: 0 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const v = getVar();
    expect(v === "" || v === "0px").toBe(true);

    wrapper.unmount();
  });

  it("leaves the var at 0px on unmount on desktop (no spurious writes)", async () => {
    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "input", x: 0, y: 0 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    wrapper.unmount();
    await nextTick();
    const v = getVar();
    expect(v === "" || v === "0px").toBe(true);
  });

  // Race scenario: picker opens on mobile (var = 320px), viewport flips to
  // desktop *and then* component unmounts in the same teardown sequence. The
  // dispose hook must reset the var unconditionally for input-mode so
  // MessageList never holds onto a stale padding-bottom after teardown.
  it("clears --emoji-picker-height on unmount even if isMobile flipped to false mid-teardown", async () => {
    mockIsMobile.value = true;
    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "input", x: 0, y: 0 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();
    expect(getVar()).toBe(`${FAKE_PICKER_HEIGHT}px`);

    // Resize to desktop just before unmount — simulate the var still being
    // non-zero (e.g. watcher hasn't fired yet).
    mockIsMobile.value = false;
    document.documentElement.style.setProperty(CSS_VAR, "240px");

    wrapper.unmount();
    await nextTick();
    expect(getVar()).toBe("0px");
  });

  // Belt-and-braces: a stale non-zero var left over by an earlier mobile
  // instance (e.g. on a resize from mobile→desktop) must be cleared once the
  // desktop picker mounts, otherwise MessageList keeps the bottom gap.
  it("clears any stale non-zero --emoji-picker-height when mounting on desktop", async () => {
    document.documentElement.style.setProperty(CSS_VAR, "240px");

    const wrapper = mount(EmojiPicker, {
      props: { show: true, mode: "input", x: 0, y: 0 },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const v = getVar();
    expect(v === "" || v === "0px").toBe(true);

    wrapper.unmount();
  });
});
