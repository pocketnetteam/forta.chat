import { matrixIdToAddress } from "./chat-helpers";

export type ReactionSummary = Record<string, { count: number; users: string[]; myEventId?: string }>;

/**
 * Aggregate `m.reaction` events into per-target reaction maps (one vote per
 * user per emoji). Shared by the timeline parser, which applies the maps to
 * the messages it parsed, and by the history load, which diffs them against
 * rows already in Dexie without parsing those rows again.
 */
export function collectTimelineReactions(
  reactionEvents: Iterable<Record<string, unknown>>,
  isMe: (matrixUserId: string) => boolean,
): Map<string, ReactionSummary> {
  const byTarget = new Map<string, ReactionSummary>();
  for (const raw of reactionEvents) {
    const content = raw.content as Record<string, unknown> | undefined;
    const relatesTo = content?.["m.relates_to"] as Record<string, unknown> | undefined;
    if (!relatesTo) continue;
    const targetId = relatesTo.event_id as string;
    const emoji = relatesTo.key as string;
    if (!targetId || !emoji) continue;

    let reactions = byTarget.get(targetId);
    if (!reactions) {
      reactions = {};
      byTarget.set(targetId, reactions);
    }
    if (!reactions[emoji]) reactions[emoji] = { count: 0, users: [] };
    const sender = matrixIdToAddress(raw.sender as string);
    const rd = reactions[emoji];
    if (!rd.users.includes(sender)) {
      rd.users.push(sender);
      rd.count++;
      if (isMe(raw.sender as string)) rd.myEventId = raw.event_id as string;
    }
  }
  return byTarget;
}
