/**
 * Calls `onEnded` once when the browser ends a screen-share capture on its own
 * (Chrome's "Stop sharing" bar, a closed shared window). The SDK does not
 * listen for this, so without it the call keeps a dead screen-share feed and
 * the UI still says "sharing". `track.stop()` from our side fires no event.
 * Returns a disposer that detaches the listeners.
 */
export function onScreenShareEnded(stream: MediaStream | undefined | null, onEnded: () => void): () => void {
  const tracks = stream?.getVideoTracks() ?? [];
  if (tracks.length === 0) return () => {};
  let done = false;
  const handle = () => {
    if (done) return;
    dispose();
    onEnded();
  };
  const dispose = () => {
    done = true;
    for (const t of tracks) t.removeEventListener("ended", handle);
  };
  for (const t of tracks) t.addEventListener("ended", handle);
  if (tracks.some((t) => t.readyState === "ended")) handle();
  return dispose;
}
