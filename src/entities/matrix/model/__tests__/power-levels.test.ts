import { describe, it, expect } from "vitest";
import {
  getMyPowerLevel,
  canSendStateEvent,
  getMemberPowerLevel,
} from "../matrix-kit";

/**
 * Build a minimal room stub that mimics matrix-js-sdk's RoomMember + RoomState API.
 *
 * Why this matters for legacy bastyon-chat compat:
 *   In legacy rooms, `m.room.power_levels.users` may key admins by a different
 *   Matrix domain (e.g. `@HEX:matrix.bastyon.com`) than the user's current
 *   logged-in domain (`@HEX:matrix.pocketnet.app`). matrix-js-sdk's
 *   `Room.getMember(myUserId).powerLevel` resolves correctly because it joins
 *   on the `m.room.member` event's `state_key` — which matches the user's
 *   actual logged-in ID.
 */
function roomStub(opts: {
  members?: Record<string, { powerLevel: number }>;
  powerLevelsContent?: Record<string, unknown>;
  maySendStateEventMap?: Record<string, boolean>;
}): Record<string, unknown> {
  const members = opts.members ?? {};
  const plContent = opts.powerLevelsContent ?? {};
  const maySendMap = opts.maySendStateEventMap ?? {};

  return {
    getMember: (userId: string) => {
      return members[userId] ?? null;
    },
    currentState: {
      getStateEvents: (type: string, stateKey?: string) => {
        if (type !== "m.room.power_levels") return stateKey !== undefined ? null : [];
        if (stateKey === "") {
          return { getContent: () => plContent };
        }
        return [{ getContent: () => plContent }];
      },
      maySendStateEvent: (eventType: string, userId: string) => {
        return maySendMap[`${eventType}:${userId}`] ?? false;
      },
    },
  };
}

describe("getMyPowerLevel — SDK-based read for legacy compat", () => {
  it("uses RoomMember.powerLevel when member is present (canonical path)", () => {
    const room = roomStub({
      members: {
        "@hex:matrix.pocketnet.app": { powerLevel: 100 },
      },
    });
    expect(getMyPowerLevel(room, "@hex:matrix.pocketnet.app")).toBe(100);
  });

  it("H1 — legacy room with admin keyed by different domain still resolves via state_key", () => {
    // power_levels.users has key `@hex:matrix.bastyon.com` but member `@hex:matrix.pocketnet.app`
    // is correctly mapped via SDK's m.room.member event state_key joining
    const room = roomStub({
      members: {
        "@hex:matrix.pocketnet.app": { powerLevel: 100 },
      },
      powerLevelsContent: {
        users: { "@hex:matrix.bastyon.com": 100 },
        users_default: 0,
      },
    });
    // SDK already gave us the member with its powerLevel — we trust that
    expect(getMyPowerLevel(room, "@hex:matrix.pocketnet.app")).toBe(100);
  });

  it("falls back to users_default when no RoomMember entry exists", () => {
    const room = roomStub({
      members: {},
      powerLevelsContent: { users_default: 25 },
    });
    expect(getMyPowerLevel(room, "@stranger:matrix.pocketnet.app")).toBe(25);
  });

  it("documents fallback semantic — non-zero users_default applies when SDK has no RoomMember", () => {
    // This codifies a deliberate trade-off discussed in code review:
    // when getMember returns null (room not fully synced, or member entry
    // missing under the looked-up domain), we return users_default rather
    // than 0. Some bastyon-chat groups historically used users_default=50,
    // and treating those as "0 = stranger" would block all admins until
    // sync completes. The SDK's RoomMember.powerLevel uses the same fallback.
    const room = roomStub({
      members: {},
      powerLevelsContent: { users_default: 50 },
    });
    expect(getMyPowerLevel(room, "@me:matrix.pocketnet.app")).toBe(50);
  });

  it("falls back to 0 when no member and no users_default", () => {
    const room = roomStub({
      members: {},
      powerLevelsContent: {},
    });
    expect(getMyPowerLevel(room, "@stranger:matrix.pocketnet.app")).toBe(0);
  });

  it("returns 0 when room is null/undefined", () => {
    expect(getMyPowerLevel(null as unknown as Record<string, unknown>, "@me:foo")).toBe(0);
    expect(getMyPowerLevel(undefined as unknown as Record<string, unknown>, "@me:foo")).toBe(0);
  });

  it("returns 0 when myUserId is empty", () => {
    const room = roomStub({
      members: { "": { powerLevel: 100 } },
      powerLevelsContent: { users_default: 50 },
    });
    expect(getMyPowerLevel(room, "")).toBe(0);
  });

  it("handles getMember throwing without crashing", () => {
    const room = {
      getMember: () => {
        throw new Error("boom");
      },
      currentState: {
        getStateEvents: () => ({ getContent: () => ({ users_default: 10 }) }),
      },
    };
    expect(getMyPowerLevel(room, "@me:foo")).toBe(10);
  });

  it("returns negative powerLevel verbatim (muted users)", () => {
    const room = roomStub({
      members: { "@me:foo": { powerLevel: -1 } },
    });
    expect(getMyPowerLevel(room, "@me:foo")).toBe(-1);
  });
});

describe("canSendStateEvent — SDK-based permission check for legacy compat", () => {
  it("delegates to currentState.maySendStateEvent (true case)", () => {
    const room = roomStub({
      maySendStateEventMap: { "m.room.join_rules:@me:foo": true },
    });
    expect(canSendStateEvent(room, "m.room.join_rules", "@me:foo")).toBe(true);
  });

  it("delegates to currentState.maySendStateEvent (false case)", () => {
    const room = roomStub({
      maySendStateEventMap: { "m.room.join_rules:@me:foo": false },
    });
    expect(canSendStateEvent(room, "m.room.join_rules", "@me:foo")).toBe(false);
  });

  it("returns false when room is null/undefined", () => {
    expect(canSendStateEvent(null as unknown as Record<string, unknown>, "m.room.join_rules", "@me:foo")).toBe(false);
    expect(canSendStateEvent(undefined as unknown as Record<string, unknown>, "m.room.join_rules", "@me:foo")).toBe(false);
  });

  it("returns false when myUserId is empty", () => {
    const room = roomStub({
      maySendStateEventMap: { "m.room.join_rules:": true },
    });
    expect(canSendStateEvent(room, "m.room.join_rules", "")).toBe(false);
  });

  it("returns false when currentState is missing", () => {
    expect(canSendStateEvent({}, "m.room.join_rules", "@me:foo")).toBe(false);
  });

  it("handles maySendStateEvent throwing without crashing", () => {
    const room = {
      currentState: {
        maySendStateEvent: () => {
          throw new Error("boom");
        },
      },
    };
    expect(canSendStateEvent(room, "m.room.join_rules", "@me:foo")).toBe(false);
  });
});

describe("getMemberPowerLevel — SDK-based read for displaying others", () => {
  it("returns RoomMember.powerLevel when member exists", () => {
    const room = roomStub({
      members: { "@alice:matrix.pocketnet.app": { powerLevel: 50 } },
    });
    expect(getMemberPowerLevel(room, "@alice:matrix.pocketnet.app")).toBe(50);
  });

  it("returns 0 when member not in room", () => {
    const room = roomStub({ members: {} });
    expect(getMemberPowerLevel(room, "@stranger:matrix.pocketnet.app")).toBe(0);
  });

  it("returns 0 when room is null/undefined", () => {
    expect(getMemberPowerLevel(null as unknown as Record<string, unknown>, "@a:b")).toBe(0);
  });

  it("handles getMember throwing without crashing", () => {
    const room = {
      getMember: () => {
        throw new Error("boom");
      },
    };
    expect(getMemberPowerLevel(room, "@a:b")).toBe(0);
  });
});
