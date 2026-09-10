import { describe, it, expect } from "vitest";
import { plainDataEqual, reuseIfUnchanged } from "./message-memo";
import { MessageStatus, MessageType, type Message } from "@/entities/chat/model/types";

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: "$e1",
    _key: "c1",
    roomId: "!r:s",
    senderId: "peer",
    content: "hello",
    timestamp: 1000,
    status: MessageStatus.sent,
    type: MessageType.text,
    deleted: false,
    ...overrides,
  };
}

describe("plainDataEqual", () => {
  it("compares primitives and NaN", () => {
    expect(plainDataEqual(1, 1)).toBe(true);
    expect(plainDataEqual("a", "b")).toBe(false);
    expect(plainDataEqual(NaN, NaN)).toBe(true);
    expect(plainDataEqual(null, undefined)).toBe(false);
    expect(plainDataEqual(0, null)).toBe(false);
  });

  it("compares nested objects and arrays structurally", () => {
    expect(plainDataEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(plainDataEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(plainDataEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(plainDataEqual([], {})).toBe(false);
  });

  it("treats a missing key and an undefined-valued key as equal", () => {
    expect(plainDataEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(plainDataEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(plainDataEqual({ a: 1 }, { a: 1, b: 0 })).toBe(false);
  });

  it("matches non-plain objects only by reference", () => {
    const blobA = new Blob(["x"]);
    const blobB = new Blob(["y"]);
    expect(plainDataEqual({ f: blobA }, { f: blobA })).toBe(true);
    expect(plainDataEqual({ f: blobA }, { f: blobB })).toBe(false);
  });
});

describe("reuseIfUnchanged", () => {
  it("returns next when there is no previous object", () => {
    const next = msg();
    expect(reuseIfUnchanged(undefined, next)).toBe(next);
  });

  it("keeps the previous reference when nothing changed", () => {
    const prev = msg({ reactions: { "👍": { count: 1, users: ["a"] } } });
    const next = msg({ reactions: { "👍": { count: 1, users: ["a"] } } });
    expect(reuseIfUnchanged(prev, next)).toBe(prev);
  });

  // Regression: the old hand-written field list ignored content and
  // decryptionStatus, so a decrypted message stayed on screen as "[encrypted]".
  it("returns the new object when only content and decryptionStatus change (decrypt)", () => {
    const prev = msg({ content: "[encrypted]", decryptionStatus: "pending" });
    const next = msg({ content: "hello", decryptionStatus: undefined });
    expect(reuseIfUnchanged(prev, next)).toBe(next);
  });

  it("returns the new object on a second edit (edited flag already true)", () => {
    const prev = msg({ content: "v1", edited: true });
    const next = msg({ content: "v2", edited: true });
    expect(reuseIfUnchanged(prev, next)).toBe(next);
  });

  it("returns the new object when a reaction's user set changes with the same count", () => {
    const prev = msg({ reactions: { "👍": { count: 1, users: ["a"] } } });
    const next = msg({ reactions: { "👍": { count: 1, users: ["b"] } } });
    expect(reuseIfUnchanged(prev, next)).toBe(next);
  });

  it("returns the new object when fields outside the old list change (linkPreview, replyTo)", () => {
    const prev = msg();
    expect(reuseIfUnchanged(prev, msg({ linkPreview: { url: "https://x" } as Message["linkPreview"] }))).not.toBe(prev);
    expect(reuseIfUnchanged(prev, msg({ replyTo: { id: "$r", senderId: "a", content: "q" } as Message["replyTo"] }))).not.toBe(prev);
  });
});
