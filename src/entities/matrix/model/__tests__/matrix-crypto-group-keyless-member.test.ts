// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll } from "vitest";

import { installBitcoinEcc, makeUser, makeParticipant, roomOf, FakeRoomState, type TestUser } from "./pcrypto-harness";

vi.mock("@/shared/lib/crypto-worker/bridge", () => ({
  isCryptoWorkerSupported: () => false,
  isWorkerInfraError: () => false,
  workerDecrypt: vi.fn(),
  workerEncrypt: vi.fn(),
  workerDecryptFile: vi.fn(),
  terminateCryptoWorker: vi.fn(),
}));

vi.mock("@/shared/lib/matrix/chat-storage", async () => {
  const { createMemoryChatStorage } = await import("./memory-chat-storage");
  return { createChatStorage: async () => createMemoryChatStorage() };
});

/**
 * Regression: canBeEncrypt() demanded 12 keys from EVERY participant, so one
 * member without keys (deleted account, unfinished registration) made a
 * private group unsendable: every send threw "encryption required but peer
 * keys unavailable — syncSendMessage". Bastyon encrypts the group for the
 * members that have keys; 1:1 rooms still need the peer's keys.
 */

beforeAll(() => {
  installBitcoinEcc();
});

async function roomWithKeyless(opts: { tetatet: boolean; withPeer: boolean }) {
  const alice = makeUser("aaaa01", 10);
  const bob = makeUser("bbbb02", 20);
  const carol = makeUser("cccc03", 30); // no published keys
  const members: TestUser[] = opts.withPeer ? [alice, bob, carol] : [alice, carol];
  const state = new FakeRoomState();
  members.forEach((u, i) => state.join(u.id, 1000 + i));

  const a = await makeParticipant({ user: alice, everyone: members, state, tetatet: opts.tetatet });
  a.pcrypto.setHelpers({
    getUsersInfo: async (ids) =>
      members
        .filter((u) => ids.includes(u.id))
        .map((u) => ({ id: u.id, keys: u === carol ? [] : u.publics, source: { id: u.sourceId } })),
    isTetatetChat: () => opts.tetatet,
    isChatPublic: () => false,
    matrixId: (id) => `@${id}:server`,
  });
  return roomOf(a);
}

describe("canBeEncrypt — participant without keys", () => {
  it("a group still encrypts for the members that have keys", async () => {
    const room = await roomWithKeyless({ tetatet: false, withPeer: true });
    expect(room.canBeEncrypt()).toBe(true);
  });

  it("a group whose only peer has no keys does not encrypt", async () => {
    const room = await roomWithKeyless({ tetatet: false, withPeer: false });
    expect(room.canBeEncrypt()).toBe(false);
  });

  it("a 1:1 room whose peer has no keys does not encrypt", async () => {
    const room = await roomWithKeyless({ tetatet: true, withPeer: false });
    expect(room.canBeEncrypt()).toBe(false);
  });
});
