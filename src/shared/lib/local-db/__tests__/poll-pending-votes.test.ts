import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import type { LocalMessage } from "../schema";
import { MessageRepository } from "../message-repository";
import { RoomRepository } from "../room-repository";
import { UserRepository } from "../user-repository";
import { EventWriter, type ParsedMessage } from "../event-writer";
import { MessageType } from "@/entities/chat/model/types";

let db: ChatDatabase;
let msgRepo: MessageRepository;
let roomRepo: RoomRepository;
let userRepo: UserRepository;
let eventWriter: EventWriter;

const ROOM_ID = "!room:server";
const POLL_EVENT_ID = "$poll1";

function makePollMessage(): ParsedMessage {
  return {
    eventId: POLL_EVENT_ID,
    roomId: ROOM_ID,
    senderId: "PHostAddr",
    content: "Favorite color?",
    timestamp: Date.now(),
    type: MessageType.poll,
    pollInfo: {
      question: "Favorite color?",
      options: [
        { id: "opt-0", text: "Red" },
        { id: "opt-1", text: "Blue" },
      ],
      votes: {},
    },
  };
}

beforeEach(async () => {
  const name = `test-poll-pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db = new ChatDatabase(name);
  await db.open();
  msgRepo = new MessageRepository(db);
  roomRepo = new RoomRepository(db);
  userRepo = new UserRepository(db);
  eventWriter = new EventWriter(db, msgRepo, roomRepo, userRepo);
});

afterEach(async () => {
  await db.delete();
});

describe("EventWriter — poll vote pending buffer (WEE-52)", () => {
  it("drops votes for unknown polls before the fix — regression guard", async () => {
    // Without the pending buffer, writePollVote on an unknown poll silently
    // returned. After the fix we stash the vote and replay it on poll.start.
    // This test documents the *new* behaviour: vote count must end up at 1
    // even though the response arrived before the start.
    await eventWriter.writePollVote(POLL_EVENT_ID, "PAlice", "opt-0", false);

    // No poll message yet — Dexie has no row to inspect.
    const beforeStart = await msgRepo.getByEventId(POLL_EVENT_ID);
    expect(beforeStart).toBeUndefined();

    // Now the poll.start lands.
    await eventWriter.writeMessage(makePollMessage(), "PMe", ROOM_ID);

    const afterStart = await msgRepo.getByEventId(POLL_EVENT_ID);
    expect(afterStart?.pollInfo?.votes["opt-0"]).toEqual(["PAlice"]);
  });

  it("replays multiple early votes and last-wins per voter", async () => {
    // Alice votes opt-0, then changes mind to opt-1, both before poll.start.
    await eventWriter.writePollVote(POLL_EVENT_ID, "PAlice", "opt-0", false);
    await eventWriter.writePollVote(POLL_EVENT_ID, "PAlice", "opt-1", false);
    // Bob votes opt-0.
    await eventWriter.writePollVote(POLL_EVENT_ID, "PBob", "opt-0", false);

    await eventWriter.writeMessage(makePollMessage(), "PMe", ROOM_ID);

    const stored = await msgRepo.getByEventId(POLL_EVENT_ID);
    // Alice's earlier opt-0 vote must be cleared; only her final opt-1 stays.
    expect(stored?.pollInfo?.votes["opt-0"]).toEqual(["PBob"]);
    expect(stored?.pollInfo?.votes["opt-1"]).toEqual(["PAlice"]);
  });

  it("preserves myVote flag from early-arriving own response", async () => {
    // Our own response can race ahead of our own poll.start echo on a slow
    // device — myVote must survive the round-trip.
    await eventWriter.writePollVote(POLL_EVENT_ID, "PMe", "opt-1", /* isMine */ true);

    await eventWriter.writeMessage(makePollMessage(), "PMe", ROOM_ID);

    const stored = await msgRepo.getByEventId(POLL_EVENT_ID);
    expect(stored?.pollInfo?.myVote).toBe("opt-1");
  });

  it("replays an early poll.end alongside stashed votes", async () => {
    await eventWriter.writePollVote(POLL_EVENT_ID, "PAlice", "opt-0", false);
    await eventWriter.writePollEnd(POLL_EVENT_ID, "PHostAddr");

    await eventWriter.writeMessage(makePollMessage(), "PMe", ROOM_ID);

    const stored = await msgRepo.getByEventId(POLL_EVENT_ID);
    expect(stored?.pollInfo?.votes["opt-0"]).toEqual(["PAlice"]);
    expect(stored?.pollInfo?.ended).toBe(true);
    expect(stored?.pollInfo?.endedBy).toBe("PHostAddr");
  });

  it("still works synchronously when poll.start landed first", async () => {
    // Sanity check — the new buffer must not regress the in-order case.
    await eventWriter.writeMessage(makePollMessage(), "PMe", ROOM_ID);
    await eventWriter.writePollVote(POLL_EVENT_ID, "PAlice", "opt-0", false);

    const stored = await msgRepo.getByEventId(POLL_EVENT_ID);
    expect(stored?.pollInfo?.votes["opt-0"]).toEqual(["PAlice"]);
  });
});

describe("EventWriter — writePollVote dedup within a single poll", () => {
  it("never accumulates duplicate voters when the same vote arrives twice", async () => {
    await eventWriter.writeMessage(makePollMessage(), "PMe", ROOM_ID);

    await eventWriter.writePollVote(POLL_EVENT_ID, "PAlice", "opt-0", false);
    await eventWriter.writePollVote(POLL_EVENT_ID, "PAlice", "opt-0", false);
    await eventWriter.writePollVote(POLL_EVENT_ID, "PAlice", "opt-0", false);

    const stored = await msgRepo.getByEventId(POLL_EVENT_ID);
    expect(stored?.pollInfo?.votes["opt-0"]).toEqual(["PAlice"]);
  });

  it("moves a voter cleanly across options when they change their mind", async () => {
    await eventWriter.writeMessage(makePollMessage(), "PMe", ROOM_ID);

    await eventWriter.writePollVote(POLL_EVENT_ID, "PAlice", "opt-0", false);
    await eventWriter.writePollVote(POLL_EVENT_ID, "PAlice", "opt-1", false);

    const stored = await msgRepo.getByEventId(POLL_EVENT_ID);
    const opt0 = stored?.pollInfo?.votes["opt-0"] ?? [];
    expect(opt0).not.toContain("PAlice");
    expect(stored?.pollInfo?.votes["opt-1"]).toEqual(["PAlice"]);
  });
});
