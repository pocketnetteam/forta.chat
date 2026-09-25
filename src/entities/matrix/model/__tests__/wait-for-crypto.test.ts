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

describe("waitForRoomCrypto — active registration via ensure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the room itself when nothing else is going to", async () => {
    // The regression this guards: polling alone can only observe a
    // registration someone else performs. When the Matrix SDK has not
    // materialized the room, no other caller is on the way, so every wait ran
    // its full budget and threw — the "encryption keys are still loading"
    // toast on a chat that never recovered.
    const room = makeRoom();
    const ensure = vi.fn(async () => room);

    const promise = waitForRoomCrypto("!cold:server", () => undefined, 5_000, ensure);
    await vi.advanceTimersByTimeAsync(200);

    await expect(promise).resolves.toBe(room);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("retries ensure so a room that only becomes creatable later still lands", async () => {
    // matrix-js-sdk materializes Room objects lazily: an ensure that finds
    // nothing at t=0 can succeed seconds later, so one attempt is not enough.
    const room = makeRoom();
    let sdkRoomArrived = false;
    const ensure = vi.fn(async () => (sdkRoomArrived ? room : undefined));

    const promise = waitForRoomCrypto("!late:server", () => undefined, 10_000, ensure);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(ensure).toHaveBeenCalledTimes(2);

    sdkRoomArrived = true;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toBe(room);
  });

  it("still honours the timeout when ensure hangs, and never re-enters it", async () => {
    // ensure can hit the network for peer keys. Awaiting it inline would let a
    // hung call outlive timeoutMs and hang the caller's spinner forever — the
    // exact failure the deadline exists to bound.
    const ensure = vi.fn(() => new Promise<PcryptoRoomInstance | undefined>(() => {}));

    const promise = waitForRoomCrypto("!hang:server", () => undefined, 3_000, ensure);
    const guarded = promise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(3_500);

    expect(await guarded).toBeInstanceOf(CryptoNotReadyError);
    // Serialized: the in-flight attempt is never raced by a second one.
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("swallows ensure failures and keeps polling", async () => {
    const room = makeRoom();
    const ensure = vi.fn(async () => { throw new Error("no sdk room"); });
    let current: PcryptoRoomInstance | undefined;

    const promise = waitForRoomCrypto("!flaky:server", () => current, 5_000, ensure);
    await vi.advanceTimersByTimeAsync(1_200);
    current = room;
    await vi.advanceTimersByTimeAsync(200);

    await expect(promise).resolves.toBe(room);
    expect(ensure.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not call ensure when the instance is already registered", async () => {
    const room = makeRoom();
    const ensure = vi.fn(async () => room);

    await expect(waitForRoomCrypto("!warm:server", () => room, 5_000, ensure)).resolves.toBe(room);
    expect(ensure).not.toHaveBeenCalled();
  });
});
