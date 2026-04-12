import { shallowRef } from "vue";

/**
 * Module-level singleton: one resize listener shared across all consumers.
 * Avoids N listeners when N MessageBubbles (or other components) each need viewport width.
 */
const _viewportW = shallowRef(typeof window !== "undefined" ? window.innerWidth : 800);
let _listenerCount = 0;

const _onResize = () => { _viewportW.value = window.innerWidth; };

export function useViewportWidth() {
  return _viewportW;
}

export function mountViewportListener() {
  if (++_listenerCount === 1) {
    window.addEventListener("resize", _onResize);
  }
}

export function unmountViewportListener() {
  if (--_listenerCount === 0) {
    window.removeEventListener("resize", _onResize);
  }
}
