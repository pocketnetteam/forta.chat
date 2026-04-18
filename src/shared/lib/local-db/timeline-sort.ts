import type { LocalMessage } from "./schema";

/** Stable id for timeline ordering (server event or local client id). */
export function localMessageTimelineId(m: LocalMessage): string {
  return m.eventId ?? m.clientId;
}

/** Ascending timeline order: timestamp, then stable id (tie-breaker). */
export function compareLocalMessagesTimelineAsc(a: LocalMessage, b: LocalMessage): number {
  const dt = a.timestamp - b.timestamp;
  if (dt !== 0) return dt;
  return localMessageTimelineId(a).localeCompare(localMessageTimelineId(b));
}

/** Non-mutating sort — chronological oldest → newest. */
export function sortLocalMessagesTimelineAsc(messages: LocalMessage[]): LocalMessage[] {
  return [...messages].sort(compareLocalMessagesTimelineAsc);
}
