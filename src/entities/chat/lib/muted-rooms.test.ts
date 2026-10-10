import { describe, it, expect, vi } from "vitest";
import { mutedRoomIdsFromPushRules, waitForSdkPushRules } from "./muted-rooms";

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

describe("waitForSdkPushRules", () => {
  const RULES = { global: { room: [{ rule_id: "!r", enabled: true, actions: ["dont_notify"] }] } };

  function fakeClient(pushRules: unknown = null) {
    const listeners = new Set<() => void>();
    return {
      pushRules: pushRules as typeof RULES | null,
      on: vi.fn((_e: "sync", l: () => void) => listeners.add(l)),
      off: vi.fn((_e: "sync", l: () => void) => listeners.delete(l)),
      emitSync() { for (const l of [...listeners]) l(); },
      listeners,
    };
  }

  it("returns rules the SDK already loaded without waiting", async () => {
    const client = fakeClient(RULES);
    await expect(waitForSdkPushRules(client, 1000)).resolves.toBe(RULES);
    expect(client.on).not.toHaveBeenCalled();
  });

  it("waits past a sync event that fires before the rules (cached PREPARED)", async () => {
    const client = fakeClient();
    const pending = waitForSdkPushRules(client, 1000);
    client.emitSync();
    client.pushRules = RULES;
    client.emitSync();
    await expect(pending).resolves.toBe(RULES);
    expect(client.listeners.size).toBe(0);
  });

  it("gives up with null after the timeout so the caller fetches them", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      const pending = waitForSdkPushRules(client, 500);
      vi.advanceTimersByTime(500);
      await expect(pending).resolves.toBeNull();
      expect(client.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
