import type { LocalMessage } from "@/shared/lib/local-db";

/**
 * Which SDK timeline events a history load still has to parse (plan
 * 2026-09-28-chat-open-local-first, stage 2). Parsing means decrypting, and
 * the SDK timeline only grows while the app runs, so re-parsing all of it on
 * every room open made each open heavier than the last. Events Dexie already
 * holds in their final form are skipped.
 */

type RawEvent = Record<string, unknown>;
type StoredRow = Pick<LocalMessage, "content" | "decryptionStatus" | "callInfo" | "lastEditTs">;

export type TimelineEventKind = "reaction" | "poll-response" | "poll-end" | "edit" | "message";

/** How parseTimelineEvents treats an event: a relation applied to another
 *  message, or a message event handed to parseSingleEvent. The one
 *  classification both the parser and the parse plan use. */
export function classifyTimelineEvent(raw: RawEvent): TimelineEventKind {
  const type = raw.type;
  const content = raw.content as Record<string, unknown> | undefined;
  if (!content) return "message";
  if (type === "m.reaction") return "reaction";
  if (type === "org.matrix.msc3381.poll.response") return "poll-response";
  if (type === "org.matrix.msc3381.poll.end") return "poll-end";
  if (type === "m.room.message") {
    const isRedacted = Object.keys(content).length === 0
      || !!(raw.unsigned as { redacted_because?: unknown } | undefined)?.redacted_because;
    const rel = content["m.relates_to"] as Record<string, unknown> | undefined;
    if (!isRedacted && rel?.rel_type === "m.replace" && rel.event_id) return "edit";
  }
  return "message";
}

export interface TimelineDescription {
  /** Events parseTimelineEvents hands to parseSingleEvent. */
  messageEventIds: string[];
  /** Plain messages and call hangups — the events that always become rows. */
  rowEventIds: string[];
  edits: Array<{ targetId: string; ts: number }>;
}

/** What a history load needs to know before parsing any event. */
export function describeTimeline(raws: ReadonlyArray<RawEvent | null>): TimelineDescription {
  const out: TimelineDescription = { messageEventIds: [], rowEventIds: [], edits: [] };
  for (const raw of raws) {
    const id = raw?.event_id as string | undefined;
    if (!raw || !id) continue;
    const kind = classifyTimelineEvent(raw);
    if (kind === "edit") {
      const rel = (raw.content as Record<string, unknown>)["m.relates_to"] as Record<string, unknown>;
      out.edits.push({ targetId: rel.event_id as string, ts: (raw.origin_server_ts as number) ?? 0 });
    } else if (kind === "message") {
      out.messageEventIds.push(id);
      if (raw.type === "m.room.message" || raw.type === "m.call.hangup") out.rowEventIds.push(id);
    }
  }
  return out;
}

/** Ids of the first `count` events — the page a scrollback just prepended. */
export function pageEventIds(raws: ReadonlyArray<RawEvent | null>, count: number): Set<string> {
  const ids = new Set<string>();
  for (const raw of raws.slice(0, count)) {
    const id = raw?.event_id as string | undefined;
    if (id) ids.add(id);
  }
  return ids;
}

/** Would parsing this stored row again change it? Mirrors the repairs
 *  bulkInsert applies to existing rows: an undecrypted body
 *  (encryptedRepairPatch), and a hangup stored as not missed that now reads
 *  as missed because its invite came into view (missedCallRepairPatch). An
 *  answered call never becomes missed, so it is not re-parsed. */
export function needsReparse(row: StoredRow, hangupReadsMissed: boolean): boolean {
  if (row.content === "[encrypted]") return true;
  if (row.decryptionStatus === "pending" || row.decryptionStatus === "failed") return true;
  return !!row.callInfo && !row.callInfo.missed && hangupReadsMissed;
}

/**
 * Ids of the message events to parse: those Dexie lacks, stored rows that a
 * re-parse would repair, and targets of edits Dexie has not applied yet (an
 * edit is only applied to a target parsed in the same pass).
 */
export function selectEventIdsToParse(opts: {
  messageEventIds: readonly string[];
  stored: ReadonlyMap<string, StoredRow>;
  edits: ReadonlyArray<{ targetId: string; ts: number }>;
  /** Does this hangup read as missed against the timeline's call events? */
  hangupReadsMissed: (eventId: string) => boolean;
}): Set<string> {
  const ids = new Set<string>();
  for (const id of opts.messageEventIds) {
    const row = opts.stored.get(id);
    if (!row || needsReparse(row, !!row.callInfo && opts.hangupReadsMissed(id))) ids.add(id);
  }
  for (const edit of opts.edits) {
    const row = opts.stored.get(edit.targetId);
    if (row && (row.lastEditTs ?? 0) < edit.ts) ids.add(edit.targetId);
  }
  return ids;
}

/**
 * Is the SDK's in-memory timeline already in Dexie, so opening the room has
 * nothing to load? True when a history load would parse nothing
 * (`pendingIds` empty — see selectEventIdsToParse, run over the row events)
 * and the timeline either reaches the start of the room or is long enough
 * that loadRoomMessages would not scroll back. A short timeline with a back
 * token is what a limited sync leaves behind, possibly with a hole in Dexie
 * before it — that one still goes through loadRoomMessages.
 */
export function isTimelineStoredInDexie(opts: {
  timelineLength: number;
  hasMoreHistory: boolean;
  minTimelineEvents: number;
  pendingIds: ReadonlySet<string>;
}): boolean {
  if (opts.hasMoreHistory && opts.timelineLength < opts.minTimelineEvents) return false;
  return opts.pendingIds.size === 0;
}
