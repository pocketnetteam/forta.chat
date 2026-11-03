// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll } from "vitest";

import { installBitcoinEcc, makeUser, makeParticipant, roomOf, FakeRoomState } from "./pcrypto-harness";

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
 * PcryptoRoom.ensureMembers(): with lazy-loaded members a fresh 1:1 room
 * holds only the own member until the peer posts, so canBeEncrypt() said
 * "peer has no keys" although they had published them (the reason lazy
 * loading was turned off in ba89a056). ensureMembers() loads the members and
 * re-reads the participants before the send decides whether to encrypt.
 */

beforeAll(() => {
  installBitcoinEcc();
});

/** Alice's view of a 1:1 room whose /sync did not include Bob's member event. */
async function lazyRoom(opts: { loaded?: boolean; joinedCount?: number; loadFails?: boolean } = {}) {
  const alice = makeUser("aaaa01", 1);
  const bob = makeUser("bbbb02", 2);
  const state = new FakeRoomState();
  state.join(alice.id, 1000);
  let loaded = opts.loaded ?? false;
  const loadMembersIfNeeded = vi.fn(async () => {
    if (opts.loadFails) throw new Error("members 500");
    state.join(bob.id, 2000);
    loaded = true;
    return true;
  });
  const a = await makeParticipant({ user: alice, everyone: [alice, bob], state, tetatet: true });
  Object.assign(a.chat, {
    membersLoaded: () => loaded,
    loadMembersIfNeeded,
    getMyMembership: () => "join",
    ...(opts.joinedCount !== undefined ? { getJoinedMemberCount: () => opts.joinedCount } : {}),
  });
  const room = await roomOf(a);
  return { alice, bob, state, room, loadMembersIfNeeded };
}

describe("PcryptoRoom.ensureMembers", () => {
  it("loads the missing peer so canBeEncrypt() sees them (regression: ba89a056)", async () => {
    const { room, loadMembersIfNeeded } = await lazyRoom();
    expect(room.canBeEncrypt()).toBe(false);

    await room.ensureMembers!();

    expect(loadMembersIfNeeded).toHaveBeenCalledTimes(1);
    expect(room.canBeEncrypt()).toBe(true);
  });

  it("encrypts for the peer after loading them — the peer can read it", async () => {
    const { room, alice, bob, state } = await lazyRoom();
    await room.ensureMembers!();

    const content = await room.encryptEvent("hello");
    const body = JSON.parse(Buffer.from(content.body as string, "base64").toString("utf8"));
    expect(Object.keys(body)).toContain(bob.id);

    const b = await makeParticipant({ user: bob, everyone: [alice, bob], state, tetatet: true });
    const event = { event_id: "$1", sender: `@${alice.id}:server`, origin_server_ts: 5000, content };
    await expect((await roomOf(b)).decryptEvent(event)).resolves.toEqual({ body: "hello", msgtype: "m.text" });
  });

  it("does not request members when the SDK has them all (lazy loading off)", async () => {
    const { room, loadMembersIfNeeded, state, bob } = await lazyRoom({ loaded: true });
    // The peer arrived through sync after prepare(): a local re-read picks it up.
    state.join(bob.id, 2000);

    await room.ensureMembers!();

    expect(loadMembersIfNeeded).not.toHaveBeenCalled();
    expect(room.canBeEncrypt()).toBe(true);
  });

  it("skips rooms Pcrypto never encrypts (≥ 50 joined)", async () => {
    const { room, loadMembersIfNeeded } = await lazyRoom({ joinedCount: 60 });
    await room.ensureMembers!();
    expect(loadMembersIfNeeded).not.toHaveBeenCalled();
  });

  it("throws when the members cannot be loaded — the send must not go out on a partial list", async () => {
    const { room } = await lazyRoom({ loadFails: true });
    await expect(room.ensureMembers!()).rejects.toThrow("members 500");
    expect(room.canBeEncrypt()).toBe(false);
  });
});

describe("PcryptoRoom.ensureMembers — participant keys", () => {
  type KeysCall = { ids: string[]; forceUpdate?: boolean };

  it("throws when the new participant's keys cannot be loaded — canBeEncrypt() would still say yes", async () => {
    const alice = makeUser("aaaa11", 1);
    const bob = makeUser("bbbb22", 2);
    const state = new FakeRoomState();
    state.join(alice.id, 1000);
    let loaded = false;
    const a = await makeParticipant({ user: alice, everyone: [alice, bob], state, tetatet: false });
    Object.assign(a.chat, {
      membersLoaded: () => loaded,
      loadMembersIfNeeded: async () => { state.join(bob.id, 2000); loaded = true; return true; },
      getMyMembership: () => "join",
    });
    const room = await roomOf(a);
    a.pcrypto.setHelpers({
      getUsersInfo: async () => { throw new Error("rpc down"); },
      isTetatetChat: () => false,
      isChatPublic: () => false,
      matrixId: (id) => `@${id}:server`,
    });

    await expect(room.ensureMembers!()).rejects.toThrow("participant keys not loaded");
  });

  it("keeps a user's forced key refresh fresh: its own request is forced too", async () => {
    const alice = makeUser("aaaa33", 1);
    const bob = makeUser("bbbb44", 2);
    const state = new FakeRoomState();
    state.join(alice.id, 1000);
    let loaded = false;
    const a = await makeParticipant({ user: alice, everyone: [alice, bob], state, tetatet: true });
    Object.assign(a.chat, {
      membersLoaded: () => loaded,
      loadMembersIfNeeded: async () => { state.join(bob.id, 2000); loaded = true; return true; },
      getMyMembership: () => "join",
    });
    const room = await roomOf(a);

    const calls: KeysCall[] = [];
    let releaseForced: () => void = () => {};
    const everyone = [alice, bob];
    a.pcrypto.setHelpers({
      getUsersInfo: async (ids, opts) => {
        calls.push({ ids, forceUpdate: opts?.forceUpdate });
        if (calls.length === 1) await new Promise<void>((r) => { releaseForced = r; });
        return everyone.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, keys: u.publics, source: { id: u.sourceId } }));
      },
      isTetatetChat: () => true,
      isChatPublic: () => false,
      matrixId: (id) => `@${id}:server`,
    });

    const retry = room.prepare(true); // the banner's Retry, still in flight
    await room.ensureMembers!();
    releaseForced();
    await retry;

    expect(calls[0].forceUpdate).toBe(true);
    expect(calls[1].forceUpdate).toBe(true);
    expect(room.canBeEncrypt()).toBe(true);
  });
});

// Review 2026-10-08 (H3): the member list was read once, before the key load.
// A member who joined while the keys loaded was left out of this message's
// recipients and could not read it.
describe("PcryptoRoom.ensureMembers — a member who joins during the key load", () => {
  it("loads that member's keys too", async () => {
    const alice = makeUser("aaaa55", 1);
    const bob = makeUser("bbbb66", 2);
    const carol = makeUser("cccc77", 3);
    const everyone = [alice, bob, carol];
    const state = new FakeRoomState();
    state.join(alice.id, 1000);
    let loaded = false;
    const a = await makeParticipant({ user: alice, everyone, state, tetatet: false });
    Object.assign(a.chat, {
      membersLoaded: () => loaded,
      loadMembersIfNeeded: async () => { state.join(bob.id, 2000); loaded = true; return true; },
      getMyMembership: () => "join",
    });
    const room = await roomOf(a);
    const requested: string[][] = [];
    a.pcrypto.setHelpers({
      getUsersInfo: async (ids) => {
        requested.push([...ids]);
        // Carol joins while the first key request is on the wire.
        if (requested.length === 1) state.join(carol.id, 3000);
        return everyone.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, keys: u.publics, source: { id: u.sourceId } }));
      },
      isTetatetChat: () => false,
      isChatPublic: () => false,
      matrixId: (id) => `@${id}:server`,
    });

    await room.ensureMembers!();

    expect(requested.flat()).toContain(carol.id);
  });
});
