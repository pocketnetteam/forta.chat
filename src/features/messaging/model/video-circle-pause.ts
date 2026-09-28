/**
 * Video circles the user stopped, for this app session.
 *
 * A circle autoplays muted while it is on screen. It used to start again every
 * time it scrolled back into view, even after the user paused it, and a circle
 * played with sound looped forever (audit W2C-03). The pause is kept outside
 * the component so it survives leaving and reopening the chat.
 */
const pausedByUser = new Set<string>();

export function markCirclePausedByUser(key: string): void {
  pausedByUser.add(key);
}

export function clearCirclePausedByUser(key: string): void {
  pausedByUser.delete(key);
}

export function isCirclePausedByUser(key: string): boolean {
  return pausedByUser.has(key);
}

/** What a circle does when it reaches the end: a muted preview loops; playback
 *  the user started with sound stops there. */
export function circleActionOnEnded(isMuted: boolean): "loop" | "stop" {
  return isMuted ? "loop" : "stop";
}

/** Test-only. */
export function __resetCirclePausesForTests(): void {
  pausedByUser.clear();
}
