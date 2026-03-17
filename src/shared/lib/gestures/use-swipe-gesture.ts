import { ref, type Ref } from "vue";

export interface UseSwipeGestureOptions {
  direction?: "left" | "right" | "both";
  threshold?: number;
  maxOffset?: number;
  /** Called when threshold is reached (for single-direction mode) */
  onTrigger?: () => void;
  /** Called when swiped left past threshold (only for direction: "both") */
  onTriggerLeft?: () => void;
  /** Called when swiped right past threshold (only for direction: "both") */
  onTriggerRight?: () => void;
  /** If true, call navigator.vibrate(10) when threshold is first reached */
  haptic?: boolean;
}

export function useSwipeGesture(options: UseSwipeGestureOptions) {
  const {
    direction = "right",
    threshold = 60,
    maxOffset = 100,
    onTrigger,
    onTriggerLeft,
    onTriggerRight,
    haptic = false,
  } = options;

  const offsetX = ref(0);
  const isSwiping = ref(false);
  const swipeDirection: Ref<"left" | "right" | null> = ref(null);
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let decided = false;
  let hapticFired = false;

  const onTouchstart = (e: TouchEvent) => {
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    tracking = true;
    decided = false;
    hapticFired = false;
    isSwiping.value = false;
    swipeDirection.value = null;
  };

  const onTouchmove = (e: TouchEvent) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    if (!decided) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        decided = true;
        if (Math.abs(dy) > Math.abs(dx)) {
          tracking = false;
          return;
        }
      } else {
        return;
      }
    }

    if (direction === "both") {
      // Support both directions
      if (dx === 0) return;
      const absDx = Math.abs(dx);
      const currentDir: "left" | "right" = dx < 0 ? "left" : "right";
      swipeDirection.value = currentDir;
      isSwiping.value = true;
      offsetX.value = Math.min(absDx, maxOffset);

      if (haptic && !hapticFired && absDx >= threshold) {
        hapticFired = true;
        navigator.vibrate?.(10);
      }

      e.preventDefault();
    } else {
      // Single direction (original behavior)
      const directedDx = direction === "right" ? dx : -dx;
      if (directedDx < 0) {
        offsetX.value = 0;
        return;
      }

      isSwiping.value = true;
      swipeDirection.value = direction;
      offsetX.value = Math.min(directedDx, maxOffset);

      if (haptic && !hapticFired && directedDx >= threshold) {
        hapticFired = true;
        navigator.vibrate?.(10);
      }

      e.preventDefault();
    }
  };

  const onTouchend = () => {
    if (isSwiping.value && offsetX.value >= threshold) {
      if (direction === "both") {
        if (swipeDirection.value === "left") {
          onTriggerLeft?.();
        } else if (swipeDirection.value === "right") {
          onTriggerRight?.();
        }
      } else {
        onTrigger?.();
      }
    }
    offsetX.value = 0;
    isSwiping.value = false;
    swipeDirection.value = null;
    tracking = false;
    decided = false;
    hapticFired = false;
  };

  return { offsetX, isSwiping, swipeDirection, onTouchstart, onTouchmove, onTouchend };
}
