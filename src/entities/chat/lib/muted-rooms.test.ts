import { describe, it, expect } from "vitest";
import { mutedRoomIdsFromPushRules } from "./muted-rooms";

describe("mutedRoomIdsFromPushRules", () => {
  it("collects enabled room rules with dont_notify", () => {
    const muted = mutedRoomIdsFromPushRules({
      global: {
        room: [
          { rule_id: "!a:s", enabled: true, actions: ["dont_notify"] },
          { rule_id: "!b:s", enabled: true, actions: ["dont_notify"] },
        ],
      },
    });
    expect([...(muted ?? [])].sort()).toEqual(["!a:s", "!b:s"]);
  });

  it("skips disabled, notifying and malformed rules", () => {
    const muted = mutedRoomIdsFromPushRules({
      global: {
        room: [
          { rule_id: "!off:s", enabled: false, actions: ["dont_notify"] },
          { rule_id: "!loud:s", enabled: true, actions: ["notify", { set_tweak: "sound", value: "default" }] },
          // A notifying rule with highlight off is not a mute.
          { rule_id: "!nohl:s", enabled: true, actions: ["notify", { set_tweak: "highlight", value: false }] },
          // Empty actions: the SDK's unmute cannot delete it, so it is not shown as muted.
          { rule_id: "!empty:s", enabled: true, actions: [] },
          { rule_id: 42, enabled: true, actions: ["dont_notify"] },
          { rule_id: "!noactions:s", enabled: true },
          null,
        ],
      },
    });
    expect(muted?.size).toBe(0);
  });

  it("returns an empty set when the room rule list is empty", () => {
    expect(mutedRoomIdsFromPushRules({ global: { room: [] } })?.size).toBe(0);
  });

  it("returns null when the payload has no room rule list", () => {
    expect(mutedRoomIdsFromPushRules(null)).toBeNull();
    expect(mutedRoomIdsFromPushRules({})).toBeNull();
    expect(mutedRoomIdsFromPushRules({ global: { room: null } })).toBeNull();
  });
});
