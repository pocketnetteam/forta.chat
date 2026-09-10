import type { Message } from "@/entities/chat/model/types";

function isPlainContainer(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === Array.prototype || proto === null;
}

/**
 * Structural equality for plain data (Dexie rows are structured clones:
 * objects, arrays, primitives). Non-plain objects (Blob, Date, class
 * instances) only match by reference — `Object.keys(blob)` is empty, so a
 * key-wise compare would wrongly call two different blobs equal.
 * A missing key and a key holding `undefined` are treated as equal.
 */
export function plainDataEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (!isPlainContainer(a) || !isPlainContainer(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrB = b as unknown[];
    if (a.length !== arrB.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!plainDataEqual(a[i], arrB[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  for (const k of Object.keys(objA)) {
    if (!plainDataEqual(objA[k], objB[k])) return false;
  }
  for (const k of Object.keys(objB)) {
    if (!(k in objA) && objB[k] !== undefined) return false;
  }
  return true;
}

/**
 * Keep the previous Message object when the freshly mapped one is
 * structurally identical, so unchanged bubbles keep referential identity
 * and don't re-render. Comparing the whole mapped object (rather than a
 * hand-picked field list) means a field added to the mapper can never be
 * silently ignored — the old field list missed `content` and
 * `decryptionStatus`, so a successful decrypt never reached the screen.
 */
export function reuseIfUnchanged(prev: Message | undefined, next: Message): Message {
  return prev && plainDataEqual(prev, next) ? prev : next;
}
