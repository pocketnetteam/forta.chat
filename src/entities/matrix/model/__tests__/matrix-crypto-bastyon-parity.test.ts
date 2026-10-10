// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll } from "vitest";

import {
  installBitcoinEcc,
  makeUser,
  makeParticipant,
  roomOf,
  b64Json,
  FakeRoomState,
  type TestUser,
} from "./pcrypto-harness";

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
 * Behavioural parity with bastyon-chat/src/application/pcrypto.js, driven
 * through the real PcryptoRoom with real secp256k1 keys (main-thread path).
 */

beforeAll(() => {
  installBitcoinEcc();
});

/** Two users whose member-history order (alice joined first) is the REVERSE
 *  of their source.id order (bob sorts first) — so the unsorted v1 user list
 *  and the sorted v2 list give different cuhash inputs. */
function orderSensitivePair(): { alice: TestUser; bob: TestUser; state: FakeRoomState } {
  const alice = makeUser("aaaa01", 20);
  const bob = makeUser("bbbb02", 10);
  const state = new FakeRoomState();
  state.join(alice.id, 1000);
  state.join(bob.id, 2000);
  return { alice, bob, state };
}

describe("1:1 decryptEvent — legacy v1 messages (no content.version)", () => {
  it("decrypts a message whose keys were derived from the UNSORTED v1 user list", async () => {
    const { alice, bob, state } = orderSensitivePair();
    const everyone = [alice, bob];
    const a = await makeParticipant({ user: alice, everyone, state, tetatet: true });
    const b = await makeParticipant({ user: bob, everyone, state, tetatet: true });
    const aRoom = await roomOf(a);
    const bRoom = await roomOf(b);

    // Original encryptEvent before v2 existed: encrypt(userid, text) with no
    // version → preparedUsers(undefined, undefined) → no sort.
    const legacyBody = { [bob.id]: await aRoom._encrypt(bob.id, "legacy hello", 1) };
    const event = {
      event_id: "$legacy",
      sender: `@${alice.id}:server`,
      origin_server_ts: 5000,
      content: { msgtype: "m.encrypted", block: 1000, body: b64Json(legacyBody) },
    };

    await expect(bRoom.decryptEvent(event)).resolves.toEqual({ body: "legacy hello", msgtype: "m.text" });
  });

  it("still round-trips current v2 messages", async () => {
    const { alice, bob, state } = orderSensitivePair();
    const everyone = [alice, bob];
    const a = await makeParticipant({ user: alice, everyone, state, tetatet: true });
    const b = await makeParticipant({ user: bob, everyone, state, tetatet: true });
    const aRoom = await roomOf(a);
    const bRoom = await roomOf(b);

    const content = await aRoom.encryptEvent("hello v2");
    expect(content.version).toBe(2);
    const event = { event_id: "$v2", sender: `@${alice.id}:server`, origin_server_ts: 5000, content };

    await expect(bRoom.decryptEvent(event)).resolves.toEqual({ body: "hello v2", msgtype: "m.text" });
  });
});

describe("file secrets — decryptKey reads the version like the original", () => {
  it("honours secrets.version (not only secrets.v) for file events", async () => {
    const { alice, bob, state } = orderSensitivePair();
    const everyone = [alice, bob];
    const a = await makeParticipant({ user: alice, everyone, state, tetatet: true });
    const b = await makeParticipant({ user: bob, everyone, state, tetatet: true });
    const aRoom = await roomOf(a);
    const bRoom = await roomOf(b);

    const { block, keys } = await aRoom.encryptKey("file-secret");
    const secrets = { block, keys, version: 2 };
    const event = {
      sender: `@${alice.id}:server`,
      origin_server_ts: 5000,
      content: { info: { secrets }, pbody: { secrets } },
    };

    await expect(bRoom.decryptKey(event)).resolves.toBe("file-secret");
  });

  it("ignores top-level content.keys on non-m.room.encryption events", async () => {
    const { alice, bob, state } = orderSensitivePair();
    const b = await makeParticipant({ user: bob, everyone: [alice, bob], state, tetatet: true });
    const bRoom = await roomOf(b);

    await expect(
      bRoom.decryptKey({ sender: `@${alice.id}:server`, content: { keys: "e30=", block: 10 } }),
    ).rejects.toThrow("secrets");
  });
});

type SendStateHook = (stateKey: string, content: Record<string, unknown>) => void;

/** Three-member group chat (tetatet = false → common key + AES-CBC). */
async function groupOf3(hookFor?: (userId: string) => SendStateHook | undefined) {
  const alice = makeUser("aaaa01", 30);
  const bob = makeUser("bbbb02", 10);
  const carol = makeUser("cccc03", 20);
  const everyone = [alice, bob, carol];
  const state = new FakeRoomState();
  state.join(alice.id, 1000);
  state.join(bob.id, 2000);
  state.join(carol.id, 3000);
  const mk = (user: TestUser) =>
    makeParticipant({ user, everyone, state, tetatet: false, onSendState: hookFor?.(user.id) });
  const [a, b, c] = await Promise.all([mk(alice), mk(bob), mk(carol)]);
  return { alice, bob, carol, state, a, b, c };
}

function useFakeIntervals() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
}

describe("group common key — sendCommonKey (original createMyCommonKey flow)", () => {
  it("publishes a key that every member can use", async () => {
    const { alice, a, b, c } = await groupOf3();
    const aRoom = await roomOf(a);
    const content = await aRoom.encryptEvent("hello group");
    expect(content.hash).toBeTruthy();

    const event = { event_id: "$g1", sender: `@${alice.id}:server`, origin_server_ts: 9000, content };
    await expect((await roomOf(b)).decryptEvent(event)).resolves.toEqual({ body: "hello group", msgtype: "m.text" });
    await expect((await roomOf(c)).decryptEvent({ ...event })).resolves.toEqual({ body: "hello group", msgtype: "m.text" });
  });

  it("does not publish a key that fails the self-check decrypt", async () => {
    const { a } = await groupOf3();
    const send = vi.spyOn(a.chat.client as { sendStateEvent: () => unknown }, "sendStateEvent");
    const aRoom = await roomOf(a);
    vi.spyOn(aRoom, "decryptKey").mockRejectedValueOnce(new Error("self-check failed"));

    await expect(aRoom.getOrCreateCommonKey()).rejects.toThrow("self-check failed");
    expect(send).not.toHaveBeenCalled();
  });

  /** The sendStateEvent hook swaps in fake timers right before the
   *  "wait for the state event" poll starts — earlier, fake time would race
   *  ahead of the real (WebCrypto) work that precedes it. */
  function sentThenFakeTime() {
    let resolveSent!: (publish: () => void) => void;
    const sent = new Promise<() => void>((r) => { resolveSent = r; });
    return {
      sent,
      hook: (state: FakeRoomState, senderId: string): SendStateHook => (stateKey, content) => {
        useFakeIntervals();
        resolveSent(() => state.putEncryption(senderId, stateKey, content));
      },
    };
  }

  it("reads the key back from the state event once it lands (within 5 s)", async () => {
    try {
      const gate = sentThenFakeTime();
      let stateRef!: FakeRoomState;
      const { alice, state, a, b } = await groupOf3((userId) =>
        userId === "aaaa01" ? (k, c) => gate.hook(stateRef, "aaaa01")(k, c) : undefined,
      );
      stateRef = state;
      const aRoom = await roomOf(a);
      let settled = false;
      const pending = aRoom.encryptEvent("late echo");
      pending.then(() => { settled = true; }, () => { settled = true; });

      const publish = await gate.sent;
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);
      publish();
      await vi.advanceTimersByTimeAsync(100);
      vi.useRealTimers();

      const content = await pending;
      const event = { event_id: "$g2", sender: `@${alice.id}:server`, origin_server_ts: 9000, content };
      await expect((await roomOf(b)).decryptEvent(event)).resolves.toEqual({ body: "late echo", msgtype: "m.text" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails after 5 s when the state event never appears", async () => {
    try {
      const gate = sentThenFakeTime();
      let stateRef!: FakeRoomState;
      const { state, a } = await groupOf3((userId) =>
        userId === "aaaa01" ? (k, c) => gate.hook(stateRef, "aaaa01")(k, c) : undefined,
      );
      stateRef = state;
      const aRoom = await roomOf(a);
      const assertion = expect(aRoom.encryptEvent("never lands")).rejects.toThrow("No common key event found");
      await gate.sent;
      await vi.advanceTimersByTimeAsync(5200);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("group decrypt — only the sender's common key is used", () => {
  it("rejects instead of trying another member's key event under the same hash", async () => {
    useFakeIntervals();
    try {
      const { alice, carol, state, a, b, c } = await groupOf3();
      const aRoom = await roomOf(a);
      const content = await aRoom.encryptEvent("from alice");
      const hash = content.hash as string;

      // The sender's key event is gone; carol has one under the SAME hash
      // holding a different secret.
      const carolKey = await (await roomOf(c)).encryptKey("carol-secret");
      state.encryption = [];
      state.putEncryption(carol.id, `pcrypto.${carol.id}.${hash}`, {
        version: 2, hash, keys: carolKey.keys, block: carolKey.block,
      });

      const bRoom = await roomOf(b);
      const assertion = expect(
        bRoom.decryptEvent({ event_id: "$g3", sender: `@${alice.id}:server`, origin_server_ts: 9000, content }),
      ).rejects.toThrow("No common key event found");
      await vi.advanceTimersByTimeAsync(5200);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("pays the 5 s wait once per missing key, not once per message", async () => {
    useFakeIntervals();
    try {
      const { alice, state, a, b } = await groupOf3();
      const aRoom = await roomOf(a);
      const c1 = await aRoom.encryptEvent("one");
      const c2 = await aRoom.encryptEvent("two");
      const c3 = await aRoom.encryptEvent("three");
      state.encryption = [];

      const bRoom = await roomOf(b);
      const ev = (id: string, content: Record<string, unknown>) =>
        ({ event_id: id, sender: `@${alice.id}:server`, origin_server_ts: 9000, content });

      // Two concurrent decrypts share a single wait…
      const first = expect(bRoom.decryptEvent(ev("$m1", c1))).rejects.toThrow("No common key event found");
      const second = expect(bRoom.decryptEvent(ev("$m2", c2))).rejects.toThrow("No common key event found");
      await vi.advanceTimersByTimeAsync(5200);
      await Promise.all([first, second]);

      // …and a later one fails immediately — no timer advance needed.
      await expect(bRoom.decryptEvent(ev("$m3", c3))).rejects.toThrow("No common key event found");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the sender's key event to arrive", async () => {
    useFakeIntervals();
    try {
      const { alice, state, a, b } = await groupOf3();
      const aRoom = await roomOf(a);
      const content = await aRoom.encryptEvent("patience");
      const saved = state.encryption;
      state.encryption = [];

      const bRoom = await roomOf(b);
      const pending = bRoom.decryptEvent({ event_id: "$g4", sender: `@${alice.id}:server`, origin_server_ts: 9000, content });
      await vi.advanceTimersByTimeAsync(1500);
      state.encryption = saved;
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toEqual({ body: "patience", msgtype: "m.text" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Pcrypto.destroy", () => {
  it("terminates the crypto worker so its per-account key cache dies with the session", async () => {
    const { terminateCryptoWorker } = await import("@/shared/lib/crypto-worker/bridge");
    const { alice, bob, state } = orderSensitivePair();
    const a = await makeParticipant({ user: alice, everyone: [alice, bob], state, tetatet: true });
    vi.mocked(terminateCryptoWorker).mockClear();

    a.pcrypto.destroy();

    expect(terminateCryptoWorker).toHaveBeenCalledTimes(1);
    expect(a.pcrypto.rooms).toEqual({});
  });
});
