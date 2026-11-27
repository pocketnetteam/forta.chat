/**
 * @deprecated Android inset cross-check lives inside `useKeyboardInsets`
 * (`@/shared/lib/keyboard`). This stub remains so any stray import compiles;
 * App.vue must call `useKeyboardInsets()` once instead.
 */
export function useKeyboardFallback(): void {
  // no-op — see useKeyboardInsets
}
