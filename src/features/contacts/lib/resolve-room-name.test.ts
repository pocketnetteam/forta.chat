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

  it("does not walk the members of a named group and treats it as resolved", () => {
    const members = Array.from({ length: 5000 }, (_, i) => hexEncode(`PMember${i}`));
    let lookups = 0;
    const res = resolveRoomNameInfo(
      dm({ isGroup: true, name: "Big public room", members }),
      ctx({ getDisplayName: (a) => { lookups++; return a; } }),
    );
    expect(res).toEqual({ name: "Big public room", hasMemberNames: true });
    expect(lookups).toBe(0);
  });

  it("builds an unnamed group's title from the first 10 other members only", () => {
    const addrs = Array.from({ length: 5000 }, (_, i) => `PMember${i}`);
    let lookups = 0;
    const res = resolveRoomNameInfo(
      dm({ isGroup: true, name: "!abc:server", members: [hexEncode(ME), ...addrs.map(a => hexEncode(a))] }),
      ctx({ getDisplayName: (a) => { lookups++; return `Name ${a.slice(7)}`; } }),
    );
    expect(lookups).toBe(10);
    expect(res.name).toBe(Array.from({ length: 10 }, (_, i) => `Name ${i}`).join(", "));
  });

  it("fills the 10 slots with invited members after joined ones", () => {
    const room = dm({
      isGroup: true,
      name: "!abc:server",
      members: [hexEncode(ME), hexEncode(BOB)],
      invitedMembers: [hexEncode(CAROL)],
    });
    const users = { [BOB]: { name: "Bob" }, [CAROL]: { name: "Carol" } };
    expect(resolveRoomNameInfo(room, ctx({ users })).name).toBe("Bob, Carol");
  });

  it("still names an unnamed group after its members", () => {
    const room = dm({ isGroup: true, name: "!abc:server", members: [hexEncode(ME), hexEncode(BOB)] });
    expect(resolveRoomNameInfo(room, ctx({ users: { [BOB]: { name: "Bob" } } }))).toEqual({ name: "Bob", hasMemberNames: true });
  });
});
