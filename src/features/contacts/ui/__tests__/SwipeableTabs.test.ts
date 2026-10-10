// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import SwipeableTabs from "../SwipeableTabs.vue";

const TABS = ["all", "personal", "groups"];
const WIDTH = 300;

function mountTabs(modelValue = "all") {
  const wrapper = mount(SwipeableTabs, {
    props: { tabs: TABS, modelValue },
    attachTo: document.body,
  });
  const el = wrapper.element as HTMLElement;
  Object.defineProperty(el, "clientWidth", { configurable: true, value: WIDTH });
  el.scrollTo = vi.fn() as unknown as typeof el.scrollTo;
  return { wrapper, el };
}

function scrollTo(el: HTMLElement, left: number) {
  el.scrollLeft = left;
  el.dispatchEvent(new Event("scroll"));
}

describe("SwipeableTabs — scroll progress for the tab indicator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("после свайпа прогресс сбрасывается в null — индикатор снова следует за выбранной вкладкой", async () => {
    const { wrapper, el } = mountTabs();

    scrollTo(el, WIDTH * 0.5);
    scrollTo(el, WIDTH);
    vi.advanceTimersByTime(100);

    const progress = wrapper.emitted("scrollProgress")!.map(([p]) => p);
    expect(progress).toEqual([0.5, 1, null]);
    expect(wrapper.emitted("update:modelValue")).toEqual([["personal"]]);
    wrapper.unmount();
  });

  it("тап по вкладке сразу сбрасывает прогресс и игнорирует хвост плавной прокрутки", async () => {
    const { wrapper, el } = mountTabs();

    await wrapper.setProps({ modelValue: "groups" });
    expect(wrapper.emitted("scrollProgress")).toEqual([[null]]);

    // Smooth scroll toward "groups" running longer than the initial 400ms guard.
    for (let t = 0; t < 8; t++) {
      scrollTo(el, (WIDTH * 2 * (t + 1)) / 8);
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(200);

    // No intermediate positions leaked out — the indicator stayed on "groups".
    expect(wrapper.emitted("scrollProgress")).toEqual([[null]]);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    wrapper.unmount();
  });
});
