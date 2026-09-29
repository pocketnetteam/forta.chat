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

type CallRecord = Pick<Message, "id" | "_key" | "callInfo">;

/**
 * Maps every id {@link dedupeCallEvents} drops onto the id that survived it.
 *
 * Anything holding a message id across the collapse needs this. The read
 * watermark is the case that bites: the second hangup is the newest event in
 * the room, so it is exactly what "last read" tends to name — and once that
 * record is collapsed away, a lookup for its id finds nothing at all.
 */
export function collapsedCallEventIds(
  messages: readonly CallRecord[],
): Map<string, string> {
  const survivors = new Map<string, CallRecord>();
  const collapsed = new Map<string, string>();

  for (const message of messages) {
    const callId = message.callInfo?.callId;
    if (!callId) continue;

    const survivor = survivors.get(callId);
    if (!survivor) {
      survivors.set(callId, message);
      continue;
    }

    // Callers match on either id, so either one resolves the anchor.
    const survivorId = survivor._key ?? survivor.id;
    if (message.id) collapsed.set(message.id, survivorId);
    if (message._key) collapsed.set(message._key, survivorId);
  }

  return collapsed;
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
