import { describe, it, expect } from "vitest";
import {
  getMyPowerLevel,
  canSendStateEvent,
  getMemberPowerLevel,
  getPowerLevelByHexId,
  getRoomCreator,
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

  it("delegates to currentState.maySendStateEvent (false case — non-creator regular user)", () => {
    // SDK says no AND user is not the creator — guard correctly blocks.
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

  it("returns true for creator when SDK says no but creator-implicit PL covers required level", () => {
    // The Форта Чат scenario: SDK's maySendStateEvent returns false because
    // it reads users[creator] = undefined and falls back to users_default = 0.
    // Our canSendStateEvent additionally computes effective PL (with creator
    // implicit) and compares against the required level. Server is final
    // arbiter, but client must not pre-block legitimate creator actions.
    const room = {
      getMember: (id: string) =>
        id === "@daniel:matrix.pocketnet.app" ? { powerLevel: 0 } : null,
      currentState: {
        maySendStateEvent: () => false,
        getStateEvents: (type: string, stateKey?: string) => {
          if (type === "m.room.create" && stateKey === "") {
            return { getContent: () => ({ creator: "@daniel:matrix.pocketnet.app" }), getSender: () => null };
          }
          if (type === "m.room.power_levels" && stateKey === "") {
            return { getContent: () => ({}) };
          }
          return stateKey !== undefined ? null : [];
        },
      },
    };
    expect(canSendStateEvent(room, "m.room.join_rules", "@daniel:matrix.pocketnet.app")).toBe(true);
  });

  it("returns false for non-creator regular user even when power_levels is empty", () => {
    // Same room shape (empty power_levels) but the user is NOT the creator —
    // creator-implicit doesn't help, both stages return false. Guard blocks.
    const room = {
      getMember: () => null,
      currentState: {
        maySendStateEvent: () => false,
        getStateEvents: (type: string, stateKey?: string) => {
          if (type === "m.room.create" && stateKey === "") {
            return { getContent: () => ({ creator: "@daniel:matrix.pocketnet.app" }), getSender: () => null };
          }
          if (type === "m.room.power_levels" && stateKey === "") {
            return { getContent: () => ({}) };
          }
          return stateKey !== undefined ? null : [];
        },
      },
    };
    expect(canSendStateEvent(room, "m.room.join_rules", "@stranger:matrix.pocketnet.app")).toBe(false);
  });

  it("respects per-event PL override — creator (PL 100 implicit) can do PL change (req 100)", () => {
    // m.room.power_levels itself usually requires PL 100. Creator has implicit
    // 100, so this should pass.
    const room = {
      getMember: () => null,
      currentState: {
        maySendStateEvent: () => false,
        getStateEvents: (type: string, stateKey?: string) => {
          if (type === "m.room.create" && stateKey === "") {
            return { getContent: () => ({ creator: "@daniel:matrix.pocketnet.app" }), getSender: () => null };
          }
          if (type === "m.room.power_levels" && stateKey === "") {
            return {
              getContent: () => ({
                events: { "m.room.power_levels": 100 },
                state_default: 50,
              }),
            };
          }
          return stateKey !== undefined ? null : [];
        },
      },
    };
    expect(canSendStateEvent(room, "m.room.power_levels", "@daniel:matrix.pocketnet.app")).toBe(true);
  });

  it("regression — SDK true short-circuits without expensive client-side compute", () => {
    // When SDK already answered yes, we don't need to do anything else.
    // No m.room.create event present in stub — confirms we didn't fall through.
    const room = roomStub({
      maySendStateEventMap: { "m.room.join_rules:@me:foo": true },
    });
    expect(canSendStateEvent(room, "m.room.join_rules", "@me:foo")).toBe(true);
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

  it("falls back to power_levels.users via SDK getMember alias path", () => {
    // Realistic case: SDK has a RoomMember keyed by Matrix-ID, but its
    // .powerLevel is undefined because the SDK couldn't resolve the entry.
    // Caller must still get a sensible 0.
    const room = {
      getMember: () => ({}),
    };
    expect(getMemberPowerLevel(room, "@a:b")).toBe(0);
  });
});

describe("getPowerLevelByHexId — fuzzy cross-domain hex match", () => {
  // The user reported on 2026-04-30 that admins of legacy bastyon-chat groups
  // still showed without the badge in ChatInfoPanel after the first SDK fix.
  // Root cause: m.room.power_levels.users may key the admin under a different
  // Matrix domain (e.g. @HEX:matrix.bastyon.com) than ChatInfoPanel constructs
  // (@HEX:matrix.pocketnet.app via hardcoded MATRIX_SERVER). SDK does no
  // cross-domain alias resolution, so RoomMember.powerLevel returns 0 and the
  // badge stays hidden. Fuzzy match by hex local-part is the pragmatic fix.

  function plRoom(usersMap: Record<string, number>, usersDefault = 0) {
    return {
      currentState: {
        getStateEvents: (type: string, stateKey?: string) => {
          if (type !== "m.room.power_levels") return stateKey !== undefined ? null : [];
          if (stateKey === "") {
            return { getContent: () => ({ users: usersMap, users_default: usersDefault }) };
          }
          return [{ getContent: () => ({ users: usersMap, users_default: usersDefault }) }];
        },
      },
    };
  }

  it("matches hex local-part against the default-domain key", () => {
    const room = plRoom({ "@deadbeef:matrix.pocketnet.app": 100 });
    expect(getPowerLevelByHexId(room, "deadbeef")).toBe(100);
  });

  it("matches hex local-part across legacy bastyon.com domain (H1 fix)", () => {
    const room = plRoom({ "@deadbeef:matrix.bastyon.com": 100 });
    expect(getPowerLevelByHexId(room, "deadbeef")).toBe(100);
  });

  it("matches hex local-part across legacy bastyon.io domain", () => {
    const room = plRoom({ "@deadbeef:matrix.bastyon.io": 50 });
    expect(getPowerLevelByHexId(room, "deadbeef")).toBe(50);
  });

  it("matches case-insensitively (some legacy clients uppercased hex)", () => {
    const room = plRoom({ "@DEADBEEF:matrix.bastyon.com": 100 });
    expect(getPowerLevelByHexId(room, "deadbeef")).toBe(100);
  });

  it("returns users_default when hex not found in any key", () => {
    const room = plRoom({ "@somebodyelse:matrix.bastyon.com": 100 }, 25);
    expect(getPowerLevelByHexId(room, "deadbeef")).toBe(25);
  });

  it("returns 0 when no match and no users_default", () => {
    const room = plRoom({});
    expect(getPowerLevelByHexId(room, "deadbeef")).toBe(0);
  });

  it("returns 0 when room is null/undefined", () => {
    expect(getPowerLevelByHexId(null as unknown as Record<string, unknown>, "x")).toBe(0);
  });

  it("returns 0 when hexId is empty (defensive — never falsy-match)", () => {
    const room = plRoom({ "@:matrix.foo": 100 });
    expect(getPowerLevelByHexId(room, "")).toBe(0);
  });

  it("handles getStateEvents throwing without crashing", () => {
    const room = {
      currentState: {
        getStateEvents: () => {
          throw new Error("boom");
        },
      },
    };
    expect(getPowerLevelByHexId(room, "deadbeef")).toBe(0);
  });

  it("multiple matching keys — picks the highest level (admin wins over moderator)", () => {
    // Edge case: same hex appears under two domains with different levels.
    // We pick the highest so an admin downgraded on one domain doesn't lose
    // their elevated status from the other.
    const room = plRoom({
      "@deadbeef:matrix.bastyon.com": 100,
      "@deadbeef:matrix.pocketnet.app": 50,
    });
    expect(getPowerLevelByHexId(room, "deadbeef")).toBe(100);
  });
});

describe("getRoomCreator — m.room.create.creator extraction", () => {
  function createRoom(content: Record<string, unknown> | null, sender?: string) {
    return {
      currentState: {
        getStateEvents: (type: string, stateKey?: string) => {
          if (type !== "m.room.create") return stateKey !== undefined ? null : [];
          if (stateKey === "") {
            if (!content && !sender) return null;
            return {
              getContent: () => content ?? {},
              getSender: () => sender ?? null,
            };
          }
          return null;
        },
      },
    };
  }

  it("returns creator field for room versions ≤ 10", () => {
    const room = createRoom({ creator: "@deadbeef:matrix.pocketnet.app", room_version: "10" });
    expect(getRoomCreator(room)).toBe("@deadbeef:matrix.pocketnet.app");
  });

  it("falls back to sender when creator field is absent (room version 11+)", () => {
    const room = createRoom({ room_version: "11" }, "@v11creator:matrix.pocketnet.app");
    expect(getRoomCreator(room)).toBe("@v11creator:matrix.pocketnet.app");
  });

  it("prefers creator field over sender when both present", () => {
    const room = createRoom({ creator: "@deadbeef:matrix.pocketnet.app" }, "@other:foo");
    expect(getRoomCreator(room)).toBe("@deadbeef:matrix.pocketnet.app");
  });

  it("returns null when no m.room.create event present", () => {
    expect(getRoomCreator(createRoom(null))).toBeNull();
  });

  it("returns null when room is null/undefined", () => {
    expect(getRoomCreator(null as unknown as Record<string, unknown>)).toBeNull();
  });

  it("handles getStateEvents throwing without crashing", () => {
    const room = {
      currentState: {
        getStateEvents: () => {
          throw new Error("boom");
        },
      },
    };
    expect(getRoomCreator(room)).toBeNull();
  });
});

describe("Creator-implicit PL — empty m.room.power_levels but m.room.create has creator", () => {
  // Direct repro of the 2026-04-30 user-debug-log:
  //   "Форта Чат" group: rawPlContent: {}, createEventContent.creator: <Daniel_hex>
  // Per Matrix spec, when power_levels.users is empty, the creator has
  // implicit PL 100. matrix-js-sdk's RoomMember.powerLevel does NOT compute
  // this — it just reads users[userId] ?? users_default ?? 0 — so the badge
  // never lights up for the creator. Three-stage resolution must include a
  // creator check.

  function emptyPlRoomWithCreator(creatorId: string, members: Record<string, { powerLevel?: number }>) {
    return {
      getMember: (id: string) => members[id] ?? null,
      currentState: {
        getStateEvents: (type: string, stateKey?: string) => {
          if (type === "m.room.create" && stateKey === "") {
            return { getContent: () => ({ creator: creatorId, room_version: "10" }), getSender: () => null };
          }
          if (type === "m.room.power_levels" && stateKey === "") {
            return { getContent: () => ({}) };
          }
          return stateKey !== undefined ? null : [];
        },
      },
    };
  }

  it("getMyPowerLevel returns 100 for creator when power_levels.users is empty", () => {
    const room = emptyPlRoomWithCreator(
      "@daniel:matrix.pocketnet.app",
      { "@daniel:matrix.pocketnet.app": { powerLevel: 0 } },
    );
    expect(getMyPowerLevel(room, "@daniel:matrix.pocketnet.app")).toBe(100);
  });

  it("getMyPowerLevel returns 0 for non-creator when power_levels is empty", () => {
    const room = emptyPlRoomWithCreator(
      "@daniel:matrix.pocketnet.app",
      { "@stranger:matrix.pocketnet.app": { powerLevel: 0 } },
    );
    expect(getMyPowerLevel(room, "@stranger:matrix.pocketnet.app")).toBe(0);
  });

  it("getMemberPowerLevel returns 100 for creator member (badge in member list)", () => {
    const room = emptyPlRoomWithCreator(
      "@daniel:matrix.pocketnet.app",
      { "@daniel:matrix.pocketnet.app": { powerLevel: 0 } },
    );
    expect(getMemberPowerLevel(room, "@daniel:matrix.pocketnet.app")).toBe(100);
  });

  it("creator with cross-domain mismatch — local-part hex still wins", () => {
    // Creator stored in m.room.create as @hex:matrix.bastyon.com,
    // but member looked up as @hex:matrix.pocketnet.app — same hex,
    // different domain. Should still resolve as creator.
    const room = emptyPlRoomWithCreator(
      "@deadbeef:matrix.bastyon.com",
      { "@deadbeef:matrix.pocketnet.app": { powerLevel: 0 } },
    );
    expect(getMemberPowerLevel(room, "@deadbeef:matrix.pocketnet.app")).toBe(100);
  });

  it("explicit power_levels.users overrides creator implicit (admin demoted creator)", () => {
    // Edge case: creator was explicitly demoted — power_levels.users[creator]=10
    // The explicit value should win over the implicit 100.
    const room = {
      getMember: () => null,
      currentState: {
        getStateEvents: (type: string, stateKey?: string) => {
          if (type === "m.room.create" && stateKey === "") {
            return { getContent: () => ({ creator: "@daniel:matrix.pocketnet.app" }), getSender: () => null };
          }
          if (type === "m.room.power_levels" && stateKey === "") {
            return { getContent: () => ({ users: { "@daniel:matrix.pocketnet.app": 10 } }) };
          }
          return stateKey !== undefined ? null : [];
        },
      },
    };
    expect(getMyPowerLevel(room, "@daniel:matrix.pocketnet.app")).toBe(10);
  });
});

describe("ChatInfoPanel scenario — Daniel_Satchkov admin badge in legacy bastyon-chat group", () => {
  // Direct repro of the 2026-04-30 user report:
  //   "у Daniel_Satchkov нет admin badge на ChatInfoPanel хотя он admin
  //    в legacy bastyon-chat группе"
  //
  // Pre-fix: ChatInfoPanel did `users[@hex:matrix.pocketnet.app]` exact-match,
  // legacy room had key `@hex:matrix.bastyon.com`, lookup returned undefined,
  // badge hidden.
  //
  // After SDK delegation (first commit): same problem because SDK does no
  // cross-domain alias resolution — getMember(@hex:matrix.pocketnet.app)
  // returned a member object but its powerLevel cached from
  // power_levels.users[@hex:matrix.pocketnet.app] which was undefined.
  //
  // After fuzzy-hex fallback (this commit): scan keys for hex local-part,
  // find `@hex:matrix.bastyon.com`, return 100. Badge shown.

  it("shows admin (100) for legacy admin keyed under matrix.bastyon.com", () => {
    const room = {
      // SDK has the member under the current pocketnet.app domain (Daniel
      // re-joined or sent a message after Forta migration), but with the
      // default level because power_levels never updated to point at his
      // pocketnet.app ID — only the legacy bastyon.com ID was elevated.
      getMember: (id: string) =>
        id === "@deadbeefcafe:matrix.pocketnet.app" ? { powerLevel: 0 } : null,
      currentState: {
        getStateEvents: (type: string, stateKey?: string) => {
          if (type !== "m.room.power_levels") return stateKey !== undefined ? null : [];
          if (stateKey === "") {
            return {
              getContent: () => ({
                users: { "@deadbeefcafe:matrix.bastyon.com": 100 },
                users_default: 0,
              }),
            };
          }
          return null;
        },
      },
    };
    expect(getMemberPowerLevel(room, "@deadbeefcafe:matrix.pocketnet.app")).toBe(100);
  });

  it("shows admin for legacy admin who never re-joined (SDK has no member entry under current domain)", () => {
    // Even harder edge case: member only exists under bastyon.com state_key.
    // getMember(@hex:matrix.pocketnet.app) returns null entirely.
    const room = {
      getMember: () => null,
      currentState: {
        getStateEvents: (type: string, stateKey?: string) => {
          if (type !== "m.room.power_levels") return stateKey !== undefined ? null : [];
          if (stateKey === "") {
            return {
              getContent: () => ({
                users: { "@deadbeefcafe:matrix.bastyon.com": 100 },
                users_default: 0,
              }),
            };
          }
          return null;
        },
      },
    };
    expect(getMemberPowerLevel(room, "@deadbeefcafe:matrix.pocketnet.app")).toBe(100);
  });
});

describe("getMyPowerLevel — final fallback to fuzzy hex match", () => {
  // After SDK getMember and users_default both fail, fall back to fuzzy
  // hex matching. This is the final safety net for legacy admins whose
  // power_levels.users entry was written under a foreign domain.

  function legacyRoom(plUsers: Record<string, number>, members: Record<string, { powerLevel?: number }>, usersDefault = 0) {
    return {
      getMember: (id: string) => members[id] ?? null,
      currentState: {
        getStateEvents: (type: string, stateKey?: string) => {
          if (type !== "m.room.power_levels") return stateKey !== undefined ? null : [];
          if (stateKey === "") {
            return { getContent: () => ({ users: plUsers, users_default: usersDefault }) };
          }
          return [{ getContent: () => ({ users: plUsers, users_default: usersDefault }) }];
        },
      },
    };
  }

  it("when SDK member lacks elevated PL but power_levels has cross-domain entry, fuzzy-matches", () => {
    // SDK has a member entry but its powerLevel is the default (0) because
    // the user's RoomMember.userId doesn't match the legacy domain key.
    const room = legacyRoom(
      { "@deadbeef:matrix.bastyon.com": 100 },
      { "@deadbeef:matrix.pocketnet.app": { powerLevel: 0 } },
    );
    expect(getMyPowerLevel(room, "@deadbeef:matrix.pocketnet.app")).toBe(100);
  });

  it("regression — current-domain admin still resolves directly via SDK (no fuzzy needed)", () => {
    const room = legacyRoom(
      { "@deadbeef:matrix.pocketnet.app": 100 },
      { "@deadbeef:matrix.pocketnet.app": { powerLevel: 100 } },
    );
    expect(getMyPowerLevel(room, "@deadbeef:matrix.pocketnet.app")).toBe(100);
  });
});
