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

/** The slice of the Matrix client that holds the push rules the SDK loaded. */
export interface SdkPushRulesSource {
  pushRules?: PushRulesLike | null;
  on?: (event: "sync", listener: () => void) => unknown;
  off?: (event: "sync", listener: () => void) => unknown;
}

/** Push rules the SDK fetched itself before its first /sync, without a second
 *  GET /pushrules. Resolves on the first sync event that finds them set (the
 *  cached-sync PREPARED can fire before they arrive), or null after
 *  `timeoutMs` so the caller can fall back to the network. */
export function waitForSdkPushRules(
  client: SdkPushRulesSource,
  timeoutMs: number,
): Promise<PushRulesLike | null> {
  if (client.pushRules) return Promise.resolve(client.pushRules);
  if (!client.on || !client.off) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (rules: PushRulesLike | null) => {
      clearTimeout(timer);
      client.off?.("sync", onSync);
      resolve(rules);
    };
    const onSync = () => {
      if (client.pushRules) finish(client.pushRules);
    };
    const timer = setTimeout(() => finish(client.pushRules ?? null), timeoutMs);
    client.on?.("sync", onSync);
  });
}
