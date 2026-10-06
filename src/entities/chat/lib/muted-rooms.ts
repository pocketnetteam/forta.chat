/** Room-kind push rule as the homeserver returns it (rule_id = room id). */
interface RoomPushRuleLike {
  rule_id?: unknown;
  enabled?: unknown;
  actions?: unknown;
}

/** The slice of `GET /pushrules/` (and of `m.push_rules` account_data) that
 *  carries per-room mute rules. */
export interface PushRulesLike {
  global?: { room?: Array<RoomPushRuleLike | null> | null } | null;
}

/** Room ids muted by an enabled room-kind push rule, or null when the payload
 *  has no room rule list (so the caller keeps its current state).
 *
 *  Only `dont_notify` counts: it is what `setRoomMutePushRule(true)` writes and
 *  the only thing `setRoomMutePushRule(false)` deletes. Treating other shapes
 *  (empty actions) as muted would show a mute the unmute toggle cannot undo. */
export function mutedRoomIdsFromPushRules(rules: PushRulesLike | null | undefined): Set<string> | null {
  const roomRules = rules?.global?.room;
  if (!Array.isArray(roomRules)) return null;
  const muted = new Set<string>();
  for (const r of roomRules) {
    if (!r || r.enabled !== true || typeof r.rule_id !== "string") continue;
    if (!Array.isArray(r.actions)) continue;
    if (r.actions.includes("dont_notify") && !r.actions.includes("notify")) muted.add(r.rule_id);
  }
  return muted;
}
