import { describe, it, expect } from "vitest";
import type { ChatRoom } from "@/entities/chat";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { resolveRoomNameInfo, type NameContext } from "./resolve-room-name";

const ME = "PMeAddress111";
const BOB = "PBobAddress222";
const CAROL = "PCarolAddress333";

const ctx = (over: Partial<NameContext> = {}): NameContext => ({
  users: {},
  aliases: {},
  myHexId: hexEncode(ME),
  getDisplayName: (a) => a,
  ...over,
});

const dm = (over: Partial<ChatRoom> = {}): ChatRoom =>
  ({ id: "!r", name: "!r", isGroup: false, members: [hexEncode(ME), hexEncode(BOB)], ...over }) as ChatRoom;

describe("resolveRoomNameInfo", () => {
  it("names a DM after the other member's profile, skipping self", () => {
    const res = resolveRoomNameInfo(dm(), ctx({ users: { [BOB]: { name: "Bob" }, [ME]: { name: "Me" } } }));
    expect(res).toEqual({ name: "Bob", hasMemberNames: true });
  });

  it("prefers a local alias over the profile and the Matrix displayname", () => {
    const res = resolveRoomNameInfo(dm(), ctx({
      aliases: { [BOB]: "Bobby" },
      users: { [BOB]: { name: "Bob" } },
      getDisplayName: () => "Robert",
    }));
    expect(res.name).toBe("Bobby");
  });

  it("falls back to the Matrix displayname when there is no profile", () => {
    const res = resolveRoomNameInfo(dm(), ctx({ getDisplayName: (a) => (a === BOB ? "Robert" : a) }));
    expect(res.name).toBe("Robert");
  });

  it("includes invited members (DM whose peer has not accepted yet)", () => {
    const room = dm({ members: [hexEncode(ME)], invitedMembers: [hexEncode(CAROL)] });
    expect(resolveRoomNameInfo(room, ctx({ users: { [CAROL]: { name: "Carol" } } })).name).toBe("Carol");
  });

  it("uses the avatar address when no member resolves", () => {
    const room = dm({ members: [hexEncode(ME)], avatar: `__pocketnet__:${BOB}` });
    expect(resolveRoomNameInfo(room, ctx({ users: { [BOB]: { name: "Bob" } } })).name).toBe("Bob");
  });

  it("reports an unresolved DM when no name is known", () => {
    expect(resolveRoomNameInfo(dm({ name: "Some chat" }), ctx()).hasMemberNames).toBe(false);
  });

  it("keeps a group's own name and strips a leading @", () => {
    const users = { [BOB]: { name: "Bob" } };
    expect(resolveRoomNameInfo(dm({ isGroup: true, name: "Team" }), ctx({ users })).name).toBe("Team");
    expect(resolveRoomNameInfo(dm({ isGroup: true, name: "@Public" }), ctx({ users })).name).toBe("Public");
  });
});
