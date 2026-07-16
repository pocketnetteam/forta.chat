import { describe, it, expect, vi } from "vitest";
import { useSwipeGesture } from "../use-swipe-gesture";

/**
 * Regression coverage for WEE-48 / forta-bugs#797.
 *
 * The swipe-to-quote gesture used to fire vibro on every direction past
 * threshold but only emit `reply` when the swipe went LEFT. Users coming
 * from Telegram/WhatsApp swipe in either direction depending on whether the
 * bubble is their own or a peer's, so half of attempts silently no-op'd
 * after the vibration. MessageBubble.vue now wires BOTH triggers to the
 * same emit; this suite locks in the underlying gesture contract.
 */
describe("useSwipeGesture — bidirectional trigger contract", () => {
  const synthTouch = (clientX: number, clientY = 0): Touch => ({
    clientX,
    clientY,
    identifier: 0,
    pageX: clientX,
    pageY: clientY,
    radiusX: 0,
    radiusY: 0,
    rotationAngle: 0,
    force: 0,
    screenX: clientX,
    screenY: clientY,
    target: document.body,
  });

  const touchEvent = (type: string, x: number): TouchEvent => {
    const ev = new Event(type, { bubbles: true }) as TouchEvent;
    Object.defineProperty(ev, "touches", { value: [synthTouch(x)] });
    Object.defineProperty(ev, "preventDefault", { value: vi.fn(), writable: false });
    return ev;
  };

  it("calls onTriggerLeft when the user drags left past threshold", () => {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    const g = useSwipeGesture({ direction: "both", threshold: 60, onTriggerLeft: onLeft, onTriggerRight: onRight });
    g.onTouchstart(touchEvent("touchstart", 200));
    g.onTouchmove(touchEvent("touchmove", 100)); // dx = -100
    g.onTouchend();
    expect(onLeft).toHaveBeenCalledOnce();
    expect(onRight).not.toHaveBeenCalled();
  });

  it("calls onTriggerRight when the user drags right past threshold", () => {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    const g = useSwipeGesture({ direction: "both", threshold: 60, onTriggerLeft: onLeft, onTriggerRight: onRight });
    g.onTouchstart(touchEvent("touchstart", 100));
    g.onTouchmove(touchEvent("touchmove", 200)); // dx = +100
    g.onTouchend();
    expect(onRight).toHaveBeenCalledOnce();
    expect(onLeft).not.toHaveBeenCalled();
  });

  it("does NOT trigger when the swipe falls short of threshold", () => {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    const g = useSwipeGesture({ direction: "both", threshold: 60, onTriggerLeft: onLeft, onTriggerRight: onRight });
    g.onTouchstart(touchEvent("touchstart", 200));
    g.onTouchmove(touchEvent("touchmove", 180)); // dx = -20 — below threshold
    g.onTouchend();
    expect(onLeft).not.toHaveBeenCalled();
    expect(onRight).not.toHaveBeenCalled();
  });

  it("emits reply on EITHER direction when both triggers share a handler (peer bubble shape)", () => {
    // Mirrors how MessageBubble.vue wires the gesture for a peer's bubble:
    // both directions call the same triggerReply closure.
    const triggerReply = vi.fn();
    const g = useSwipeGesture({
      direction: "both",
      threshold: 60,
      onTriggerLeft: triggerReply,
      onTriggerRight: triggerReply,
    });
    g.onTouchstart(touchEvent("touchstart", 200));
    g.onTouchmove(touchEvent("touchmove", 100)); // left
    g.onTouchend();
    g.onTouchstart(touchEvent("touchstart", 100));
    g.onTouchmove(touchEvent("touchmove", 200)); // right
    g.onTouchend();
    expect(triggerReply).toHaveBeenCalledTimes(2);
  });

  it("own-bubble shape: left=reply, right=NO reply (right reserved for delete/forward affordance)", () => {
    // MessageBubble.vue uses this shape for `props.isOwn === true` so right
    // swipes still reveal the actions panel without doubling as a quote.
    const triggerReply = vi.fn();
    const ownBubble = useSwipeGesture({
      direction: "both",
      threshold: 60,
      onTriggerLeft: triggerReply,
      onTriggerRight: () => { /* own bubble: no reply on right */ },
    });
    ownBubble.onTouchstart(touchEvent("touchstart", 100));
    ownBubble.onTouchmove(touchEvent("touchmove", 200)); // right
    ownBubble.onTouchend();
    expect(triggerReply).not.toHaveBeenCalled();
    ownBubble.onTouchstart(touchEvent("touchstart", 200));
    ownBubble.onTouchmove(touchEvent("touchmove", 100)); // left
    ownBubble.onTouchend();
    expect(triggerReply).toHaveBeenCalledOnce();
  });
});
