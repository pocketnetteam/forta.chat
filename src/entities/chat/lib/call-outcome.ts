/**
 * Whether a call's hangup record reads as missed.
 *
 * The hangup alone cannot tell. The caller's SDK sends `user_hangup` both when they give up
 * while the call still rings and when they end a call that was talking, so only
 * `invite_timeout` names an unanswered call outright. The rest comes from the room's other
 * call events: who sent the invite, and whether anyone answered it. A call the caller ended
 * before any answer reads as missed, as messengers show a call the other side cancelled. The
 * callee's own hangup before an answer is a decline, not a miss. When the invite is out of
 * view the record keeps the old reading, which knew only the timeout.
 */

import { DEFAULT_INVITE_LIFETIME_MS, MAX_INVITE_LIFETIME_MS } from "@/shared/lib/native-calls/invite-ttl";

type RawEvent = Record<string, unknown>;

export interface CallEventIndex {
  /** call_id → sender of its `m.call.invite`. */
  readonly callers: ReadonlyMap<string, string>;
  /** call_ids with an `m.call.answer`, or a caller's `m.call.select_answer` that implies one. */
  readonly answered: ReadonlySet<string>;
  /** call_ids with an `m.call.hangup`: the call has its record in the chat. */
  readonly hungUp: ReadonlySet<string>;
  /** call_ids with an `m.call.reject`: the call is over, but a reject leaves no record. */
  readonly rejected: ReadonlySet<string>;
}

const ANSWER_TYPES = new Set(["m.call.answer", "m.call.select_answer"]);

function callIdOf(raw: RawEvent): string | undefined {
  const content = raw.content as RawEvent | undefined;
  const callId = content?.call_id;
  return typeof callId === "string" && callId ? callId : undefined;
}

export function indexCallEvents(rawEvents: Iterable<RawEvent | null | undefined>): CallEventIndex {
  const callers = new Map<string, string>();
  const answered = new Set<string>();
  const hungUp = new Set<string>();
  const rejected = new Set<string>();
  for (const raw of rawEvents) {
    if (!raw || typeof raw.type !== "string") continue;
    const callId = callIdOf(raw);
    if (!callId) continue;
    if (raw.type === "m.call.invite" && typeof raw.sender === "string") {
      if (!callers.has(callId)) callers.set(callId, raw.sender);
    } else if (ANSWER_TYPES.has(raw.type)) {
      answered.add(callId);
    } else if (raw.type === "m.call.hangup") {
      hungUp.add(callId);
    } else if (raw.type === "m.call.reject") {
      rejected.add(callId);
    }
  }
  return { callers, answered, hungUp, rejected };
}

export function isMissedCallHangup(hangup: RawEvent, index: CallEventIndex): boolean {
  const content = hangup.content as RawEvent | undefined;
  if (content?.reason === "invite_timeout") return true;
  const callId = callIdOf(hangup);
  if (!callId) return false;
  const caller = index.callers.get(callId);
  if (!caller || index.answered.has(callId)) return false;
  return hangup.sender === caller;
}

/**
 * How long past its lifetime an invite waits for its hangup. The caller's SDK sends
 * `invite_timeout` when the lifetime runs out; the grace covers that send and clock skew.
 */
export const ORPHAN_INVITE_GRACE_MS = 15_000;

/** When [invite] reads as orphaned, unless something ends its call first; 0 without a timestamp. */
export function orphanInviteDueAt(invite: RawEvent): number {
  const ts = invite.origin_server_ts;
  if (typeof ts !== "number" || ts <= 0) return 0;
  const lifetime = (invite.content as RawEvent | undefined)?.lifetime;
  const ms = typeof lifetime === "number" && lifetime > 0
    ? Math.min(lifetime, MAX_INVITE_LIFETIME_MS)
    : DEFAULT_INVITE_LIFETIME_MS;
  return ts + ms + ORPHAN_INVITE_GRACE_MS;
}

/**
 * An invite of an unanswered call that no hangup followed, so the call has no record in the
 * chat; the invite stands in for it. Two ways get there (web bench, 2026-10-15):
 * - the callee's app rejects a call nobody answered after 30 s, or the callee declines it.
 *   The SDK ends the call on a reject without a hangup, so no record ever came, on either side.
 * - the caller's client went away before its SDK sent `invite_timeout` (a closed tab, a killed
 *   app, a lost network). Nothing ended the call; it reads as orphaned once its lifetime is over.
 */
export function isOrphanedInvite(invite: RawEvent, index: CallEventIndex, now: number): boolean {
  if (invite.type !== "m.call.invite") return false;
  const callId = callIdOf(invite);
  if (!callId || index.hungUp.has(callId) || index.answered.has(callId)) return false;
  if (index.rejected.has(callId)) return true;
  const dueAt = orphanInviteDueAt(invite);
  return dueAt > 0 && now >= dueAt;
}

/**
 * Invites whose call may still end without a record: no hangup, no answer, and not yet past
 * due. A live check armed for each writes the record once it is orphaned. Invites already past
 * due are left to the history load, which builds their records when the room is parsed.
 */
export function pendingInvites(rawEvents: ReadonlyArray<RawEvent | null | undefined>, now: number): RawEvent[] {
  let index: CallEventIndex | undefined;
  const out: RawEvent[] = [];
  for (const raw of rawEvents) {
    if (raw?.type !== "m.call.invite") continue;
    const callId = callIdOf(raw);
    if (!callId || orphanInviteDueAt(raw) <= now) continue;
    index ??= indexCallEvents(rawEvents);
    if (index.hungUp.has(callId) || index.answered.has(callId)) continue;
    out.push(raw);
  }
  return out;
}
