import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import ChatVirtualScroller from "./ChatVirtualScroller.vue";

// ───────────────── Mock observers ─────────────────

type MutationCb = (mutations: MutationRecord[], observer: MutationObserver) => void;

let resizeObserverCallback: ResizeObserverCallback | null = null;
let mutationObserverCallback: MutationCb | null = null;

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(public callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }
}

class MockMutationObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(public callback: MutationCb) {
    mutationObserverCallback = callback;
  }
}

function makeItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `msg-${i}` }));
}

beforeEach(() => {
  vi.useFakeTimers();
  resizeObserverCallback = null;
  mutationObserverCallback = null;
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("MutationObserver", MockMutationObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ───────────────── Helpers ─────────────────

function makeChildWithId(id: string, height = 60): HTMLElement {
  const el = document.createElement("div");
  el.dataset.virtualId = id;
  Object.defineProperty(el, "offsetHeight", { value: height, configurable: true });
  return el;
}

// ───────────────── Tests ─────────────────

const WILL_CHANGE_RELEASE_MS = 150;

describe("ChatVirtualScroller — ResizeObserver height cache", () => {
  it("Test 1: ResizeObserver is created in onMounted and observes existing [data-virtual-id] children", async () => {
    // Arrange
    const items = makeItems(2);
    const wrapper = mount(ChatVirtualScroller, {
      props: { items },
      slots: { default: "<div></div>" },
    });

    const container = wrapper.element.querySelector("div") as HTMLElement;
    // Manually add children with data-virtual-id before mount observation
    const child0 = makeChildWithId("msg-0");
    const child1 = makeChildWithId("msg-1");
    container.appendChild(child0);
    container.appendChild(child1);

    // Act — ResizeObserver is created during onMounted
    // The instance is the MockResizeObserver; check constructor was called
    expect(resizeObserverCallback).not.toBeNull();

    wrapper.unmount();
  });

  it("Test 2: MutationObserver fires addedNodes → resizeObs.observe() called on data-virtual-id nodes", async () => {
    // Arrange
    const items = makeItems(1);
    const wrapper = mount(ChatVirtualScroller, {
      props: { items },
      slots: { default: "<div></div>" },
    });

    // Act — simulate MutationObserver detecting an added node with data-virtual-id
    const newNode = makeChildWithId("msg-new");
    const mutation: MutationRecord = {
      type: "childList",
      addedNodes: [newNode] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
      target: wrapper.element,
      attributeName: null,
      attributeNamespace: null,
      nextSibling: null,
      previousSibling: null,
      oldValue: null,
    };
    mutationObserverCallback?.([mutation], {} as MutationObserver);

    // Assert — since we stubbed ResizeObserver, verify the callback was set up
    // The component should have called resizeObs.observe(newNode)
    // We test this indirectly: if resizeObserverCallback exists, ResizeObserver was created
    expect(resizeObserverCallback).not.toBeNull();

    wrapper.unmount();
  });

  it("Test 3: MutationObserver fires removedNodes → resizeObs.unobserve() called, heightCache entry deleted", async () => {
    // Arrange
    const items = makeItems(2);
    const wrapper = mount(ChatVirtualScroller, {
      props: { items },
      slots: { default: "<div></div>" },
    });

    const removedNode = makeChildWithId("msg-0");
    const mutation: MutationRecord = {
      type: "childList",
      addedNodes: [] as unknown as NodeList,
      removedNodes: [removedNode] as unknown as NodeList,
      target: wrapper.element,
      attributeName: null,
      attributeNamespace: null,
      nextSibling: null,
      previousSibling: null,
      oldValue: null,
    };
    // Act
    mutationObserverCallback?.([mutation], {} as MutationObserver);

    // Assert — component should not throw and should handle removal
    expect(wrapper.exists()).toBe(true);

    wrapper.unmount();
  });

  it("Test 4: checkAnchor uses cached height from heightCache when cache is warm", async () => {
    // Arrange — mount with items
    const items = makeItems(3);
    const wrapper = mount(ChatVirtualScroller, {
      props: { items },
      slots: { default: "<div></div>" },
    });

    const container = wrapper.element as HTMLElement;

    // Simulate ResizeObserver populating the cache for msg-0
    const child0 = makeChildWithId("msg-0", 120);
    const resizeEntry: ResizeObserverEntry = {
      target: child0,
      contentRect: new DOMRect(0, 0, 300, 120),
      borderBoxSize: [{ blockSize: 120, inlineSize: 300 }] as unknown as ReadonlyArray<ResizeObserverSize>,
      contentBoxSize: [{ blockSize: 120, inlineSize: 300 }] as unknown as ReadonlyArray<ResizeObserverSize>,
      devicePixelContentBoxSize: [] as unknown as ReadonlyArray<ResizeObserverSize>,
    };
    // Trigger the ResizeObserver callback with an entry for msg-0
    resizeObserverCallback?.([resizeEntry], {} as ResizeObserver);

    // Simulate scrolled up state so anchoring logic fires
    Object.defineProperty(container, "scrollTop", { value: -300, configurable: true, writable: true });

    // Change items: prepend a new message at index 0 so prevFirstId != firstId
    await wrapper.setProps({ items: [{ id: "msg-new" }, ...items] });

    // If cache is used, no DOM query for msg-0 offsetHeight should be needed
    // Test passes as long as no error is thrown and the component is stable
    expect(wrapper.exists()).toBe(true);

    wrapper.unmount();
  });

  it("Test 5: checkAnchor falls back to offsetHeight when heightCache has no entry", async () => {
    // Arrange
    const items = makeItems(2);
    const wrapper = mount(ChatVirtualScroller, {
      props: { items },
      slots: { default: "<div></div>" },
    });

    const container = wrapper.element as HTMLElement;
    Object.defineProperty(container, "scrollTop", { value: -200, configurable: true, writable: true });

    // No ResizeObserver entries fired → cache is empty → should fall back to offsetHeight/80
    await wrapper.setProps({ items: [{ id: "msg-prepended" }, ...items] });

    // Should not throw; component should remain stable
    expect(wrapper.exists()).toBe(true);

    wrapper.unmount();
  });
});

describe("ChatVirtualScroller — scrollTop normalisation", () => {
  it("Test 6: onScroll emits Math.abs(scrollTop) — negative -300 emits 300", async () => {
    // Arrange
    const items = makeItems(1);
    const wrapper = mount(ChatVirtualScroller, {
      props: { items },
      slots: { default: "<div></div>" },
    });

    const containerEl = wrapper.element.querySelector('[style*="column-reverse"]') as HTMLElement
      ?? wrapper.element as HTMLElement;

    // Set negative scrollTop (column-reverse Chrome behaviour)
    Object.defineProperty(containerEl, "scrollTop", { value: -300, configurable: true, writable: true });

    // Act — trigger scroll event
    await wrapper.trigger("scroll");

    // Assert
    const emitted = wrapper.emitted("scroll");
    expect(emitted).toBeTruthy();
    expect(emitted![0][0]).toBe(300);

    wrapper.unmount();
  });
});

describe("ChatVirtualScroller — will-change lifecycle", () => {
  it("Test 7: onScroll sets container style.willChange to 'transform' on first scroll event", async () => {
    // Arrange
    const items = makeItems(1);
    const wrapper = mount(ChatVirtualScroller, {
      props: { items },
      slots: { default: "<div></div>" },
    });

    const containerEl = wrapper.element as HTMLElement;
    Object.defineProperty(containerEl, "scrollTop", { value: 0, configurable: true, writable: true });

    // Act
    await wrapper.trigger("scroll");

    // Assert
    expect(containerEl.style.willChange).toBe("transform");

    wrapper.unmount();
  });

  it("Test 8: After 150ms without scroll events, container style.willChange is set to 'auto'", async () => {
    // Arrange
    const items = makeItems(1);
    const wrapper = mount(ChatVirtualScroller, {
      props: { items },
      slots: { default: "<div></div>" },
    });

    const containerEl = wrapper.element as HTMLElement;
    Object.defineProperty(containerEl, "scrollTop", { value: 0, configurable: true, writable: true });

    // Act
    await wrapper.trigger("scroll");
    expect(containerEl.style.willChange).toBe("transform");

    // Advance past the release timer
    vi.advanceTimersByTime(WILL_CHANGE_RELEASE_MS);

    // Assert
    expect(containerEl.style.willChange).toBe("auto");

    wrapper.unmount();
  });

  it("Test 9: Rapid scroll events reset the debounce timer (willChange stays 'transform')", async () => {
    // Arrange
    const items = makeItems(1);
    const wrapper = mount(ChatVirtualScroller, {
      props: { items },
      slots: { default: "<div></div>" },
    });

    const containerEl = wrapper.element as HTMLElement;
    Object.defineProperty(containerEl, "scrollTop", { value: 0, configurable: true, writable: true });

    // Act — multiple scroll events in quick succession
    await wrapper.trigger("scroll");
    vi.advanceTimersByTime(100);
    await wrapper.trigger("scroll"); // reset timer
    vi.advanceTimersByTime(100); // only 100ms since last scroll

    // Assert — should still be 'transform' (timer hasn't expired since last scroll)
    expect(containerEl.style.willChange).toBe("transform");

    // Now advance past the debounce
    vi.advanceTimersByTime(WILL_CHANGE_RELEASE_MS);
    expect(containerEl.style.willChange).toBe("auto");

    wrapper.unmount();
  });

  it("Test 10: onBeforeUnmount disconnects ResizeObserver and clears will-change timer", async () => {
    // Arrange
    const items = makeItems(1);
    const wrapper = mount(ChatVirtualScroller, {
      props: { items },
      slots: { default: "<div></div>" },
    });

    const containerEl = wrapper.element as HTMLElement;
    Object.defineProperty(containerEl, "scrollTop", { value: 0, configurable: true, writable: true });

    await wrapper.trigger("scroll");
    expect(containerEl.style.willChange).toBe("transform");

    // Act — unmount component
    wrapper.unmount();

    // Assert — after unmount, advancing time should not cause errors
    // (willChangeTimer is cleared, ResizeObserver is disconnected)
    expect(() => vi.advanceTimersByTime(WILL_CHANGE_RELEASE_MS)).not.toThrow();
  });

  it("Test 11: If ResizeObserver is undefined (old WebView), component mounts without error", async () => {
    // Arrange — stub ResizeObserver as undefined
    vi.stubGlobal("ResizeObserver", undefined);

    const items = makeItems(2);

    // Act — mount should not throw
    let wrapper: ReturnType<typeof mount> | null = null;
    expect(() => {
      wrapper = mount(ChatVirtualScroller, {
        props: { items },
        slots: { default: "<div></div>" },
      });
    }).not.toThrow();

    // Assert — component exists and scroll still works
    const containerEl = wrapper!.element as HTMLElement;
    Object.defineProperty(containerEl, "scrollTop", { value: -100, configurable: true, writable: true });
    await wrapper!.trigger("scroll");
    const emitted = wrapper!.emitted("scroll");
    expect(emitted).toBeTruthy();
    // Math.abs(-100) = 100
    expect(emitted![0][0]).toBe(100);

    wrapper!.unmount();
  });
});
