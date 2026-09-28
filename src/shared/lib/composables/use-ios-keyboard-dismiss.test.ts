import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";

let mockIsIOS = false;
vi.mock("@/shared/lib/platform", () => ({
  get isIOS() {
    return mockIsIOS;
  },
}));

beforeEach(() => {
  mockIsIOS = false;
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.resetModules();
});

function mountInScope(setupFn: () => unknown) {
  const Comp = defineComponent({
    setup() {
      setupFn();
      return () => h("div");
    },
  });
  return mount(Comp, { attachTo: document.body });
}

describe("shouldKeepKeyboardOpen", () => {
  it("keeps keyboard for focusable fields and data-keyboard-aware chrome", async () => {
    vi.resetModules();
    const { shouldKeepKeyboardOpen } = await import("./use-ios-keyboard-dismiss");

    const root = document.createElement("div");
    root.innerHTML = `
      <div data-keyboard-aware>
        <button id="emoji">emoji</button>
        <textarea id="ta"></textarea>
      </div>
      <div id="outside">messages</div>
      <input id="search" type="text" />
      <input id="file" type="file" />
    `;
    document.body.appendChild(root);

    expect(shouldKeepKeyboardOpen(root.querySelector("#ta"))).toBe(true);
    expect(shouldKeepKeyboardOpen(root.querySelector("#emoji"))).toBe(true);
    expect(shouldKeepKeyboardOpen(root.querySelector("#search"))).toBe(true);
    expect(shouldKeepKeyboardOpen(root.querySelector("#file"))).toBe(false);
    expect(shouldKeepKeyboardOpen(root.querySelector("#outside"))).toBe(false);
    expect(shouldKeepKeyboardOpen(null)).toBe(false);
  });
});

describe("useIOSKeyboardDismiss", () => {
  it("is a no-op when not on iOS", async () => {
    mockIsIOS = false;
    vi.resetModules();
    const { useIOSKeyboardDismiss } = await import("./use-ios-keyboard-dismiss");

    const addSpy = vi.spyOn(document, "addEventListener");
    mountInScope(() => useIOSKeyboardDismiss());
    await nextTick();

    expect(addSpy).not.toHaveBeenCalledWith(
      "pointerdown",
      expect.any(Function),
      true,
    );
    addSpy.mockRestore();
  });

  it("blurs focused textarea when tapping outside; keeps focus for composer chrome", async () => {
    mockIsIOS = true;
    vi.resetModules();
    const { useIOSKeyboardDismiss } = await import("./use-ios-keyboard-dismiss");

    const root = document.createElement("div");
    root.innerHTML = `
      <div data-keyboard-aware>
        <button id="emoji">emoji</button>
        <textarea id="ta"></textarea>
      </div>
      <div id="outside">messages</div>
    `;
    document.body.appendChild(root);

    const wrapper = mountInScope(() => useIOSKeyboardDismiss());
    await nextTick();

    const ta = root.querySelector("#ta") as HTMLTextAreaElement;
    const emoji = root.querySelector("#emoji") as HTMLButtonElement;
    const outside = root.querySelector("#outside") as HTMLDivElement;
    const blurSpy = vi.spyOn(ta, "blur");

    ta.focus();
    expect(document.activeElement).toBe(ta);

    emoji.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(blurSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(ta);

    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(blurSpy).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });
});
