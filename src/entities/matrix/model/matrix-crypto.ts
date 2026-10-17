/**
 * Custom E2E encryption — DIRECT PORT from bastyon-chat/src/application/pcrypto.js
 *
 * Uses secp256k1 elliptic curves + AES-SIV (miscreant) for message encryption.
 * Uses AES-CBC with PBKDF2 for file encryption.
 */

import * as miscreant from "miscreant";
// Same library the original uses (global `_` in bastyon-chat). Every step
// whose ORDER feeds cuhash — member history, user filtering, sortBy on
// source.id, orderedIdsHash — goes through underscore so tie-breaking,
// null/undefined placement and object iteration match pcrypto.js exactly.
import _ from "underscore";
// @ts-expect-error — no types for pbkdf2
import pbkdf2 from "pbkdf2";
// @ts-expect-error — no types for bn.js default export
import BN from "bn.js";

import {
  workerDecrypt,
  workerEncrypt,
  workerDecryptFile,
  isCryptoWorkerSupported,
  isWorkerInfraError,
  terminateCryptoWorker,
} from "@/shared/lib/crypto-worker/bridge";
import {
  deriveFileKey,
  encryptFileBuffer,
  decryptFileBuffer,
  resolveDecryptedMime,
} from "@/shared/lib/crypto-worker/file-cipher";

import {
  sha224,
  md5,
  getmatrixid,
  Base64,
  readFile,
} from "@/shared/lib/matrix/functions";
import { createChatStorage, type ChatStorageInstance } from "@/shared/lib/matrix/chat-storage";
import { cryptoDebug, looksLikeMention } from "@/shared/lib/utils/crypto-debug";
import { withTimeout } from "@/shared/lib/with-timeout";
import { everyMemberProfileLoaded } from "./group-key-members";
import { ensureRoomMembers, type LazyMembersRoom } from "./ensure-room-members";

const salt = "PR7srzZt4EfcNb3s27grgmiG8aB9vYNV82";
const m = 12;
/** Part of the group common-key hash (original `usershashVersion`). */
const USERSHASH_VERSION = 13;
/** Original getCommonKey: f.pretry(check, 50, 5000). */
const COMMON_KEY_POLL_MS = 50;
const COMMON_KEY_WAIT_MS = 5000;
/** Decrypt path: how long a confirmed common-key miss skips the wait. */
const COMMON_KEY_MISS_TTL_MS = 30_000;

/** Port of bastyon-chat functions.js pretry/retry: resolves as soon as
 *  `check()` is truthy, polling every `time` ms, or once `totaltime` ms have
 *  passed either way — the caller re-checks and decides. */
function pretry(check: () => unknown, time: number, totaltime: number): Promise<void> {
  return new Promise((resolve) => {
    if (check()) {
      resolve();
      return;
    }
    let totalTimeCounter = 0;
    const interval = setInterval(() => {
      if (check() || totaltime <= totalTimeCounter) {
        clearInterval(interval);
        resolve();
      }
      totalTimeCounter += time;
    }, time);
  });
}

interface CommonKeyStateEvent {
  event: Record<string, unknown> & { state_key?: string; content?: Record<string, unknown> };
}

/** Hard ceiling for the Pocketnet getuserprofile RPC that resolves
 *  participants' encryption keys (`getUsersInfoCb` → loadUsersInfo →
 *  psdk.userInfo.load). A blocked/slow node — typical under RU ISP filtering
 *  — used to leave `getusersinfo` pending forever, which wedged decryptKey,
 *  so the media `download()` promise never settled and the image spinner spun
 *  indefinitely (WEE-90 H1). On timeout we proceed with whatever keys are
 *  already cached; a genuine key gap then fails decrypt deterministically and
 *  the download path surfaces error+retry instead of an eternal spinner. */
const GETUSERSINFO_TIMEOUT_MS = 15_000;

// crypto.subtle access lives in shared/lib/crypto-worker/file-cipher.ts
// (shared with the crypto Web Worker, WEE-92).

// secp256k1 curve order
const secp256k1CurveN = new BN(
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
  16
);

// ---- helpers matching original functions.js ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _arrayBufferToBase64(buffer: any): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function _base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

// ---- PcryptoFile: AES-CBC file encryption ----
// Cipher internals live in shared/lib/crypto-worker/file-cipher.ts so the
// main thread and the crypto Web Worker share one format (WEE-92).

export class PcryptoFile {
  async randomKey(): Promise<string> {
    const array = new Uint32Array(24);
    return window.crypto.getRandomValues(array).toString();
  }

  async deriveKey(str: string): Promise<CryptoKey> {
    return deriveFileKey(str);
  }

  async encrypt(data: ArrayBuffer, secret: string): Promise<ArrayBuffer> {
    return encryptFileBuffer(data, secret);
  }

  async decrypt(data: ArrayBuffer, secret: string): Promise<ArrayBuffer> {
    return decryptFileBuffer(data, secret);
  }

  async encryptFile(file: Blob, secret: string): Promise<File> {
    const buffer = await readFile(file);
    const encrypted = await this.encrypt(buffer, secret);
    // Use a valid RFC 2045 MIME for the ciphertext. The previous value
    // "encrypted/<original>" is not a real MIME and caused some
    // homeserver proxies (nginx/cloudflare) to reject the upload with 415.
    // The original MIME is carried separately in the event's fileInfo.mimetype.
    return new File([encrypted], "encrypted", { type: "application/octet-stream" });
  }

  /**
   * Decrypt a ciphertext blob.
   *
   * @param originalMime — MIME type of the plaintext. New writers always
   *   store ciphertext as application/octet-stream and pass the real MIME
   *   via fileInfo.type, so prefer this argument. When omitted we fall
   *   back to stripping the legacy "encrypted/" prefix from file.type so
   *   messages written by old clients still open.
   */
  async decryptFile(file: Blob, secret: string, originalMime?: string): Promise<File> {
    const buffer = await readFile(file);
    const decrypted = await this.decrypt(buffer, secret);
    return new File([decrypted], "decrypted", {
      type: resolveDecryptedMime(file.type, originalMime),
    });
  }
}

// ---- AES-SIV encrypt/decrypt — EXACT match of original lines 1061-1090 ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const decrypt = async function (keyData: any, { encrypted, nonce }: { encrypted: string; nonce: string }): Promise<string> {
  const key = await miscreant.SIV.importKey(keyData, "AES-SIV");

  const _encrypted = new Uint8Array(_base64ToArrayBuffer(encrypted));
  const _nonce = new Uint8Array(_base64ToArrayBuffer(nonce));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const k = await key.open(_encrypted, _nonce as any);

  const decrypted = new TextDecoder().decode(k);

  return decrypted;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const encrypt = async function (text: string, keyData: any): Promise<{ encrypted: string; nonce: string }> {
  const key = await miscreant.SIV.importKey(keyData, "AES-SIV");

  const plaintext = new Uint8Array(new TextEncoder().encode(text));
  const nonce = new Uint8Array(32);

  window.crypto.getRandomValues(nonce);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ciphertext = await key.seal(plaintext, nonce as any);

  const encrypted = {
    encrypted: _arrayBufferToBase64(ciphertext.buffer),
    nonce: _arrayBufferToBase64(nonce.buffer),
  };

  return encrypted;
};

// ---- User info type ----

interface CryptoUserInfo {
  id: string;
  keys: string[];
  source?: { id?: number | string; [key: string]: unknown };
}

// ---- PcryptoRoom interface ----

/** Shared error tag for every plaintext-fallback guard. Centralised so log
 *  grep + telemetry matching stays stable no matter which send path threw. */
export const ENCRYPTION_REQUIRED_NO_KEYS =
  "encryption required but peer keys unavailable";

export interface PcryptoRoomInstance {
  canBeEncrypt(): boolean;
  /** Whether every current member's profile has loaded. canBeEncrypt() is
   *  false until it is, so callers can tell "still loading" from "a member has
   *  no keys" (audit S1-01). Optional so test doubles need not implement it. */
  membersLoaded?(): boolean;
  /** Whether the room mandates encryption (i.e. private, non-public). When
   *  true and canBeEncrypt() is false, callers must NOT fall back to
   *  plaintext — the sender has to wait for keys or fail the op. Public /
   *  "open channel" style rooms return false here; plaintext is OK for
   *  those by design. */
  requiresEncryption(): boolean;
  /** @param forceRefresh - bypass the cached peer profile and hit the network
   *  for fresh keys. Set only from an explicit user retry — never from an
   *  automatic/periodic recheck, to avoid hammering the network. */
  prepare(forceRefresh?: boolean): Promise<PcryptoRoomInstance>;
  /** Where the participants' key request stands. "loading"/"failed" mean the
   *  keys are not known yet — NOT that the peer has none. Optional so test
   *  stubs need not implement it. */
  getKeysLoadState?(): KeysLoadState;
  /** Bring the participant list up to date before anything derives
   *  recipients from it (canBeEncrypt, the 1:1 recipients, the group key
   *  hash): loads lazy-loaded members, re-reads member state, and fetches
   *  keys only for participants that changed. Call before deciding whether
   *  to encrypt. Throws if the members could not be loaded. Optional so test
   *  stubs need not implement it. */
  ensureMembers?(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _encrypt(userid: string, text: string, v?: number): Promise<{ encrypted: string; nonce: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _decrypt(userid: string, encData: any, time: number, block: number, usersIds: string[] | null, v?: number): Promise<string>;
  encryptEvent(text: string): Promise<Record<string, unknown>>;
  decryptEvent(event: Record<string, unknown>): Promise<{ body: string; msgtype: string }>;
  decryptEventGroup(event: Record<string, unknown>): Promise<{ body: string; msgtype: string }>;
  encryptEventGroup(text: string): Promise<Record<string, unknown>>;
  getOrCreateCommonKey(): Promise<{ key: string; hash: string; block: number }>;
  sendCommonKey(): Promise<{ key: string; hash: string; block: number }>;
  encryptFile(file: Blob): Promise<{ file: File; secrets: Record<string, unknown> }>;
  decryptFile(file: Blob, secret: string, originalMime?: string): Promise<File>;
  encryptKey(key: string): Promise<{ block: number; keys: string; v: number }>;
  decryptKey(event: Record<string, unknown>): Promise<string>;
  clear(): void;
  destroy(): void;
}

/** State of a room's participant key request (getusersinfo).
 *  idle: never requested (no helper, or a ≥50-member room that skips it). */
export type KeysLoadState = "idle" | "loading" | "loaded" | "failed";

// ---- Main Pcrypto class ----

export interface UserWithPrivateKeys {
  userinfo: { id: string; keys?: string[] } | null;
  private: Array<{ pair: unknown; public: string; private: Buffer }> | null;
}

export class Pcrypto {
  private user: UserWithPrivateKeys | null = null;
  currentblock = { height: 1 };
  rooms: Record<string, PcryptoRoomInstance> = {};
  private ls: ChatStorageInstance | null = null;
  private lse: ChatStorageInstance | null = null;
  private pcryptoFile = new PcryptoFile();

  // Callbacks
  private getUsersInfoCb:
    | ((ids: string[], options?: { forceUpdate?: boolean }) => Promise<CryptoUserInfo[]>)
    | null = null;
  private getIsTetatetChat: ((room: unknown) => boolean) | null = null;
  private getIsChatPublic: ((room: unknown) => boolean) | null = null;
  private getMatrixId: ((id: string) => string) | null = null;

  /** Called when user crypto keys are successfully loaded for a room */
  onKeysLoaded?: (roomId: string) => void;
  /** Called when a room's key request times out or fails */
  onKeysFailed?: (roomId: string) => void;

  init(user: UserWithPrivateKeys) {
    this.user = user;
  }

  setHelpers(helpers: {
    getUsersInfo: (ids: string[], options?: { forceUpdate?: boolean }) => Promise<CryptoUserInfo[]>;
    isTetatetChat: (room: unknown) => boolean;
    isChatPublic: (room: unknown) => boolean;
    matrixId: (id: string) => string;
  }) {
    this.getUsersInfoCb = helpers.getUsersInfo;
    this.getIsTetatetChat = helpers.isTetatetChat;
    this.getIsChatPublic = helpers.isChatPublic;
    this.getMatrixId = helpers.matrixId;
  }

  async prepare(address?: string): Promise<void> {
    try {
      const suffix = address ? `:${address}` : "";
      const [ls, lse] = await Promise.all([
        createChatStorage(`messages${suffix}`, 1),
        createChatStorage(`events${suffix}`, 1)
      ]);
      this.ls = ls;
      this.lse = lse;
    } catch (e) {
      console.error("Pcrypto storage init error:", e);
    }
  }

  async addRoom(chat: Record<string, unknown>, forceRefresh?: boolean): Promise<PcryptoRoomInstance> {
    const roomId = chat.roomId as string;
    if (this.rooms[roomId]) {
      return this.rooms[roomId].prepare(forceRefresh);
    }
    const room = await this.createPcryptoRoom(chat);
    this.rooms[roomId] = room;
    return room.prepare(forceRefresh);
  }

  /**
   * DIRECT PORT of PcryptoRoom from pcrypto.js
   * Preserves original variable names, flow, and logic.
   */
  private async createPcryptoRoom(chat: Record<string, unknown>): Promise<PcryptoRoomInstance> {
    const pcrypto = this;
    const roomId = chat.roomId as string;

    // Exact same variables as original
    let users: Record<string, { id: string; life: { start: number; end?: number }[] }> = {};
    let usersinfo: Record<string, CryptoUserInfo> = {};
    // Monotonic generation counter guarding `usersinfo` writes below. Two
    // getusersinfo() calls can be in flight at once (e.g. the 30s auto-recheck
    // vs. an explicit forced "Retry"/"Republish"); without this, whichever
    // network call happens to resolve LAST wins — even if it was the older,
    // unforced (cached) call started before the forced one — silently
    // clobbering freshly-fetched keys with stale data.
    let usersinfoGeneration = 0;
    // Forced (user Retry) getusersinfo calls still in flight. A later call
    // makes their response stale; a call that must start meanwhile is forced
    // too, so the newest generation still carries fresh keys.
    let forcedRefreshesInFlight = 0;
    // Outcome of the latest getusersinfo() call. Lets callers tell "keys not
    // received yet" apart from "the peer has no keys" — canBeEncrypt() is
    // false in both cases.
    let keysLoadState: KeysLoadState = "idle";

    const version = 2;
    // Bumped (10 -> 11) to invalidate any decrypted-plaintext entries cached
    // under the old prefix before the aeskeys cache-collision fix — cheap
    // insurance so a stale entry can never be served even though AES-SIV's
    // built-in authentication means a wrong key should already fail loudly
    // rather than silently caching wrong plaintext.
    const ecachekey = "e_pcrypto11_";
    // ---- persistent AES-key cache (pcrypto.ls) — original lines 36, 61 ----
    const lcachekey = "pcrypto10_" + roomId + "_";
    const lsspromises: Record<string, Promise<{ keys: Record<string, unknown>; k: string }>> = {};
    // getCommonKey: in-flight waits and recent misses, per state key.
    const commonKeyWaits: Record<string, Promise<void>> = {};
    const commonKeyMisses: Record<string, number> = {};

    // ---- getusersbytime — EXACT match of original lines 294-307 ----
    function getusersbytime(time: number): { id: string; life: { start: number; end?: number }[] }[] {
      
      return _.filter(users, function (ui) {
        const l = _.find(ui.life, function (l) {
          if (!time) {
            if (l.start && !l.end) return true;
          } else {
            if (l.start < time && (!l.end || l.end > time)) return true;
          }
          return false;
        });
        return !!l;
      });
    }

    // ---- getusersinfobytime — EXACT match of original lines 280-292 ----
    function getusersinfobytime(time: number): CryptoUserInfo[] {
      const us = getusersbytime(time);
      return _.filter(
        _.map(us, function (u) { return usersinfo[u.id]; }),
        function (u) { return !!u; },
      );
    }

    // Original: _.sortBy(r, u => u.source.id). `?.` instead of a bare
    // `u.source.id` only so a profile without `source` sorts last (underscore
    // puts undefined at the end) rather than throwing a TypeError.
    function bySourceId(u: CryptoUserInfo): number | string | undefined {
      return u.source?.id;
    }

    // ---- preparedUsers — match of original lines 66-86 ----
    /** Every current member has a loaded profile (audit S1-01). */
    function currentMembersLoaded(): boolean {
      return everyMemberProfileLoaded(getusersbytime(0).map((u) => u.id), usersinfo);
    }

    function preparedUsers(time: number, v?: number): CryptoUserInfo[] {
      const r = _.filter(getusersinfobytime(time), function (ui) {
        return !!ui.keys && ui.keys.length >= m;
      });
      if (!v || v <= 1) return r;
      return _.sortBy(r, bySourceId);
    }

    // ---- preparedUsersById — EXACT match of original lines 88-110 ----
    function preparedUsersById(ids: string[], v?: number): CryptoUserInfo[] {
      const ui: CryptoUserInfo[] = [];
      _.each(users, function (u) {
        if (_.indexOf(ids, u.id) > -1) {
          const info = usersinfo[u.id];
          if (info && info.keys && info.keys.length >= m) {
            ui.push(info);
          }
        }
      });
      if (!v || v <= 1) return ui;
      return _.sortBy(ui, bySourceId);
    }

    // ---- getuserseventshistory — EXACT match of original lines 175-219 ----
    type HistoryEntry = { time: number; membership: string; id: string };

    function getuserseventshistory(): HistoryEntry[] {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chatAny = chat as any;
      const tetatet = pcrypto.getIsTetatetChat?.(chat) ?? false;

      // Collect all member state events (dedup by event_id). Entries without
      // `.event` are dropped up front — the original would throw on them.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type MemberStateEvent = { event: any };
      const curState = (chatAny.currentState?.getStateEvents?.("m.room.member") ?? []) as MemberStateEvent[];
      const oldState = (chatAny.oldState?.getStateEvents?.("m.room.member") ?? []) as MemberStateEvent[];


      const allevents = _.uniq(
        _.filter(([] as MemberStateEvent[]).concat(curState, oldState), function (e) { return !!e?.event; }),
        false,
        function (e) { return e.event.event_id; },
      );

      const history = _.filter(
        _.map(allevents, function (ue): HistoryEntry | null {
          const event = ue.event;
          const membership = event.content.membership as string;

          if (
            membership == "invite" ||
            membership == "join" ||
            (membership == "leave" && !tetatet)
          ) {
            return {
              time: event.origin_server_ts || 1,
              membership: membership,
              id: getmatrixid(event.state_key || event.sender),
            };
          }

          return null;
        }),
        function (h) { return !!h; },
      ) as HistoryEntry[];

      return _.sortBy(history, function (ui) { return ui.time; });
    }

    // ---- period — EXACT match of original lines 221-232 ----
    // Cache-key component for the implicit ("current room members", usersIds
    // == null) case in aeskeysls() below: an index derived from the member
    // event history, so a join/leave that changes the history changes this
    // value and busts any AES-key cache entry keyed on the old one — instead
    // of a bare (time, block, v) tuple, which stays identical across a
    // membership change and would silently serve stale derived keys.
    function period(time: number): number {
      let result = 0;
      const h = getuserseventshistory();

      for (let i = h.length - 1; i >= 0; i--) {
        if ((h[i].time < time || !time) && !result) {
          result = i;
        }
      }

      return result;
    }

    // ---- orderedIdsHash — EXACT match of original lines 841-845 ----
    function orderedIdsHash(ids: string[]): string {
      return md5(_.sortBy(ids, function (id) {
        return Number(id.replace(/[^0-9]/g, ""));
      }).join(""));
    }

    // ---- getusershistory — EXACT match of original lines 244-278 ----
    function getusershistory() {
      const history = getuserseventshistory();
      const tetatet = pcrypto.getIsTetatetChat?.(chat) ?? false;

      // Build users dict — EXACT match of original lines 244-278
      users = {};

      _.each(history, function (ui) {
        if (!users[ui.id]) {
          users[ui.id] = {
            id: ui.id,
            life: [],
          };
        }

        const l = users[ui.id].life;

        if (
          ui.membership &&
          (ui.membership == "join" || ui.membership == "invite")
        ) {
          l.push({
            start: tetatet ? 1 : ui.time,
          });
        } else {
          if (l.length && ui.membership == "leave" && !tetatet) {
            const last = l[l.length - 1];
            last.end = ui.time;
          }
        }
      });
    }

    // ---- getusersinfo — EXACT match of original lines 157-173 ----
    // forceRefresh bypasses the cached peer profile (SDK userInfo cache) and
    // hits the network for fresh keys — only ever passed from an explicit
    // user retry (see PcryptoRoomInstance.prepare docs), never from an
    // automatic/periodic recheck.
    async function getusersinfo(forceRefresh?: boolean): Promise<void> {
      const us = Object.values(users).map(function (uh) { return uh.id; });
      if (!pcrypto.getUsersInfoCb) return;
      const myGeneration = ++usersinfoGeneration;
      keysLoadState = "loading";
      if (forceRefresh) forcedRefreshesInFlight++;
      let _usersinfo: CryptoUserInfo[];
      try {
        // Bound the key-resolution RPC: a stalled Pocketnet node must never
        // wedge decryptKey/prepare forever (WEE-90 H1). On timeout we keep the
        // previously-resolved `usersinfo` and return — missing keys then fail
        // decrypt deterministically downstream, surfacing error+retry instead
        // of an eternal media spinner.
        _usersinfo = await withTimeout(
          pcrypto.getUsersInfoCb(us, { forceUpdate: forceRefresh }),
          GETUSERSINFO_TIMEOUT_MS,
          "getusersinfo",
        );
      } catch (e) {
        if (forceRefresh) forcedRefreshesInFlight--;
        console.warn("[pcrypto] getusersinfo timed out/failed:", e);
        // A newer call is in flight — its outcome decides the state.
        if (myGeneration === usersinfoGeneration) {
          keysLoadState = "failed";
          pcrypto.onKeysFailed?.(roomId);
        }
        return;
      }
      if (forceRefresh) forcedRefreshesInFlight--;
      // Discard a stale response: a newer getusersinfo() call (e.g. a forced
      // retry started while this unforced one was still in flight) already
      // wrote more current data — applying this one now would clobber it.
      if (myGeneration !== usersinfoGeneration) return;
      usersinfo = {};
      for (const ui of _usersinfo) {
        usersinfo[ui.id] = ui;
      }
      keysLoadState = "loaded";
      // Notify that keys are loaded — triggers decryption retry
      pcrypto.onKeysLoaded?.(roomId);
    }

    // ---- eaa object — EXACT match of original lines 405-527 ----
    const eaa = {
      cuhash: function (users: CryptoUserInfo[], num: number, block: number): Buffer {
        const input = _.map(users, function (u) { return u.keys[num]; }).join("") + (block || pcrypto.currentblock.height);
        return pbkdf2.pbkdf2Sync(
          sha224(input).toString("hex"),
          salt,
          1,
          32,
          "sha256"
        );
      },

      userspublics: function (time: number, block: number, usersIds: string[] | null, v: number | undefined) {
        // Original line 423: use preparedUsersById when usersIds is provided
        const _users = usersIds ? preparedUsersById(usersIds, v) : preparedUsers(time, v);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sum: Record<string, any> = {};

        _.each(_users, function (user) {
          // Original skips self in userspublics (line 430)
          if (user.id == pcrypto.user?.userinfo?.id && _users.length > 1) {
            return;
          }

          const publics = _.map(user.keys, function (key) {
            return Buffer.from(key, "hex");
          });

          sum[user.id] = eaa.points(time, block, publics, usersIds, v);
        });

        return sum;
      },

      current: function (time: number, block: number, usersIds: string[] | null, v: number | undefined) {
        const privates = pcrypto.user!.private!.map(function (key) {
          return key.private;
        });

        const sc = eaa.scalars(time, block, privates, usersIds, v);
        // Original: Buffer.allocUnsafe(32) + sc.toBuffer().copy(buf, 32-len)
        // Equivalent: toArrayLike with zero-padding
        return Buffer.from(sc.toArrayLike(Uint8Array, "be", 32));
      },

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scalars: function (time: number, block: number, scalars: any[], usersIds: string[] | null, v: number | undefined) {
        // Original line 458: use preparedUsersById when usersIds is provided
        const _users = usersIds ? preparedUsersById(usersIds, v) : preparedUsers(time, v);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let sum: any = null;

        for (let i = 0; i < m; i++) {
          const ch = new BN(eaa.cuhash(_users, i, block));

          const a = new BN(scalars[i], 16);

          const mul = a.mul(ch).umod(secp256k1CurveN);

          if (!i) {
            sum = mul;
          } else {
            sum = sum.add(mul).umod(secp256k1CurveN);
          }
        }

        return sum;
      },

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      points: function (time: number, block: number, points: any[], usersIds: string[] | null, v: number | undefined) {
        // Original line 482: use preparedUsersById when usersIds is provided
        const _users = usersIds ? preparedUsersById(usersIds, v) : preparedUsers(time, v);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let sum: any = null;

        for (let i = 0; i < m; i++) {
          const ch = eaa.cuhash(_users, i, block);

          const mul = bitcoin.ecc.pointMultiply(points[i], ch, undefined, true);

          if (!i) {
            sum = mul;
          } else {
            sum = bitcoin.ecc.pointAdd(sum, mul, undefined, true);
          }
        }

        return sum;
      },

      // ---- aeskeys — EXACT match of original eaa.aeskeys (lines 504-526) ----
      // Pure derivation, no caching here — caching lives one level up, in
      // aeskeysls() below (matches original: eaa.aeskeys is raw, the cache
      // is in eaac.aeskeysls).
      aeskeys: function (time: number, block: number, usersIds: string[] | null, v: number | undefined) {
        const us = eaa.userspublics(time, block, usersIds, v);
        const c = eaa.current(time, block, usersIds, v);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const su: Record<string, any> = {};

        _.each(us, function (s, id) {
          if (id != pcrypto.user?.userinfo?.id) {
            const shared = bitcoin.ecc.pointMultiply(s, c, undefined, true);
            // pointMultiply may return Uint8Array, not Buffer — use Buffer.from for safe hex
            const safeHex = Buffer.from(shared).toString("hex");
            su[id] = pbkdf2.pbkdf2Sync(
              safeHex,
              salt,
              64,
              32,
              "sha512"
            );
          }
        });

        return su;
      },
    };

    // ---- aeskeysls — EXACT match of original eaac.aeskeysls (lines 348-396) ----
    // Persistent, membership-aware cache for aeskeys(): keyed on orderedIdsHash
    // (explicit usersIds) or period(time) (implicit "current room members"),
    // never on a bare tuple that stays constant across a membership change —
    // see period() above for why that distinction matters. Backed by
    // pcrypto.ls (IndexedDB) so the expensive ECDH+pbkdf2 derivation runs once
    // per member-state generation, not once per message, and survives reloads.
    async function aeskeysls(
      time: number,
      block: number,
      usersIds: string[] | null,
      v: number | undefined
    ): Promise<{ keys: Record<string, unknown>; k: string }> {
      let _time = time;
      let _block = block;
      if (!_time) _time = 0;
      if (!_block) {
        const tetatet = pcrypto.getIsTetatetChat?.(chat) ?? false;
        _block = tetatet ? pcrypto.currentblock.height : 10;
      }

      // `v` is the RAW event version (undefined for legacy messages) — the
      // derivation below must see it unmodified, like the original, because
      // v <= 1 means an unsorted user list. The cache-key suffix normalises
      // undefined → 1 instead of the original's `v || self.version`: that
      // made v1 and v2 share one entry despite deriving different keys.
      // The members' public keys are part of the key too: a member who rotated
      // keys without a membership change kept the cached shared secret for
      // the whole generation (audit S1-05). Local storage only — no effect on
      // the wire format.
      const keyUsers = usersIds ? preparedUsersById(usersIds, v) : preparedUsers(_time, v);
      const keysFingerprint = md5(keyUsers.map((u) => `${u.id}:${(u.keys ?? []).join(",")}`).join("|")).slice(0, 12);
      const k = `${usersIds ? "ul+" + orderedIdsHash(usersIds) : period(_time)}-${_block}-${v && v > 1 ? v : 1}-${keysFingerprint}`;
      const ek = `${lcachekey}${pcrypto.user?.userinfo?.id}-${k}`;

      if (!lsspromises[ek]) {
        lsspromises[ek] = (async () => {
          try {
            const stored = await pcrypto.ls?.get(ek);
            if (!stored) throw new Error("Data does not exist");
            const keys: Record<string, unknown> = {};
            for (const [id, b64] of Object.entries(stored as Record<string, string>)) {
              keys[id] = Buffer.from(b64, "base64");
            }
            return { keys, k };
          } catch {
            const keys = eaa.aeskeys(_time, _block, usersIds, v);
            if (preparedUsers(_time, v).length > 1) {
              const serialized: Record<string, string> = {};
              for (const [id, buf] of Object.entries(keys)) {
                serialized[id] = Buffer.from(buf as Buffer).toString("base64");
              }
              await pcrypto.ls?.set(ek, serialized).catch(() => {});
            }
            return { keys, k };
          }
        })().finally(() => {
          delete lsspromises[ek];
        });
      }

      return lsspromises[ek];
    }

    /** Prepare users data for Worker serialization (fast — no crypto, just filtering). */
    function prepareWorkerUsers(usersIds: string[] | null, v: number | undefined): Array<{ id: string; keys: string[] }> {
      const _users = usersIds ? preparedUsersById(usersIds, v) : preparedUsers(0, v);
      return _users.map(u => ({ id: u.id, keys: [...u.keys] }));
    }

    /** Get current user's private keys as hex strings for Worker. */
    function getPrivateKeysHex(): string[] {
      return pcrypto.user!.private!.map(k =>
        Buffer.isBuffer(k.private) ? k.private.toString("hex") : String(k.private),
      );
    }

    // ---- usershash — match of original lines 824-839 ----
    // Keyed by membership alone, not by the members' public keys: the group's
    // common-key event is reused until somebody joins or leaves. A member whose
    // published keys change cannot read events wrapped for the old keys until
    // the membership changes. Keys are derived from the account key, so this
    // takes a deliberate republish of a different set (review 2026-10-08, H1);
    // changing it means a new wire format, agreed with Bastyon.
    function usershash(): string {
      const _users = preparedUsers(0, version);
      return md5(
        _.filter(
          _.map(_users, function (user) { return user.id; }),
          function (uid) { return !!uid && uid != pcrypto.user?.userinfo?.id; },
        ).join("") + "_v" + USERSHASH_VERSION + "_" + version
      );
    }

    // ---- Group chat helpers (common key system) ----

    // ---- getCommonKeyEvent — EXACT match of original lines 870-886 ----
    function getCommonKeyEvent(userid?: string, _hash?: string): CommonKeyStateEvent | undefined {
      const hash = _hash || usershash();
      const uid = userid || pcrypto.user?.userinfo?.id;
      if (!uid) return undefined;

      const state_key = "pcrypto." + uid + "." + hash;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chatAny = chat as any;
      const events = (chatAny.currentState?.getStateEvents?.("m.room.encryption") ?? []) as CommonKeyStateEvent[];

      return _.find(events, function (e) {
        return e?.event?.state_key == state_key;
      });
    }

    // ---- getCommonKey — EXACT match of original lines 888-908 ----
    // Only the requested user's key event is accepted — never another
    // member's event under the same hash: group bodies are AES-CBC with no
    // MAC, so a wrong key can yield garbage that passes the padding check.
    // Waits up to COMMON_KEY_WAIT_MS for the event to land in room state
    // (right after sendStateEvent, or while state is still syncing).
    //
    // `rememberMiss` (decrypt path only) is a local performance guard, not a
    // protocol change: the original decrypts lazily per rendered message, but
    // our timeline/preview loops decrypt serially, so N messages from a
    // sender with no key event would cost N × 5 s. Concurrent callers share
    // one wait per state key, and a miss is remembered for
    // COMMON_KEY_MISS_TTL_MS so later messages fail fast.
    async function getCommonKey(
      userid?: string,
      _hash?: string,
      rememberMiss = false,
    ): Promise<Record<string, unknown>> {
      const hash = _hash || usershash();
      const stateKey = "pcrypto." + (userid || pcrypto.user?.userinfo?.id) + "." + hash;

      if (!getCommonKeyEvent(userid, hash)) {
        const missAt = rememberMiss ? commonKeyMisses[stateKey] : undefined;
        if (!missAt || Date.now() - missAt >= COMMON_KEY_MISS_TTL_MS) {
          if (!commonKeyWaits[stateKey]) {
            commonKeyWaits[stateKey] = pretry(
              () => getCommonKeyEvent(userid, hash),
              COMMON_KEY_POLL_MS,
              COMMON_KEY_WAIT_MS,
            ).finally(() => {
              delete commonKeyWaits[stateKey];
            });
          }
          await commonKeyWaits[stateKey];
        }
      }

      const e = getCommonKeyEvent(userid, hash);
      if (!e) {
        if (rememberMiss) commonKeyMisses[stateKey] = Date.now();
        throw new Error("No common key event found for hash=" + hash);
      }
      delete commonKeyMisses[stateKey];
      return e.event;
    }

    // ---- Room interface ----
    const room: PcryptoRoomInstance = {
      requiresEncryption(): boolean {
        // Private (non-public) rooms mandate encryption. Public rooms are
        // allowed to send plaintext by design — Bastyon convention for
        // open channels.
        const publicChat = pcrypto.getIsChatPublic?.(chat) ?? false;
        if (publicChat) return false;

        // Large rooms (≥50 members) also fall back to plaintext by design —
        // E2E group-key exchange is not workable at that scale, and
        // canBeEncrypt() explicitly returns false for them. requiresEncryption()
        // must mirror that same gate or the two signals diverge and every
        // send in a large private group throws ENCRYPTION_REQUIRED_NO_KEYS,
        // permanently stranding messages in the outbound queue.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const serverCount = (chat as any).getJoinedMemberCount?.() ?? 0;
        const memberCount = Math.max(serverCount, Object.keys(usersinfo).length);
        if (memberCount >= 50) return false;

        return true;
      },

      membersLoaded(): boolean {
        return currentMembersLoaded();
      },

      canBeEncrypt(): boolean {
        const publicChat = pcrypto.getIsChatPublic?.(chat) ?? false;
        if (publicChat) return false;
        if (!pcrypto.user?.private || pcrypto.user.private.length !== 12) return false;
        if (!pcrypto.user.userinfo?.id || !users[pcrypto.user.userinfo.id]) return false;

        // Use the MAXIMUM of server summary count and locally loaded users.
        // getJoinedMemberCount() comes from /sync summary — accurate for large rooms.
        // usersinfo may only have lazy-loaded fraction (e.g. 19 out of 800).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const serverCount = (chat as any).getJoinedMemberCount?.() ?? 0;
        const usersinfoArray = Object.values(usersinfo);
        const memberCount = Math.max(serverCount, usersinfoArray.length);
        if (memberCount <= 1 || memberCount >= 50) return false;
        // Guard against empty-array short-circuit: refuse until peer is loaded.
        if (usersinfoArray.length < 2) return false;
        // Every current member must be loaded, not just two: the common key is
        // wrapped only for loaded members, so anyone still loading could never
        // read what gets sent now. The send throws and SyncEngine retries once
        // the profiles land (audit S1-01, forta-bugs#1399 #1394).
        if (!currentMembersLoaded()) return false;

        // ALL participants must have 12 published keys for ECDH to work
        return usersinfoArray.every(u => u.keys && u.keys.length >= m);
      },

      async prepare(forceRefresh?: boolean): Promise<PcryptoRoomInstance> {
        getusershistory();

        // Skip expensive network call for large rooms: E2EE is disabled
        // when there are ≥50 participants (canBeEncrypt returns false),
        // so fetching everyone's crypto keys is wasted work that blocks
        // message rendering for seconds in 1000+ member rooms.
        // Use getJoinedMemberCount (from server summary) as primary check —
        // Object.keys(users) may be incomplete with lazyLoadMembers.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const actualMemberCount = (chat as any).getJoinedMemberCount?.() ?? 0;
        const memberCount = Math.max(actualMemberCount, Object.keys(users).length);
        if (memberCount < 50) {
          await getusersinfo(forceRefresh);
        }

        return room;
      },

      getKeysLoadState(): KeysLoadState {
        return keysLoadState;
      },

      async ensureMembers(): Promise<void> {
        // Rooms Pcrypto never encrypts need no recipients (same gate as prepare()).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (((chat as any).getJoinedMemberCount?.() ?? 0) >= 50) return;
        // fresh: a list possibly stale after a limited sync is reloaded first.
        await ensureRoomMembers(chat as LazyMembersRoom, { fresh: true });
        // Local recompute from room state — members may also have arrived
        // through sync or another caller since the last prepare(). Again after
        // each key load: a member who joined while it ran was left out of the
        // recipients (review 2026-10-08, H3). Bounded, so a room whose
        // membership churns faster than three loads sends with what it has.
        for (let pass = 0; pass < 3; pass++) {
          const before = Object.keys(users).sort().join(",");
          getusershistory();
          if (Object.keys(users).sort().join(",") === before) return;
          await getusersinfo(forcedRefreshesInFlight > 0);
          // canBeEncrypt() reads usersinfo: after a failed request it still
          // holds the old participants and would encrypt without the new ones.
          if (keysLoadState === "failed") throw new Error("participant keys not loaded");
        }
      },

      // ---- encryptEvent — routes to group or 1:1 path ----
      async encryptEvent(text: string): Promise<Record<string, unknown>> {
        const tetatet = pcrypto.getIsTetatetChat?.(chat) ?? false;

        // Boolean signals only — `text` itself must never appear in this
        // payload. `hasMention` is a presence flag derived from a regex,
        // not the captured mention text.
        cryptoDebug("encrypt", {
          roomId,
          tetatet,
          textLen: text.length,
          hasMention: looksLikeMention(text),
          memberCount: Object.keys(usersinfo).length,
          version,
        });

        // Group chats use common key + AES-CBC
        if (!tetatet) {
          return room.encryptEventGroup(text);
        }

        // 1:1 chats use per-user ECDH + AES-SIV
        const _users = preparedUsers(0, version);

        // Warn if not all room members have keys (encryption will be partial)
        const allMembers = Object.values(usersinfo);
        const missingKeys = allMembers.filter(u => !u.keys || u.keys.length < m);
        if (missingKeys.length > 0) {
          console.warn("[pcrypto] encryptEvent: " + missingKeys.length + " member(s) missing encryption keys:", missingKeys.map(u => u.id.slice(0, 10)));
        }

        // Refuse to ship a body encrypted to ZERO recipients (Base64.encode("{}")) —
        // receiver would only see `emptyforme` / AES-SIV verification failure.
        if (_users.length === 0) {
          throw new Error("No recipients with published keys — refusing to encrypt empty body");
        }

        const encryptedEvent: Record<string, unknown> = {
          block: pcrypto.currentblock.height,
          version: version,
          msgtype: "m.encrypted",
          body: {} as Record<string, unknown>,
        };

        const body: Record<string, unknown> = {};
        for (let i = 0; i < _users.length; i++) {
          const user = _users[i];
          if (user.id != pcrypto.user?.userinfo?.id || _users.length <= 1) {
            body[user.id] = await room._encrypt(user.id, text, version);
          }
        }

        encryptedEvent.body = Base64.encode(JSON.stringify(body));
        return encryptedEvent;
      },

      // ---- decryptEvent — routes to group or 1:1 path ----
      async decryptEvent(event: Record<string, unknown>): Promise<{ body: string; msgtype: string }> {
        const content = event.content as Record<string, unknown>;
        if (!pcrypto.user?.userinfo) throw new Error("userinfo");

        cryptoDebug("decrypt:route", {
          roomId,
          eventId: event.event_id,
          hasHash: Boolean(content.hash),
          hasBlock: Boolean(content.block),
          hasVersion: Boolean(content.version),
          msgtype: content.msgtype,
          senderMatrix: event.sender,
        });

        // Group messages have a 'hash' field → use group decryption (AES-CBC)
        if (content.hash) {
          return room.decryptEventGroup(event);
        }

        const k = `${ecachekey}${pcrypto.user.userinfo.id}-${(content.edited as string) || (event.event_id as string)}`;

        // Check cache
        try {
          const stored = await pcrypto.lse?.get(k);
          if (stored) {
            const parsed = JSON.parse(stored as string);
            if (parsed) return parsed;
          }
        } catch { /* not cached */ }

        // Decrypt
        const sender = getmatrixid(event.sender as string);
        const me = pcrypto.user.userinfo.id;

        let keyindex: string | undefined;
        let bodyindex: string | undefined;

        // Decode Base64 body
        const bodyStr = content.body as string;
        let decoded_atob: string;
        try {
          decoded_atob = window.atob(bodyStr);
        } catch (e) {
          throw new Error("Invalid Base64 in body: " + String(e));
        }

        // Guard: if decoded string doesn't start with '{', it's not pcrypto JSON
        if (!decoded_atob.startsWith("{")) {
          throw new Error("Not pcrypto format (body is not JSON)");
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(decoded_atob);
        } catch (e) {
          throw new Error("Not pcrypto format (JSON parse failed): " + String(e));
        }

        // Check if encrypted payload exists at all
        const allIds = Object.keys(body);
        if (allIds.length === 0) {
          throw new Error("Empty encrypted body — sender may lack encryption keys");
        }

        const time = (event.origin_server_ts as number) || 1;
        const block = content.block as number;
        const eventVersion = content.version as number | undefined;
        const bodyKeyCount = Object.keys(body).length;

        // Check if prepared users (with valid keys) cover ALL body users + sender
        const allNeededIds = [...new Set([...Object.keys(body), sender])];
        const preparedBefore = preparedUsers(0, eventVersion || version);
        const preparedIds = new Set(preparedBefore.map(u => u.id));
        const hasMissing = allNeededIds.some(id => !preparedIds.has(id));
        if (hasMissing) {
          getusershistory();
          await getusersinfo();

          // If room state is still incomplete, populate users from body keys + sender
          const preparedAfter = preparedUsers(0, eventVersion || version);
          const preparedAfterIds = new Set(preparedAfter.map(u => u.id));
          const stillMissing = allNeededIds.some(id => !preparedAfterIds.has(id));
          if (stillMissing && pcrypto.getUsersInfoCb) {
            for (const uid of allNeededIds) {
              if (!users[uid]) {
                users[uid] = { id: uid, life: [{ start: 1 }] };
              }
            }
            await getusersinfo();
          }
        }

        if (sender == me) {
          // Find the other user's key (like _.find on object)
          for (const [i] of Object.entries(body)) {
            if (i != me) {
              keyindex = i;
              bodyindex = i;
              break;
            }
          }
        } else {
          bodyindex = me;
          keyindex = sender;
        }

        if (!bodyindex || !body[bodyindex]) {
          throw new Error("no encrypted payload for this user — sender may not have our encryption keys");
        }

        const bodyUserIds = Object.keys(body);
        const usersList = [...new Set([...bodyUserIds, sender])];


        // Deliberate deviation: the original decryptEvent passes users=null,
        // i.e. preparedUsers(time, v) from local member state. We use the
        // body keys + sender instead (the scheme the original uses only in
        // decryptKey) — the exact set the sender encrypted to. It derives the
        // same key whenever local member state is complete, and still works
        // when web's lazy-loaded m.room.member events haven't synced yet
        // (otherwise: different cuhash → AES-SIV MAC failure). The raw
        // `eventVersion` keeps legacy (unsorted, v1) ordering intact.
        const decrypted = await room._decrypt(keyindex!, body[bodyindex], time, block, usersList, eventVersion);

        const data = {
          body: decrypted,
          msgtype: "m.text",
        };

        pcrypto.lse?.set(k, JSON.stringify(data)).catch(() => {});

        return data;
      },

      // ---- decryptEventGroup — group messages use AES-CBC with a common key ----
      async decryptEventGroup(event: Record<string, unknown>): Promise<{ body: string; msgtype: string }> {
        if (!pcrypto.user?.userinfo) throw new Error("userinfo");

        const content = event.content as Record<string, unknown>;
        const hash = content.hash as string;
        const sender = getmatrixid(event.sender as string);

        const cacheKey = `${ecachekey}${pcrypto.user.userinfo.id}-${(content.edited as string) || (event.event_id as string)}`;

        // Check cache
        try {
          const stored = await pcrypto.lse?.get(cacheKey);
          if (stored) {
            const parsed = JSON.parse(stored as string);
            if (parsed) return parsed;
          }
        } catch { /* not cached */ }

        // The SENDER's common key only (original line 1001), waiting for it to
        // land in room state. decryptKey re-prepares members on its own.
        let commonKeyEvt: Record<string, unknown>;
        try {
          commonKeyEvt = await getCommonKey(sender, hash, true);
        } catch (e) {
          cryptoDebug("decrypt:group:no-common-key", {
            roomId,
            eventId: event.event_id,
            // hashLen rather than hash itself: the MD5 of member IDs is not
            // secret, but in combination with roomId+sender it pinpoints the
            // server-side state event that holds the encrypted group key.
            hashLen: hash.length,
            sender,
            memberCount: Object.keys(usersinfo).length,
          });
          throw e;
        }
        // Decrypt the common key (AES-SIV per-user encrypted key)
        const commonKey = await room.decryptKey(commonKeyEvt);

        // Decrypt message body (hex-encoded AES-CBC ciphertext)
        const bodyHex = content.body as string;
        const bodyBytes = Buffer.from(bodyHex, "hex");
        // Exact byte range: a Buffer may be a view into a larger pooled
        // ArrayBuffer (Node does this; the browser polyfill happens not to).
        const decryptedBuffer = await pcrypto.pcryptoFile.decrypt(
          bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength),
          commonKey,
        );

        const dec = new TextDecoder();
        const data = {
          body: dec.decode(new Uint8Array(decryptedBuffer)),
          msgtype: "m.text",
        };
        pcrypto.lse?.set(cacheKey, JSON.stringify(data)).catch(() => {});

        return data;
      },

      // ---- encryptEventGroup — group encryption with common key + AES-CBC ----
      async encryptEventGroup(text: string): Promise<Record<string, unknown>> {
        // Get or create the common key for this room
        const info = await room.getOrCreateCommonKey();

        const encryptedEvent: Record<string, unknown> = {
          msgtype: "m.encrypted",
          body: {},
          block: info.block,
          hash: info.hash,
        };

        const utf8Encode = new TextEncoder();
        const encrypted = await pcrypto.pcryptoFile.encrypt(utf8Encode.encode(text).buffer, info.key);

        encryptedEvent.body = Buffer.from(encrypted).toString("hex");

        return encryptedEvent;
      },

      // ---- getOrCreateCommonKey — match of original lines 910-935 ----
      async getOrCreateCommonKey(): Promise<{ key: string; hash: string; block: number }> {
        const ce = getCommonKeyEvent();

        if (ce) {
          const evt = ce.event;
          const key = await room.decryptKey(evt);
          const evtContent = evt.content as Record<string, unknown>;
          return {
            key,
            hash: evtContent.hash as string,
            block: evtContent.block as number,
          };
        }

        // Need to create a new common key
        return room.sendCommonKey();
      },

      // ---- sendCommonKey — original createMyCommonKey + sendCommonKey
      // (lines 937-984, 847-868) and the decryptKey step of getOrCreateCommonKey.
      async sendCommonKey(): Promise<{ key: string; hash: string; block: number }> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chatAny = chat as any;
        const matrixClient = chatAny.client;
        if (!matrixClient?.sendStateEvent) {
          throw new Error("Cannot send state event: no matrix client access");
        }

        const me = pcrypto.user!.userinfo!.id;
        const hash = usershash();
        const secret = await pcrypto.pcryptoFile.randomKey();
        const encrypted = await room.encryptKey(secret);

        const exportContent = {
          version: version,
          hash,
          keys: encrypted.keys,
          block: encrypted.block,
        };

        // Self-check before publishing: the key we are about to put into room
        // state must decrypt back for us — otherwise nobody gets a key that
        // cannot be read.
        await room.decryptKey({
          type: "m.room.encryption",
          sender: me,
          origin_server_ts: Date.now(),
          content: { ...exportContent },
        });

        await matrixClient.sendStateEvent(roomId, "m.room.encryption", exportContent, "pcrypto." + me + "." + hash);

        // Like the original: read the key back from the state event once it
        // lands, rather than trusting the local secret.
        const evt = await getCommonKey(me, hash);
        const key = await room.decryptKey(evt);
        const evtContent = evt.content as Record<string, unknown>;

        return {
          key,
          hash: evtContent.hash as string,
          block: evtContent.block as number,
        };
      },

      // Internal decrypt — offloaded to Web Worker for zero main-thread blocking.
      // All heavy crypto (ECDH, pbkdf2, AES-SIV) runs in a separate thread.
      // Falls back to the main-thread eaa path when the worker is unavailable
      // (old WebViews without module-worker support) — WEE-96 A3.
      async _decrypt(
        userid: string,
        encData: { encrypted: string; nonce: string },
        time: number,
        block: number,
        usersIds: string[] | null,
        v: number | undefined
      ): Promise<string> {
        // aeskeysls normalization (original lines 352-362) — fast, stays on main thread
        let _time = time;
        let _block = block;
        if (!_time) _time = 0;
        if (!_block) {
          const tetatet = pcrypto.getIsTetatetChat?.(chat) ?? false;
          _block = tetatet ? pcrypto.currentblock.height : 10;
        }

        if (isCryptoWorkerSupported()) {
          // Prepare serializable data for Worker (fast — no crypto, just array ops).
          // Raw `v`, never `v || version`: legacy events carry no version and
          // the original derives their keys from the UNSORTED user list.
          const workerUsers = prepareWorkerUsers(usersIds, v);
          const myId = pcrypto.user!.userinfo!.id;
          const privateKeys = getPrivateKeysHex();

          try {
            // All heavy crypto (ECDH + pbkdf2 + AES-SIV) runs in Worker thread
            return await workerDecrypt({
              users: workerUsers,
              myId,
              privateKeys,
              targetUserId: userid,
              encData,
              time: _time,
              block: _block,
            });
          } catch (e) {
            // Crypto errors (emptykey, MAC failure) must propagate — only
            // worker infrastructure failures fall back to the main thread.
            if (!isWorkerInfraError(e)) throw e;
            console.warn("[pcrypto] crypto worker unavailable, decrypting on main thread:", e);
          }
        }

        // Main-thread fallback — persistent, membership-aware key cache
        // (matches original self.decrypt, pcrypto.js lines 529-556): on a
        // decrypt failure or missing key, evict the cached entry so the
        // next attempt recomputes fresh instead of failing forever on a
        // stale key.
        const { keys, k } = await aeskeysls(_time, _block, usersIds, v);
        const key = keys[userid];
        if (key) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await decrypt(key as any, encData);
          } catch (e) {
            await pcrypto.ls?.clear(`${lcachekey}${pcrypto.user?.userinfo?.id}-${k}`).catch(() => {});
            throw e;
          }
        }
        await pcrypto.ls?.clear(`${lcachekey}${pcrypto.user?.userinfo?.id}-${k}`).catch(() => {});
        throw new Error("emptykey");
      },

      // Internal encrypt — offloaded to Web Worker.
      async _encrypt(
        userid: string,
        text: string,
        v?: number
      ): Promise<{ encrypted: string; nonce: string }> {
        let _time = 0;
        let _block: number;
        const tetatet = pcrypto.getIsTetatetChat?.(chat) ?? false;
        if (!tetatet) {
          _block = 10;
        } else {
          _block = pcrypto.currentblock.height;
        }

        if (isCryptoWorkerSupported()) {
          const workerUsers = prepareWorkerUsers(null, v);
          const myId = pcrypto.user!.userinfo!.id;
          const privateKeys = getPrivateKeysHex();

          try {
            return await workerEncrypt({
              users: workerUsers,
              myId,
              privateKeys,
              targetUserId: userid,
              text,
              time: _time,
              block: _block,
            });
          } catch (e) {
            if (!isWorkerInfraError(e)) throw e;
            console.warn("[pcrypto] crypto worker unavailable, encrypting on main thread:", e);
          }
        }

        // Main-thread fallback — see _decrypt above and aeskeysls() for the
        // eviction rationale (matches original self.encrypt, pcrypto.js
        // lines 558-572).
        const { keys, k } = await aeskeysls(_time, _block, null, v);
        const key = keys[userid];
        if (key) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return encrypt(text, key as any);
        }
        await pcrypto.ls?.clear(`${lcachekey}${pcrypto.user?.userinfo?.id}-${k}`).catch(() => {});
        throw new Error("emptykey");
      },

      async encryptFile(file: Blob): Promise<{ file: File; secrets: Record<string, unknown> }> {
        const secret = await pcrypto.pcryptoFile.randomKey();
        const secrets = await room.encryptKey(secret);
        const encryptedFile = await pcrypto.pcryptoFile.encryptFile(file as File, secret);
        return { file: encryptedFile, secrets };
      },

      async decryptFile(file: Blob, secret: string, originalMime?: string): Promise<File> {
        // Worker-first: PBKDF2 + AES-CBC runs off the main thread so several
        // attachments can decrypt concurrently without freezing low-end
        // WebViews (WEE-92). The buffer is transferred (zero-copy); readFile
        // already produced a private copy, so detaching it is safe.
        if (isCryptoWorkerSupported()) {
          const buffer = await readFile(file);
          try {
            const decrypted = await workerDecryptFile(buffer, secret);
            return new File([decrypted], "decrypted", {
              type: resolveDecryptedMime(file.type, originalMime),
            });
          } catch (e) {
            // Infra failures (worker died / terminated mid-flight) fall back
            // to the main-thread path. Genuine decrypt failures (wrong key,
            // corrupt ciphertext) are deterministic — rethrow, a retry on the
            // main thread would fail identically.
            if (!isWorkerInfraError(e)) throw e;
            console.warn("[matrix-crypto] file-decrypt worker failed, falling back to main thread:", e);
          }
        }
        return pcrypto.pcryptoFile.decryptFile(file as File, secret, originalMime);
      },

      async encryptKey(key: string): Promise<{ block: number; keys: string; v: number }> {
        const _users = preparedUsers(0, version);
        const tetatet = pcrypto.getIsTetatetChat?.(chat) ?? false;
        let block = pcrypto.currentblock.height;
        if (!tetatet) block = 10;

        // Diagnostic only — does not change what gets sent. preparedUsers()
        // silently drops any member whose derived key set is short
        // (ui.keys.length < m, e.g. a truncated RPC response — see the
        // filterXSS fallback in entities/auth/model/stores.ts getUsersInfo),
        // and that member is then simply absent from `encrypted` below with
        // no exception raised. They receive the message but can never
        // decrypt it. Surfacing this in logs makes an otherwise-invisible
        // "why can't X read this chat" report traceable.
        const preparedIds = new Set(_users.map((u) => u.id));
        const excludedMemberIds = Object.keys(users).filter(
          (id) => id !== pcrypto.user?.userinfo?.id && !preparedIds.has(id),
        );
        if (excludedMemberIds.length > 0) {
          console.warn(
            "[pcrypto] encryptKey: excluding members with incomplete key sets — they will not be able to decrypt this message:",
            excludedMemberIds,
          );
        }

        const encrypted: Record<string, unknown> = {};
        for (let i = 0; i < _users.length; i++) {
          const user = _users[i];
          if (user.id != pcrypto.user?.userinfo?.id || _users.length <= 1) {
            encrypted[user.id] = await room._encrypt(user.id, key, version);
          }
        }

        return {
          block,
          keys: Base64.encode(JSON.stringify(encrypted)),
          v: version
        };
      },

      async decryptKey(event: Record<string, unknown>): Promise<string> {
        if (!pcrypto.user?.userinfo) throw new Error("userinfo");

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const content = event.content as any;
        const eventType = event.type as string | undefined;

        let secrets: string;
        let block: number;
        let v: number | undefined;

        // EXACT match of original lines 728-747: m.room.encryption carries the
        // fields at the top level; file events only under info/pbody.secrets.
        if (eventType === "m.room.encryption") {
          secrets = content.keys;
          block = content.block;
          v = content.version || 1;
        } else {
          secrets = content.info?.secrets?.keys || content.pbody?.secrets?.keys;
          block = content.info?.secrets?.block || content.pbody?.secrets?.block;
          v = content.info?.secrets?.version || content.info?.secrets?.v ||
            content.pbody?.secrets?.version || content.pbody?.secrets?.v || 1;
        }

        if (!secrets) throw new Error("secrets");
        if (!block) throw new Error("block");

        const sender = getmatrixid(event.sender as string);
        const me = pcrypto.user.userinfo.id;
        const body = JSON.parse(Base64.decode(secrets));
        const time = (event.origin_server_ts as number) || 1;

        // Build users list from body keys + sender (matches original lines 757-762)
        const bodyUsers = Object.keys(body);
        const usersList = [...new Set([...bodyUsers, sender])];

        // Check if prepared users (with valid 12+ keys) cover ALL body users + sender
        const preparedBefore = preparedUsers(0, v || version);
        const preparedIds = new Set(preparedBefore.map(u => u.id));
        const hasMissing = usersList.some(id => !preparedIds.has(id));
        if (hasMissing) {
          // First try normal re-prepare from room state events
          getusershistory();
          await getusersinfo();

          // If room state is still incomplete (e.g. member events not fully loaded),
          // directly populate users dict from the body keys + sender
          const preparedAfter = preparedUsers(0, v || version);
          const preparedAfterIds = new Set(preparedAfter.map(u => u.id));
          const stillMissing = usersList.some(id => !preparedAfterIds.has(id));
          if (stillMissing && pcrypto.getUsersInfoCb) {
            for (const uid of usersList) {
              if (!users[uid]) {
                users[uid] = { id: uid, life: [{ start: 1 }] };
              }
            }
            await getusersinfo();
          }
        }

        let keyindex: string | undefined;
        let bodyindex: string | undefined;

        if (sender == me) {
          for (const [i] of Object.entries(body)) {
            if (i != me) {
              keyindex = i;
              bodyindex = i;
              break;
            }
          }
        } else {
          bodyindex = me;
          keyindex = sender;
        }

        

        if (!bodyindex || !body[bodyindex]) {

          throw new Error("emptyforme");
        }

        // Always decrypt with the EXPLICIT usersList from the body keys + sender.
        // See decryptEvent above for the rationale; this is the bastyon-chat
        // parity fix that resolves AES-SIV ciphertext verification failures
        // after a web tab refresh.
        return room._decrypt(keyindex!, body[bodyindex], time, block, usersList, v);
      },

      clear() {
        users = {};
        usersinfo = {};
      },

      destroy() {
        room.clear();
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as PcryptoRoomInstance & { _decrypt: any; _encrypt: any };

    return room;
  }

  setBlock(block: { height: number }) {
    if (block.height > this.currentblock.height) {
      this.currentblock = block;
    }
  }

  destroy() {
    for (const room of Object.values(this.rooms)) {
      room.clear();
      room.destroy();
    }
    this.rooms = {};
    // The worker's derived-key cache belongs to this account — drop it with
    // the session (logout / account switch) instead of keeping it in memory.
    terminateCryptoWorker();
  }
}
