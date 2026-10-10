// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useLongPress, hasTextSelectionIn } from "../use-long-press";

/**
 * Audit W2C-01: on Android the long press that arms the message menu also
 * starts a native text selection, and the menu opened over the handles.
 */
describe("hasTextSelectionIn", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  const select = (node: Node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  };

  it("sees text selected inside the element", () => {
    document.body.innerHTML = '<div id="a"><p id="t">hello world</p></div><div id="b">other</div>';
    select(document.getElementById("t")!);
    expect(hasTextSelectionIn(document.getElementById("a"))).toBe(true);
    expect(hasTextSelectionIn(document.getElementById("b"))).toBe(false);
  });

  it("ignores an empty selection and a missing element", () => {
    document.body.innerHTML = '<div id="a">text</div>';
    expect(hasTextSelectionIn(document.getElementById("a"))).toBe(false);
    expect(hasTextSelectionIn(null)).toBe(false);
  });
});

describe("useLongPress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fire once the browser cancels the pointer (it took the gesture over)", () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const lp = useLongPress({ onTrigger });
    lp.onPointerdown({ clientX: 0, clientY: 0 } as PointerEvent);
    lp.onPointercancel();
    vi.advanceTimersByTime(1000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("is wired into the message bubble", () => {
    const bubble = readFileSync(resolve(__dirname, "../../../../features/messaging/ui/MessageBubble.vue"), "utf-8");
    expect(bubble).toContain('@pointercancel="onPointercancel"');
    expect(bubble).toContain("if (hasTextSelectionIn(pressedBubble)) return;");
  });
});
