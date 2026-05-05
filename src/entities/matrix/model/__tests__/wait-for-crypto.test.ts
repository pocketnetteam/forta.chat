import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitForRoomCrypto } from "../wait-for-crypto";
import { CryptoNotReadyError } from "@/shared/lib/network/typed-network-errors";
import type { PcryptoRoomInstance } from "../matrix-crypto";

function makeRoom(): PcryptoRoomInstance {
  // Only the identity matters for these tests — PcryptoRoomInstance is large
  // and we never actually call its methods here.
  return {} as PcryptoRoomInstance;
}

describe("waitForRoomCrypto", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the room synchronously when it is already available", async () => {
    const room = makeRoom();
    const promise = waitForRoomCrypto("!room:server", () => room, 5000);
    await expect(promise).resolves.toBe(room);
  });

  it("returns the room as soon as it becomes available during polling", async () => {
    const room = makeRoom();
    let current: PcryptoRoomInstance | undefined;
    const promise = waitForRoomCrypto("!room:server", () => current, 5000);

    // Drive the polling loop for ~250ms before the room "appears".
    await vi.advanceTimersByTimeAsync(250);
    current = room;
    await vi.advanceTimersByTimeAsync(150);

    await expect(promise).resolves.toBe(room);
  });

  it("throws CryptoNotReadyError with the roomId when the timeout elapses", async () => {
    const promise = waitForRoomCrypto("!stuck:server", () => undefined, 500);
    // Surface the rejection without unhandled-rejection noise.
    const guarded = promise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(600);
    const err = await guarded;
    expect(err).toBeInstanceOf(CryptoNotReadyError);
    expect((err as CryptoNotReadyError).roomId).toBe("!stuck:server");
  });

  it("uses the default 5s timeout when none is supplied", async () => {
    const promise = waitForRoomCrypto("!default:server", () => undefined);
    const guarded = promise.catch((e) => e);
    // 4.9s — should still be polling.
    await vi.advanceTimersByTimeAsync(4_900);
    let settled = false;
    void guarded.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    // Past 5s — should have rejected.
    await vi.advanceTimersByTimeAsync(200);
    const err = await guarded;
    expect(err).toBeInstanceOf(CryptoNotReadyError);
  });
});
