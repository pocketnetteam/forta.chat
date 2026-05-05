import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { waitForRoomInSdk } from "../matrix-room-sync";

describe("waitForRoomInSdk", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the room is already in the SDK", async () => {
    const room = { roomId: "!ready:s" };
    const getRoom = vi.fn().mockReturnValue(room);

    await expect(waitForRoomInSdk(getRoom, "!ready:s", 5000)).resolves.toBe(room);
    // The fast-path should not need polling.
    expect(getRoom).toHaveBeenCalledTimes(1);
  });

  it("resolves once the room appears mid-flight", async () => {
    let stored: unknown = null;
    const getRoom = vi.fn(() => stored);

    const promise = waitForRoomInSdk(getRoom, "!late:s", 5000, 50);
    // First check: not there yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(getRoom).toHaveBeenCalled();

    // Inject the room and let one polling tick fire.
    stored = { roomId: "!late:s" };
    await vi.advanceTimersByTimeAsync(50);

    await expect(promise).resolves.toEqual({ roomId: "!late:s" });
  });

  it("rejects with a descriptive error on timeout", async () => {
    const getRoom = vi.fn(() => null);
    const promise = waitForRoomInSdk(getRoom, "!nope:s", 200, 50);
    // Attach the rejection handler BEFORE advancing fake timers so the
    // rejection isn't briefly unhandled when the watchdog fires.
    const expectation = expect(promise).rejects.toThrow(/timeout.*!nope:s/i);
    await vi.advanceTimersByTimeAsync(250);
    await expectation;
  });

  it("clears interval after resolving (no leaks)", async () => {
    let stored: unknown = null;
    const getRoom = vi.fn(() => stored);

    const promise = waitForRoomInSdk(getRoom, "!x:s", 5000, 50);
    stored = { roomId: "!x:s" };
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    const callsAfterResolve = getRoom.mock.calls.length;
    // No further polling once resolved.
    await vi.advanceTimersByTimeAsync(500);
    expect(getRoom.mock.calls.length).toBe(callsAfterResolve);
  });

  it("clears interval after rejecting (no leaks)", async () => {
    const getRoom = vi.fn(() => null);
    const promise = waitForRoomInSdk(getRoom, "!x:s", 100, 50);
    const expectation = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(150);
    await expectation;

    const callsAfterReject = getRoom.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(getRoom.mock.calls.length).toBe(callsAfterReject);
  });
});
