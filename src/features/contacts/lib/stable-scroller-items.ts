/**
 * RecycleScroller (vue-virtual-scroller 2.x) resets its whole view pool on every change of
 * `items` and hands the views back out LIFO, so each row lands in a different DOM view (and a
 * different Avatar instance) on every update: its <img> reloads and the avatars blink on each
 * incoming message. Keep handing the scroller the previous array while the key sequence is the
 * same; the row reads its fresh data by key instead.
 */
export function reuseIfSameKeys<T extends { _key: string }>(prev: readonly T[] | null, next: T[]): T[] {
  if (!prev || prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    if (prev[i]._key !== next[i]._key) return next;
  }
  return prev as T[];
}
