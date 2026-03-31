/**
 * Crypto Web Worker — handles all heavy E2EE computations off the main thread.
 *
 * Moved here: pbkdf2, secp256k1 point operations, BN arithmetic, AES-SIV decrypt/encrypt.
 * The main thread sends serialized crypto parameters; this worker returns results.
 *
 * No DOM, no Vue, no Matrix SDK — pure computation only.
 */

// MUST be first import — sets global/window/process before Node.js packages load.
// ES modules evaluate side-effect imports in declaration order.
import "./worker-polyfills";

import { ProjectivePoint } from "@noble/secp256k1";
import * as miscreant from "miscreant";
// @ts-expect-error — no types for pbkdf2
import pbkdf2 from "pbkdf2";
// @ts-expect-error — no types for bn.js default export
import BN from "bn.js";

// ---------------------------------------------------------------------------
// Constants (must match matrix-crypto.ts)
// ---------------------------------------------------------------------------

const salt = "PR7srzZt4EfcNb3s27grgmiG8aB9vYNV82";
const m = 12;
const secp256k1CurveN = new BN(
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
  16,
);

// ---------------------------------------------------------------------------
// Helpers — pure implementations without Node.js deps
// ---------------------------------------------------------------------------

// @ts-expect-error — no types for create-hash
import createHash from "create-hash";

function sha224(text: string): Uint8Array {
  return createHash("sha224").update(text).digest();
}

function hexFromBytes(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

function bytesFromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function pointMultiply(
  point: Uint8Array,
  scalar: Uint8Array,
): Uint8Array {
  const p = ProjectivePoint.fromHex(point);
  const s = BigInt("0x" + hexFromBytes(scalar));
  return p.multiply(s).toRawBytes(true);
}

function pointAdd(a: Uint8Array, b: Uint8Array): Uint8Array {
  const pa = ProjectivePoint.fromHex(a);
  const pb = ProjectivePoint.fromHex(b);
  return pa.add(pb).toRawBytes(true);
}

// ---------------------------------------------------------------------------
// Core crypto functions (ported from matrix-crypto.ts eaa object)
// ---------------------------------------------------------------------------

interface CryptoUser {
  id: string;
  keys: string[]; // hex public keys
}

function cuhash(users: CryptoUser[], num: number, block: number): Uint8Array {
  // block is always > 0 in normal flows (currentblock.height or 10 for groups).
  // Fallback must NOT use a hardcoded constant — the main-thread version uses
  // pcrypto.currentblock.height, but the worker has no access to it.
  // Since block is always provided by the caller and is never 0, just use it directly.
  const input =
    users.map((u) => u.keys[num]).join("") + block;
  return pbkdf2.pbkdf2Sync(
    hexFromBytes(sha224(input)),
    salt,
    1,
    32,
    "sha256",
  );
}

function doScalars(
  users: CryptoUser[],
  privateKeys: string[],
  block: number,
): Uint8Array {
  let sum: InstanceType<typeof BN> | null = null;

  for (let i = 0; i < m; i++) {
    const ch = new BN(cuhash(users, i, block));
    const a = new BN(privateKeys[i], 16);
    const mul = a.mul(ch).umod(secp256k1CurveN);

    if (!i) {
      sum = mul;
    } else {
      sum = sum!.add(mul).umod(secp256k1CurveN);
    }
  }

  return new Uint8Array(sum!.toArrayLike(Uint8Array, "be", 32));
}

function doPoints(
  users: CryptoUser[],
  pointsList: Uint8Array[],
  block: number,
): Uint8Array {
  let sum: Uint8Array | null = null;

  for (let i = 0; i < m; i++) {
    const ch = cuhash(users, i, block);
    const mul = pointMultiply(pointsList[i], ch);

    if (!i) {
      sum = mul;
    } else {
      sum = pointAdd(sum!, mul);
    }
  }

  return sum!;
}

function userspublics(
  users: CryptoUser[],
  myId: string,
  block: number,
): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = {};

  for (const user of users) {
    if (user.id === myId && users.length > 1) continue;

    const publics = user.keys.map((key) => bytesFromHex(key));
    result[user.id] = doPoints(users, publics, block);
  }

  return result;
}

function computeAesKeys(
  users: CryptoUser[],
  myId: string,
  privateKeys: string[],
  block: number,
): Record<string, Uint8Array> {
  const us = userspublics(users, myId, block);
  const c = doScalars(users, privateKeys, block);

  const result: Record<string, Uint8Array> = {};

  for (const [id, s] of Object.entries(us)) {
    if (id !== myId) {
      const shared = pointMultiply(s, c);
      const safeHex = hexFromBytes(shared);
      result[id] = pbkdf2.pbkdf2Sync(safeHex, salt, 64, 32, "sha512");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// AES-SIV helpers (ported from matrix-crypto.ts)
// ---------------------------------------------------------------------------

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

async function aesSivDecrypt(
  keyData: Uint8Array,
  encrypted: string,
  nonce: string,
): Promise<string> {
  const key = await miscreant.SIV.importKey(keyData, "AES-SIV");
  const enc = base64ToUint8(encrypted);
  const n = base64ToUint8(nonce);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plaintext = await key.open(enc, n as any);
  return new TextDecoder().decode(plaintext);
}

async function aesSivEncrypt(
  keyData: Uint8Array,
  text: string,
): Promise<{ encrypted: string; nonce: string }> {
  const key = await miscreant.SIV.importKey(keyData, "AES-SIV");
  const plaintext = new TextEncoder().encode(text);
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ciphertext = await key.seal(plaintext, nonce as any);
  return {
    encrypted: uint8ToBase64(new Uint8Array(ciphertext)),
    nonce: uint8ToBase64(nonce),
  };
}

// ---------------------------------------------------------------------------
// Key cache (same as matrix-crypto.ts but worker-local)
// ---------------------------------------------------------------------------

const keyCache = new Map<string, Record<string, Uint8Array>>();
const KEY_CACHE_MAX = 128;

function getCachedKeys(
  users: CryptoUser[],
  myId: string,
  privateKeys: string[],
  block: number,
): Record<string, Uint8Array> {
  const cacheKey = `${block}|${users.map((u) => u.id).join(",")}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const keys = computeAesKeys(users, myId, privateKeys, block);

  if (keyCache.size >= KEY_CACHE_MAX) {
    const firstKey = keyCache.keys().next().value;
    if (firstKey !== undefined) keyCache.delete(firstKey);
  }
  keyCache.set(cacheKey, keys);

  return keys;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

export interface DecryptRequest {
  id: number;
  type: "decrypt";
  users: CryptoUser[];
  myId: string;
  privateKeys: string[];
  targetUserId: string;
  encData: { encrypted: string; nonce: string };
  time: number;
  block: number;
}

export interface EncryptRequest {
  id: number;
  type: "encrypt";
  users: CryptoUser[];
  myId: string;
  privateKeys: string[];
  targetUserId: string;
  text: string;
  time: number;
  block: number;
}

export interface ComputeKeysRequest {
  id: number;
  type: "computeKeys";
  users: CryptoUser[];
  myId: string;
  privateKeys: string[];
  block: number;
}

export type WorkerRequest = DecryptRequest | EncryptRequest | ComputeKeysRequest;

export interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "decrypt": {
        const keys = getCachedKeys(msg.users, msg.myId, msg.privateKeys, msg.block);
        const key = keys[msg.targetUserId];
        if (!key) {
          (self as unknown as Worker).postMessage({
            id: msg.id,
            error: "emptykey",
          } satisfies WorkerResponse);
          return;
        }
        const result = await aesSivDecrypt(key, msg.encData.encrypted, msg.encData.nonce);
        (self as unknown as Worker).postMessage({
          id: msg.id,
          result,
        } satisfies WorkerResponse);
        break;
      }
      case "encrypt": {
        const keys = getCachedKeys(msg.users, msg.myId, msg.privateKeys, msg.block);
        const key = keys[msg.targetUserId];
        if (!key) {
          (self as unknown as Worker).postMessage({
            id: msg.id,
            error: "emptykey",
          } satisfies WorkerResponse);
          return;
        }
        const result = await aesSivEncrypt(key, msg.text);
        (self as unknown as Worker).postMessage({
          id: msg.id,
          result,
        } satisfies WorkerResponse);
        break;
      }
      case "computeKeys": {
        const keys = getCachedKeys(msg.users, msg.myId, msg.privateKeys, msg.block);
        // Convert Uint8Array values to hex for serialization
        const serialized: Record<string, string> = {};
        for (const [id, buf] of Object.entries(keys)) {
          serialized[id] = hexFromBytes(buf);
        }
        (self as unknown as Worker).postMessage({
          id: msg.id,
          result: serialized,
        } satisfies WorkerResponse);
        break;
      }
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
