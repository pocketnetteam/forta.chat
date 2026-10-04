import type { Message } from "../model/types";

/**
 * Collapses the duplicate call records a single call can leave in a room.
 *
 * Matrix records one `m.call.hangup` per participant who ends the call, so when
 * both sides hang up — which happens constantly, since the other person taps
 * the red button the moment you do — the room carries two events with different
 * event ids describing the same call. The timeline then shows the call twice.
 * Users report this as "I called twice and got four call entries" (#1027).
 *
 * Keeps the first record for each `callId` in the order given, so the surviving
 * entry is the earliest one and nothing else in the timeline shifts. Records
 * from before `callId` was stored have no id to group on and are all kept —
 * dropping them on some other heuristic would silently rewrite old history.
 *
 * A deleted call record goes too (#1091): a card has no "deleted" placeholder,
 * so without this a call deleted for oneself stayed on screen.
 */
export function dedupeCallEvents<T extends { callInfo?: Message["callInfo"]; deleted?: boolean }>(
  messages: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];

  for (const message of messages) {
    if (message.callInfo && message.deleted) continue;
    const callId = message.callInfo?.callId;
    if (!callId) {
      out.push(message);
      continue;
    }
    if (seen.has(callId)) continue;
    seen.add(callId);
    out.push(message);
  }

  return out;
}

type Keyed = Pick<Message, "id" | "_key">;

/**
 * Where the unread banner anchors when the read watermark names a row the
 * timeline does not show.
 *
 * {@link dedupeCallEvents} drops rows the watermark tends to name: the second
 * hangup of a call is usually the newest event in the room, and a call record
 * deleted for oneself vanishes too. Looking the dropped id up in the timeline
 * finds nothing and the banner never renders. The anchor moves to the nearest
 * shown row before the watermark: everything up to it was read.
 *
 * Returns `anchorId` when it is shown or not loaded at all (nothing to correct
 * yet), the stable id of the nearest earlier shown row, or `null` when no shown
 * row precedes it — the banner then belongs above the first unread row.
 */
export function timelineAnchorFor(
  raw: readonly Keyed[],
  shown: readonly Keyed[],
  anchorId: string,
): string | null {
  const shownIds = new Set<string>();
  for (const m of shown) {
    if (m.id) shownIds.add(m.id);
    if (m._key) shownIds.add(m._key);
  }
  if (shownIds.has(anchorId)) return anchorId;

  const at = raw.findIndex((m) => m.id === anchorId || m._key === anchorId);
  if (at < 0) return anchorId;
  for (let i = at - 1; i >= 0; i--) {
    const m = raw[i];
    if (shownIds.has(m.id) || (m._key && shownIds.has(m._key))) return m._key ?? m.id;
  }
  return null;
}

type CallRecordOwner = Pick<Message, "id" | "senderId" | "callInfo">;

/**
 * Which events to delete for one call record, and which of them may be deleted
 * for everyone (forta-bugs#1091).
 *
 * The timeline shows one card per call ({@link dedupeCallEvents}), but the room
 * can hold a hangup from each side: deleting only the card's own event would
 * just bring the other one up in its place. So the whole call goes. Only the
 * user's own events are redacted on the server — the other side's hangup is
 * theirs, and a redaction of it would be refused — the rest is hidden here.
 */
export function planCallRecordDeletion(
  messages: readonly CallRecordOwner[],
  record: CallRecordOwner,
  myAddress: string | null | undefined,
  forEveryone: boolean,
): Array<{ id: string; forEveryone: boolean }> {
  const callId = record.callInfo?.callId;
  const events = callId ? messages.filter((m) => m.callInfo?.callId === callId) : [record];
  if (!events.some((m) => m.id === record.id)) events.push(record);
  return events.map((m) => ({ id: m.id, forEveryone: forEveryone && !!myAddress && m.senderId === myAddress }));
}
