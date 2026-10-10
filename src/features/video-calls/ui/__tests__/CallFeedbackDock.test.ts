// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const openBugReport = vi.fn();
vi.mock("@/features/bug-report", () => ({
  useBugReport: () => ({ open: openBugReport }),
}));

// vi.mock is hoisted above module init, and the locale store reads `isNative`
// at import time — so the mutable holder has to be hoisted with it.
const platform = vi.hoisted(() => ({ isNative: false }));
vi.mock("@/shared/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/platform")>()),
  get isNative() {
    return platform.isNative;
  },
}));

import CallFeedbackDock from "../CallFeedbackDock.vue";
import {
  useCallFeedbackPrompt,
  __resetCallFeedbackPromptForTests,
} from "../../model/use-call-feedback-prompt";

/** happy-dom evaluates media queries against its own internal viewport, which
 *  `window.innerWidth` does not drive — so stub matchMedia, as the rest of the
 *  suite does. This stub keeps its listeners so a width change can be delivered
 *  to a mounted dock, not just read once during setup. */
let viewportWidth = 1280;
const mobileListeners = new Set<(event: MediaQueryListEvent) => void>();
const isMobileQuery = (query: string) => /max-width:\s*767px/.test(query);

vi.stubGlobal("matchMedia", (query: string) => ({
  get matches() {
    return isMobileQuery(query) && viewportWidth <= 767;
  },
  addEventListener: (_: string, cb: (event: MediaQueryListEvent) => void) => {
    if (isMobileQuery(query)) mobileListeners.add(cb);
  },
  removeEventListener: (_: string, cb: (event: MediaQueryListEvent) => void) => {
    mobileListeners.delete(cb);
  },
}));

function setViewportWidth(width: number): void {
  viewportWidth = width;
  const event = { matches: width <= 767 } as MediaQueryListEvent;
  for (const listener of mobileListeners) listener(event);
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetCallFeedbackPromptForTests();
  platform.isNative = false;
  openBugReport.mockClear();
  mobileListeners.clear();
  setViewportWidth(1280);
});

afterEach(() => {
  __resetCallFeedbackPromptForTests();
});

describe("CallFeedbackDock", () => {
  it("draws the card inside the chat column on a desktop viewport", async () => {
    const { show, isDocked } = useCallFeedbackPrompt();
    const wrapper = mount(CallFeedbackDock);

    expect(isDocked.value).toBe(true);
    show(12);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="call-feedback-good"]').exists()).toBe(true);
    wrapper.unmount();
    expect(isDocked.value).toBe(false);
  });

  it("lines the card up with the composer instead of stretching the column", async () => {
    const { show } = useCallFeedbackPrompt();
    const wrapper = mount(CallFeedbackDock);
    show(12);
    await wrapper.vm.$nextTick();

    // shrink-0 keeps the message list, not the dock, absorbing the height.
    expect(wrapper.find("div").classes()).toContain("shrink-0");
    expect(wrapper.find(".mx-auto").classes()).toContain("max-w-6xl");
    wrapper.unmount();
  });

  it("declines to dock on the mobile layout so the overlay stays in charge", async () => {
    setViewportWidth(500);
    const { show, isDocked } = useCallFeedbackPrompt();
    const wrapper = mount(CallFeedbackDock);
    show(12);
    await wrapper.vm.$nextTick();

    expect(isDocked.value).toBe(false);
    expect(wrapper.find('[data-testid="call-feedback-good"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("declines to dock in a native shell at any width", async () => {
    platform.isNative = true;
    const { show, isDocked } = useCallFeedbackPrompt();
    const wrapper = mount(CallFeedbackDock);
    show(12);
    await wrapper.vm.$nextTick();

    expect(isDocked.value).toBe(false);
    expect(wrapper.find('[data-testid="call-feedback-good"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("follows the viewport across the breakpoint without remounting", async () => {
    // The registration runs in a watch precisely so a live flip releases the
    // dock; a watchEffect here would self-recurse on the counter it increments.
    const { show, isDocked } = useCallFeedbackPrompt();
    const wrapper = mount(CallFeedbackDock);
    show(12);
    await wrapper.vm.$nextTick();
    expect(isDocked.value).toBe(true);

    setViewportWidth(500);
    await wrapper.vm.$nextTick();
    expect(isDocked.value).toBe(false);
    expect(wrapper.find('[data-testid="call-feedback-good"]').exists()).toBe(false);

    setViewportWidth(1280);
    await wrapper.vm.$nextTick();
    expect(isDocked.value).toBe(true);
    expect(wrapper.find('[data-testid="call-feedback-good"]').exists()).toBe(true);

    wrapper.unmount();
    expect(isDocked.value).toBe(false);
  });

  it("hides the card when it is dismissed from the dock", async () => {
    const { visible, show } = useCallFeedbackPrompt();
    const wrapper = mount(CallFeedbackDock);
    show(12);
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-testid="call-feedback-close"]').trigger("click");

    expect(visible.value).toBe(false);
    expect(openBugReport).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
