// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

vi.mock("@/shared/lib/composables/use-android-back-handler", () => ({ useAndroidBackHandler: vi.fn() }));
vi.mock("@/shared/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

const mockIsMobile = { value: false };
vi.mock("@/shared/lib/composables/use-media-query", () => ({
  useMobile: () => mockIsMobile,
}));

let mockIsNative = false;
vi.mock("@/shared/lib/platform", () => ({
  get isNative() {
    return mockIsNative;
  },
}));

import Modal from "../Modal.vue";

/**
 * The shared modal: a centered card with the scrollbar at the screen edge on
 * desktop, a bottom sheet that closes with a downward swipe on phones.
 */
function setSheetLayout(isSheet: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: isSheet && query.includes("max-width: 639px"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function touch(y: number, x = 100) {
  return { touches: [{ clientX: x, clientY: y }] };
}

function mountModal(props: Record<string, unknown> = {}) {
  return mount(Modal, {
    props: { show: true, ...props },
    slots: { default: "<div class='content'>Body</div>" },
    global: { stubs: { teleport: true, transition: false } },
  });
}

const card = (w: ReturnType<typeof mountModal>) => w.find('[role="dialog"]');

describe("Modal", () => {
  beforeEach(() => {
    setSheetLayout(true);
    mockIsMobile.value = false;
    mockIsNative = false;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("closes from the corner button, the in-sheet button and the backdrop", async () => {
    const w = mountModal();
    await w.find('[data-testid="modal-close"]').trigger("click");
    await w.find('[data-testid="modal-close-inline"]').trigger("click");
    await w.find('[data-testid="modal-scroller"]').trigger("click");
    expect(w.emitted("close")).toHaveLength(3);
  });

  it("does not close on a click inside the card", async () => {
    const w = mountModal();
    await w.find(".content").trigger("click");
    expect(w.emitted("close")).toBeUndefined();
  });

  it("isolates the viewport-sized root with contain: strict", () => {
    expect(mountModal().find(".modal-root").classes()).toContain("contain-strict");
  });

  it("pads the content unless bare", () => {
    expect(mountModal().find(".modal-body").classes()).toContain("p-6");
    expect(mountModal({ bare: true }).find(".modal-body").classes()).not.toContain("p-6");
  });

  it("uses the wider desktop width for size lg", () => {
    expect(card(mountModal()).classes()).toContain("sm:max-w-lg");
    expect(card(mountModal({ size: "lg" })).classes()).toContain("sm:max-w-2xl");
  });

  it("closes the sheet on a downward swipe and keeps the offset for the slide-out", async () => {
    const w = mountModal();
    await card(w).trigger("touchstart", touch(100));
    await card(w).trigger("touchmove", touch(400));
    expect(card(w).attributes("style")).toContain("translateY(300px)");
    await card(w).trigger("touchend");
    expect(w.emitted("close")).toHaveLength(1);
    expect(card(w).attributes("style")).toContain("translateY(300px)");
  });

  it("snaps back after a short drag", async () => {
    const w = mountModal();
    vi.spyOn(card(w).element as HTMLElement, "offsetHeight", "get").mockReturnValue(600);
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    await card(w).trigger("touchstart", touch(100));
    now.mockReturnValue(2000);
    await card(w).trigger("touchmove", touch(160));
    await card(w).trigger("touchend");
    expect(w.emitted("close")).toBeUndefined();
    expect(card(w).attributes("style") ?? "").not.toContain("translateY");
    now.mockRestore();
  });

  it("leaves a horizontal drag (a video seek) to the content", async () => {
    const w = mountModal();
    await card(w).trigger("touchstart", touch(100, 100));
    await card(w).trigger("touchmove", touch(130, 300));
    await card(w).trigger("touchmove", touch(400, 300));
    await card(w).trigger("touchend");
    expect(w.emitted("close")).toBeUndefined();
  });

  it("scrolls the content instead of dragging while it is scrolled down", async () => {
    const w = mountModal();
    (w.find(".modal-body").element as HTMLElement).scrollTop = 120;
    await w.find(".content").trigger("touchstart", touch(100));
    await w.find(".content").trigger("touchmove", touch(400));
    await w.find(".content").trigger("touchend");
    expect(w.emitted("close")).toBeUndefined();
  });

  it("does not swipe in the desktop layout", async () => {
    setSheetLayout(false);
    const w = mountModal();
    await card(w).trigger("touchstart", touch(100));
    await card(w).trigger("touchmove", touch(400));
    await card(w).trigger("touchend");
    expect(w.emitted("close")).toBeUndefined();
  });

  it("opens at rest after the previous sheet was swiped closed", async () => {
    const w = mountModal();
    await card(w).trigger("touchstart", touch(100));
    await card(w).trigger("touchmove", touch(400));
    await card(w).trigger("touchend");
    await w.setProps({ show: false });
    await w.setProps({ show: true });
    await nextTick();
    expect(card(w).attributes("style") ?? "").not.toContain("translateY");
  });
});

describe("Modal — initialFocus (keyboard policy)", () => {
  beforeEach(() => {
    setSheetLayout(true);
    mockIsMobile.value = false;
    mockIsNative = false;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function mountWithField(props: Record<string, unknown> = {}) {
    return mount(Modal, {
      props: { show: true, ...props },
      slots: {
        default: '<input data-testid="field" type="text" /><button type="button">Save</button>',
      },
      global: { stubs: { teleport: true, transition: false } },
      attachTo: document.body,
    });
  }

  it("defaults to first-focusable on desktop", async () => {
    const w = mountWithField();
    await nextTick();
    expect(document.activeElement).toBe(w.find('[data-testid="field"]').element);
    w.unmount();
  });

  it("defaults to dialog on mobile (no IME on the first input)", async () => {
    mockIsMobile.value = true;
    const w = mountWithField();
    await nextTick();
    expect(document.activeElement).toBe(card(w).element);
    expect(document.activeElement).not.toBe(w.find('[data-testid="field"]').element);
    w.unmount();
  });

  it("honours initial-focus=first-focusable on mobile for forms", async () => {
    mockIsMobile.value = true;
    const w = mountWithField({ initialFocus: "first-focusable" });
    await nextTick();
    expect(document.activeElement).toBe(w.find('[data-testid="field"]').element);
    w.unmount();
  });

  it("honours initial-focus=none", async () => {
    const w = mountWithField({ initialFocus: "none" });
    await nextTick();
    expect(document.activeElement).not.toBe(w.find('[data-testid="field"]').element);
    w.unmount();
  });
});

