/**
 * Test harness for driving the real Pcrypto / PcryptoRoom code end to end:
 * real secp256k1 key material, a fake Matrix room (member + m.room.encryption
 * state), an in-memory ChatStorage, and a `bitcoin.ecc` global backed by
 * @noble/secp256k1 (production gets it from the bundled bitcoinjs script).
 *
 * Callers must mock the modules below in the test file itself (vi.mock is
 * hoisted per file):
 *   - "@/shared/lib/crypto-worker/bridge"   → isCryptoWorkerSupported: false
 *   - "@/shared/lib/matrix/chat-storage"     → createMemoryChatStorage
 *     (from ./memory-chat-storage — NOT from this file, which imports
 *     matrix-crypto and would deadlock the mock factory)
 */
import { ProjectivePoint, utils } from "@noble/secp256k1";

import { Pcrypto } from "../matrix-crypto";

const m = 12;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Install the subset of bitcoinjs' `ecc` that pcrypto uses. */
export function installBitcoinEcc(): void {
  const ecc = {
    pointMultiply(point: Uint8Array, scalar: Uint8Array): Buffer {
      const p = ProjectivePoint.fromHex(toHex(point));
      return Buffer.from(p.multiply(BigInt("0x" + toHex(scalar))).toRawBytes(true));
    },
    pointAdd(a: Uint8Array, b: Uint8Array): Buffer {
      const pa = ProjectivePoint.fromHex(toHex(a));
      const pb = ProjectivePoint.fromHex(toHex(b));
      return Buffer.from(pa.add(pb).toRawBytes(true));
    },
  };
  (globalThis as unknown as { bitcoin: unknown }).bitcoin = { ecc };
}

export interface TestUser {
  id: string;
  sourceId: number;
  publics: string[];
  privates: Buffer[];
}

export function makeUser(id: string, sourceId: number): TestUser {
  const privates: Buffer[] = [];
  const publics: string[] = [];
  for (let i = 0; i < m; i++) {
    const priv = utils.randomPrivateKey();
    privates.push(Buffer.from(priv));
    publics.push(toHex(ProjectivePoint.fromPrivateKey(priv).toRawBytes(true)));
  }
  return { id, sourceId, publics, privates };
}

export interface StateEvent {
  event: Record<string, unknown> & { event_id: string; state_key: string };
}

/** Shared room state — every participant's Pcrypto reads the same events,
 *  like devices syncing the same Matrix room. */
export class FakeRoomState {
  members: StateEvent[] = [];
  encryption: StateEvent[] = [];
  private seq = 0;

  join(userId: string, ts: number): void {
    this.members.push({
      event: {
        event_id: `$m${++this.seq}`,
        type: "m.room.member",
        state_key: `@${userId}:server`,
        sender: `@${userId}:server`,
        origin_server_ts: ts,
        content: { membership: "join" },
      },
    });
  }

  putEncryption(senderId: string, stateKey: string, content: Record<string, unknown>): void {
    this.encryption = this.encryption.filter((e) => e.event.state_key !== stateKey);
    this.encryption.push({
      event: {
        event_id: `$e${++this.seq}`,
        type: "m.room.encryption",
        state_key: stateKey,
        sender: `@${senderId}:server`,
        origin_server_ts: Date.now(),
        content,
      },
    });
  }
}

export interface Participant {
  user: TestUser;
  pcrypto: Pcrypto;
  chat: Record<string, unknown>;
  sendStateEvent: (roomId: string, type: string, content: Record<string, unknown>, stateKey: string) => Promise<unknown>;
}

export async function makeParticipant(opts: {
  user: TestUser;
  everyone: TestUser[];
  state: FakeRoomState;
  tetatet: boolean;
  roomId?: string;
  /** Default: the state event lands in room state immediately (sync echo). */
  onSendState?: (stateKey: string, content: Record<string, unknown>) => void;
}): Promise<Participant> {
  const { user, everyone, state, tetatet } = opts;
  const roomId = opts.roomId ?? "!room:server";

  const sendStateEvent = async (
    _roomId: string,
    _type: string,
    content: Record<string, unknown>,
    stateKey: string,
  ) => {
    if (opts.onSendState) opts.onSendState(stateKey, content);
    else state.putEncryption(user.id, stateKey, content);
    return {};
  };

  const chat: Record<string, unknown> = {
    roomId,
    client: { sendStateEvent },
    getJoinedMemberCount: () => everyone.length,
    currentState: {
      getStateEvents: (type: string) =>
        type === "m.room.member" ? state.members : type === "m.room.encryption" ? state.encryption : [],
    },
    oldState: { getStateEvents: () => [] },
  };

  const pcrypto = new Pcrypto();
  pcrypto.init({
    userinfo: { id: user.id, keys: user.publics },
    private: user.privates.map((p, i) => ({ pair: null, public: user.publics[i], private: p })),
  });
  pcrypto.setHelpers({
    getUsersInfo: async (ids) =>
      everyone
        .filter((u) => ids.includes(u.id))
        .map((u) => ({ id: u.id, keys: u.publics, source: { id: u.sourceId } })),
    isTetatetChat: () => tetatet,
    isChatPublic: () => false,
    matrixId: (id) => `@${id}:server`,
  });
  pcrypto.currentblock = { height: 1000 };
  await pcrypto.prepare();

  return { user, pcrypto, chat, sendStateEvent };
}

export async function roomOf(p: Participant) {
  return p.pcrypto.addRoom(p.chat);
}

export function b64Json(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}
