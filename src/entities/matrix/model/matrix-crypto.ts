/**
 * Custom E2E encryption — DIRECT PORT from bastyon-chat/src/application/pcrypto.js
 *
 * Uses secp256k1 elliptic curves + AES-SIV (miscreant) for message encryption.
 * Uses AES-CBC with PBKDF2 for file encryption.
 */

import * as miscreant from "miscreant";
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

const salt = "PR7srzZt4EfcNb3s27grgmiG8aB9vYNV82";
const m = 12;

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

    // ---- getusersbytime — EXACT match of original lines 294-307 ----
    function getusersbytime(time: number): { id: string; life: { start: number; end?: number }[] }[] {
      const result: typeof users[string][] = [];
      for (const ui of Object.values(users)) {
        const l = ui.life.find(function (l) {
          if (!time) {
            if (l.start && !l.end) return true;
          } else {
            if (l.start < time && (!l.end || l.end > time)) return true;
          }
          return false;
        });
        if (l) result.push(ui);
      }
      return result;
    }

    // ---- getusersinfobytime — EXACT match of original lines 280-292 ----
    function getusersinfobytime(time: number): CryptoUserInfo[] {
      const us = getusersbytime(time);
      // _.map then _.filter(truthy) — map to usersinfo, filter out undefined
      return us.map(function (u) { return usersinfo[u.id]; }).filter(function (u) { return !!u; });
    }

    // Sort comparator matching lodash _.sortBy(arr, u => u.source.id):
    // null/undefined values go to the END (lodash behaviour), NOT to the beginning.
    function sortBySourceId(a: CryptoUserInfo, b: CryptoUserInfo): number {
      const aId = a.source?.id;
      const bId = b.source?.id;
      if (aId == null && bId == null) return 0;
      if (aId == null) return 1;   // null → end (matches lodash _.sortBy)
      if (bId == null) return -1;  // null → end (matches lodash _.sortBy)
      if (aId < bId) return -1;
      if (aId > bId) return 1;
      return 0;
    }

    // ---- preparedUsers — match of original lines 66-86 ----
    function preparedUsers(time: number, v?: number): CryptoUserInfo[] {
      const filtered = getusersinfobytime(time).filter(function (ui) {
        return ui.keys && ui.keys.length >= m;
      });
      if (v && v > 1) {
        // Must match lodash _.sortBy(r, u => u.source.id) — null/undefined goes LAST
        filtered.sort(sortBySourceId);
      }
      return filtered;
    }

    // ---- preparedUsersById — match of original lines 88-110 ----
    function preparedUsersById(ids: string[], v?: number): CryptoUserInfo[] {
      const ui: CryptoUserInfo[] = [];
      for (const u of Object.values(users)) {
        if (ids.indexOf(u.id) > -1) {
          const info = usersinfo[u.id];
          if (info && info.keys && info.keys.length >= m) {
            ui.push(info);
          }
        }
      }
      if (v && v > 1) {
        // Must match lodash _.sortBy(r, u => u.source.id) — null/undefined goes LAST
        ui.sort(sortBySourceId);
      }
      return ui;
    }

    // ---- getuserseventshistory — EXACT match of original lines 175-219 ----
    type HistoryEntry = { time: number; membership: string; id: string };

    function getuserseventshistory(): HistoryEntry[] {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chatAny = chat as any;
      const tetatet = pcrypto.getIsTetatetChat?.(chat) ?? false;

      // Collect all member state events (dedup by event_id)
      const oldState = (chatAny.oldState?.getStateEvents?.("m.room.member") ?? []) as unknown[];
      const curState = (chatAny.currentState?.getStateEvents?.("m.room.member") ?? []) as unknown[];

      const seen = new Set<string>();
      const allevents: unknown[] = [];
      for (const e of [...curState, ...oldState]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ev = (e as any)?.event;
        if (!ev) continue;
        if (seen.has(ev.event_id)) continue;
        seen.add(ev.event_id);
        allevents.push(e);
      }

      let history: HistoryEntry[] = [];

      for (const ue of allevents) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const event = (ue as any).event;
        const membership = event.content.membership as string;

        if (
          membership == "invite" ||
          membership == "join" ||
          (membership == "leave" && !tetatet)
        ) {
          history.push({
            time: event.origin_server_ts || 1,
            membership: membership,
            id:
              membership == "invite"
                ? getmatrixid(event.state_key)
                : getmatrixid(event.sender),
          });
        }
      }

      // Sort by time
      history = history.sort(function (a, b) { return a.time - b.time; });
      return history;
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
      const sorted = [...ids].sort(function (a, b) {
        return Number(a.replace(/[^0-9]/g, "")) - Number(b.replace(/[^0-9]/g, ""));
      });
      return md5(sorted.join(""));
    }

    // ---- getusershistory — EXACT match of original lines 244-278 ----
    function getusershistory() {
      const history = getuserseventshistory();
      const tetatet = pcrypto.getIsTetatetChat?.(chat) ?? false;

      // Build users dict — EXACT match of original lines 244-278
      users = {};

      for (const ui of history) {
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
      }

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
        console.warn("[pcrypto] getusersinfo timed out/failed:", e);
        return;
      }
      // Discard a stale response: a newer getusersinfo() call (e.g. a forced
      // retry started while this unforced one was still in flight) already
      // wrote more current data — applying this one now would clobber it.
      if (myGeneration !== usersinfoGeneration) return;
      usersinfo = {};
      for (const ui of _usersinfo) {
        usersinfo[ui.id] = ui;
      }
      // Notify that keys are loaded — triggers decryption retry
      pcrypto.onKeysLoaded?.(roomId);
    }

    // ---- eaa object — EXACT match of original lines 405-527 ----
    const eaa = {
      cuhash: function (users: CryptoUserInfo[], num: number, block: number): Buffer {
        const input = users.map(function (u) { return u.keys[num]; }).join("") + (block || pcrypto.currentblock.height);
        return pbkdf2.pbkdf2Sync(
          sha224(input).toString("hex"),
          salt,
          1,
          32,
          "sha256"
        );
      },

      userspublics: function (time: number, block: number, usersIds: string[] | null, v: number) {
        // Original line 423: use preparedUsersById when usersIds is provided
        const _users = usersIds ? preparedUsersById(usersIds, v) : preparedUsers(time, v);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sum: Record<string, any> = {};

        for (const user of _users) {
          // Original skips self in userspublics (line 430)
          if (user.id == pcrypto.user?.userinfo?.id && _users.length > 1) {
            continue;
          }

          const publics = user.keys.map(function (key) {
            return Buffer.from(key, "hex");
          });

          sum[user.id] = eaa.points(time, block, publics, usersIds, v);
        }

        return sum;
      },

      current: function (time: number, block: number, usersIds: string[] | null, v: number) {
        const privates = pcrypto.user!.private!.map(function (key) {
          return key.private;
        });

        const sc = eaa.scalars(time, block, privates, usersIds, v);
        // Original: Buffer.allocUnsafe(32) + sc.toBuffer().copy(buf, 32-len)
        // Equivalent: toArrayLike with zero-padding
        return Buffer.from(sc.toArrayLike(Uint8Array, "be", 32));
      },

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scalars: function (time: number, block: number, scalars: any[], usersIds: string[] | null, v: number) {
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
      points: function (time: number, block: number, points: any[], usersIds: string[] | null, v: number) {
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
      aeskeys: function (time: number, block: number, usersIds: string[] | null, v: number) {
        const us = eaa.userspublics(time, block, usersIds, v);
        const c = eaa.current(time, block, usersIds, v);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const su: Record<string, any> = {};

        for (const [id, s] of Object.entries(us)) {
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
        }

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

      const k = `${usersIds ? "ul+" + orderedIdsHash(usersIds) : period(_time)}-${_block}-${v || version}`;
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
            const keys = eaa.aeskeys(_time, _block, usersIds, v as number);
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
    function prepareWorkerUsers(usersIds: string[] | null, v: number): Array<{ id: string; keys: string[] }> {
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
    function usershash(): string {
      const _users = preparedUsers(0, version);
      return md5(
        _users
          .map(function (user) { return user.id; })
          .filter(function (uid) { return uid && uid != pcrypto.user?.userinfo?.id; })
          .join("") + "_v13_" + version
      );
    }

    // ---- Group chat helpers (common key system) ----

    /** Find the common key state event for a user+hash */
    function getCommonKeyEvent(userid?: string, _hash?: string): unknown | undefined {
      const hash = _hash || usershash();
      const uid = userid || pcrypto.user?.userinfo?.id;
      if (!uid) return undefined;

      const state_key = "pcrypto." + uid + "." + hash;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chatAny = chat as any;
      const events = chatAny.currentState?.getStateEvents?.("m.room.encryption") ?? [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found = (events as any[]).find((e: any) => {
        return e?.event?.state_key === state_key;
      });

      return found;
    }

    /** Get common key event, trying multiple senders */
    function getCommonKey(sender: string, hash: string): Record<string, unknown> | undefined {
      // Try the message sender first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let evt = getCommonKeyEvent(sender, hash) as any;
      if (evt) return evt.event;

      // Try self
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      evt = getCommonKeyEvent(undefined, hash) as any;
      if (evt) return evt.event;

      // Try all known users
      for (const uid of Object.keys(users)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        evt = getCommonKeyEvent(uid, hash) as any;
        if (evt) return evt.event;
      }

      return undefined;
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


        // Always decrypt with the EXPLICIT usersList from the body keys + sender.
        // This is the canonical user set the sender encrypted to — using anything
        // else (e.g. preparedUsers(time, v) via null) yields a different ECDH
        // cuhash and an AES-SIV MAC failure when web's lazy-loaded m.room.member
        // events haven't fully synced. Matches bastyon-chat/src/application/pcrypto.js.
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

        // Find the common key state event.
        // If not found, re-prepare room state (member events may not have been
        // loaded yet due to lazyLoadMembers / initialSyncLimit).
        let commonKeyEvt = getCommonKey(sender, hash);
        if (!commonKeyEvt) {
          getusershistory();
          await getusersinfo();
          commonKeyEvt = getCommonKey(sender, hash);
        }
        if (!commonKeyEvt) {
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
          throw new Error("No common key event found for hash=" + hash);
        }
        // Decrypt the common key (AES-SIV per-user encrypted key)
        let commonKey: string;
        commonKey = await room.decryptKey(commonKeyEvt);

        // Decrypt message body (hex-encoded AES-CBC ciphertext)
        const bodyHex = content.body as string;
        const bodyBytes = Buffer.from(bodyHex, "hex");
        const decryptedBuffer = await pcrypto.pcryptoFile.decrypt(bodyBytes.buffer, commonKey);

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

      // ---- getOrCreateCommonKey — find or create group common key ----
      async getOrCreateCommonKey(): Promise<{ key: string; hash: string; block: number }> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ce = getCommonKeyEvent() as any;

        if (ce) {
          const evt = ce.event;
          const key = await room.decryptKey(evt);
          return {
            key,
            hash: evt.content.hash as string,
            block: evt.content.block as number,
          };
        }

        // Need to create a new common key
        return room.sendCommonKey();
      },

      // ---- sendCommonKey — create and send a new common key as state event ----
      async sendCommonKey(): Promise<{ key: string; hash: string; block: number }> {
        const hash = usershash();
        const secret = await pcrypto.pcryptoFile.randomKey();
        const encrypted = await room.encryptKey(secret);

        // Send as state event (requires matrix client access)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chatAny = chat as any;
        const matrixClient = chatAny.client;
        if (!matrixClient?.sendStateEvent) {
          throw new Error("Cannot send state event: no matrix client access");
        }

        const stateContent = {
          hash,
          keys: encrypted.keys,
          block: encrypted.block,
          version: version,
        };

        const stateKey = "pcrypto." + pcrypto.user!.userinfo!.id + "." + hash;
        await matrixClient.sendStateEvent(roomId, "m.room.encryption", stateContent, stateKey);

        return {
          key: secret,
          hash,
          block: encrypted.block,
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
          // Prepare serializable data for Worker (fast — no crypto, just array ops)
          const workerUsers = prepareWorkerUsers(usersIds, v || version);
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
        const { keys, k } = await aeskeysls(_time, _block, usersIds, v || version);
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
          const workerUsers = prepareWorkerUsers(null, v || version);
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
        const { keys, k } = await aeskeysls(_time, _block, null, v || version);
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

        // Match original: different extraction for m.room.encryption vs file events
        if (eventType === "m.room.encryption") {
          secrets = content.keys;
          block = content.block;
          v = content.version || 1;
        } else {
          secrets = content.keys ?? content.info?.secrets?.keys ?? content.pbody?.secrets?.keys;
          block = content.block ?? content.info?.secrets?.block ?? content.pbody?.secrets?.block;
          v = content.version ?? content.info?.secrets?.v ?? content.pbody?.secrets?.v ?? 1;
        }

        if (!secrets || !block) {
          throw new Error("Missing secrets or block");
        }

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
  }
}
