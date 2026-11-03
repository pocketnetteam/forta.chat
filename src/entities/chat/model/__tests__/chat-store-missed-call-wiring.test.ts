import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * A call record reads as missed when the caller gave up before anyone answered, not only
 * when the invite timed out (`call-outcome.ts`). chat-store builds call records from
 * `m.call.hangup` in three places — the chat-list preview, history loads and live sync — and
 * each needs the room's other call events to decide. Live sync is covered by behaviour in
 * `chat-store.test.ts`; the preview and history builders are private, so this checks their
 * source, like `chat-store-hangup-unread-wiring.test.ts`.
 */
const source = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");

function bodyAfter(signature: RegExp): string {
  const match = signature.exec(source);
  if (!match) throw new Error(`${signature} not found in chat-store.ts`);
  const open = source.indexOf("{", match.index + match[0].length - 1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced body after ${signature}`);
}

describe("chat-store: missed call records", () => {
  it("no call record decides missed from the hangup reason alone", () => {
    expect(source).not.toMatch(/missed:\s*reason === "invite_timeout"/);
  });

  it("the chat-list preview reads a hangup against the room's call events", () => {
    const body = bodyAfter(/function matrixRoomToChatRoom\s*\([^)]*\)\s*:\s*ChatRoom\s*\{/);
    expect(body).toContain("indexCallEvents(");
    expect(body).toContain("isMissedCallHangup(");
  });

  it("a history load indexes the batch it parses and hands it to each event", () => {
    const batch = bodyAfter(/const parseTimelineEvents = async \([^)]*\)\s*:\s*Promise<Message\[\]>\s*=>\s*\{/);
    expect(batch).toContain("indexCallEvents(");
    expect(batch).toMatch(/parseSingleEvent\(event, roomId, roomCrypto, callEvents\)/);
    // parseSingleEvent has braces inside string literals, so take it up to the next declaration.
    const start = source.indexOf("const parseSingleEvent = async (");
    const end = source.indexOf("const parseTimelineEvents = async (");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const single = source.slice(start, end);
    expect(single).toContain("callEvents: CallEventIndex");
    expect(single).toContain("isMissedCallHangup(raw, callEvents)");
  });

  // An invite nobody ended (call-outcome.ts, isOrphanedInvite) stands in for the missing
  // hangup in the same places a hangup becomes a record.
  it("the chat-list preview and history loads turn an invite nobody ended into a record", () => {
    const preview = bodyAfter(/function matrixRoomToChatRoom\s*\([^)]*\)\s*:\s*ChatRoom\s*\{/);
    expect(preview).toMatch(/isOrphanedInvite\(raw, callEvents, Date\.now\(\)\)/);
    expect(preview).toContain("inviteCallRecord(raw, roomId)");

    const start = source.indexOf("const parseSingleEvent = async (");
    const end = source.indexOf("const parseTimelineEvents = async (");
    const single = source.slice(start, end);
    expect(single).toMatch(/isOrphanedInvite\(raw, callEvents, Date\.now\(\)\)/);
    expect(single).toContain("inviteCallRecord(raw, roomId)");
  });

  // The first sync's events reach no live handler, so a call ringing while the app started
  // got no live check (review 2026-10-16): the first full refresh arms them.
  it("the first full room refresh arms checks for invites still pending", () => {
    const refresh = bodyAfter(/const refreshRoomsImmediate = \(\)\s*=>\s*\{/);
    expect(refresh).toMatch(/fullRoomRefresh\(matrixRooms, kit, myUserId\);\s*if \(isInitial\) armPendingOrphanInviteChecks\(matrixRooms\);/);
    const arm = bodyAfter(/const armPendingOrphanInviteChecks = \(matrixRooms: unknown\[\]\)\s*=>\s*\{/);
    expect(arm).toContain("pendingInvites(");
    expect(arm).toContain("scheduleOrphanInviteCheck(invite, roomId)");
  });

  it("every room-open parse plan looks for invites nobody ended as well as rows", () => {
    const plans = source.match(/planTimelineParse\([^;]*timeline\.rowEventIds[^;]*;/g) ?? [];
    expect(plans.length).toBe(3);
    for (const plan of plans) expect(plan).toContain("timeline.orphanInviteIds");
  });
});
