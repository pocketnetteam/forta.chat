import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WriteBuffer, type BufferedWrite, type WriteBufferOptions } from "./write-buffer";

function makeItem(roomId = "!room:server", eventId = "evt1"): BufferedWrite {
  return {
    roomId,
    localMsg: {
      eventId,
      clientId: `srv_${eventId}`,
      roomId,
      senderId: "@alice:server",
      content: "hello",
      timestamp: Date.now(),
      type: "text" as any,
      status: "synced",
      version: 1,
      softDeleted: false,
      serverTs: Date.now(),
    } as any,
    parsed: {
      eventId,
      roomId,
      senderId: "@alice:server",
      content: "hello",
      timestamp: Date.now(),
      type: "text" as any,
    } as any,
  };
}

describe("WriteBuffer", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onFlush: any;

  beforeEach(() => {
    vi.useFakeTimers();
    onFlush = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches multiple enqueues into single flush after delay", async () => {
    const buf = new WriteBuffer(onFlush, { delayMs: 150 });

    buf.enqueue(makeItem("!r1", "e1"));
    buf.enqueue(makeItem("!r2", "e2"));
    buf.enqueue(makeItem("!r1", "e3"));

    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ roomId: "!r1" }),
        expect.objectContaining({ roomId: "!r2" }),
      ]),
    );
    expect(onFlush.mock.calls[0][0]).toHaveLength(3);

    buf.dispose();
  });

  it("flushes immediately when maxSize reached", async () => {
    const buf = new WriteBuffer(onFlush, { delayMs: 5000, maxSize: 3 });

    buf.enqueue(makeItem("!r1", "e1"));
    buf.enqueue(makeItem("!r1", "e2"));

    expect(onFlush).not.toHaveBeenCalled();

    buf.enqueue(makeItem("!r1", "e3")); // hits maxSize

    // flush is async — let microtasks run
    await vi.advanceTimersByTimeAsync(0);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toHaveLength(3);

    buf.dispose();
  });

  it("flushNow() drains buffer without waiting", async () => {
    const buf = new WriteBuffer(onFlush, { delayMs: 10_000 });

    buf.enqueue(makeItem("!r1", "e1"));
    buf.enqueue(makeItem("!r2", "e2"));

    await buf.flushNow();

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toHaveLength(2);

    // Advancing timers should NOT cause a second flush
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFlush).toHaveBeenCalledTimes(1);

    buf.dispose();
  });

  it("does not call flush when buffer is empty", async () => {
    const buf = new WriteBuffer(onFlush, { delayMs: 100 });

    await buf.flushNow();
    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(onFlush).not.toHaveBeenCalled();

    buf.dispose();
  });

  it("handles flush errors without crashing", async () => {
    const errorFlush = vi.fn().mockRejectedValue(new Error("DB error"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const buf = new WriteBuffer(errorFlush, { delayMs: 100 });

    buf.enqueue(makeItem("!r1", "e1"));
    buf.enqueue(makeItem("!r1", "e2"));

    await vi.advanceTimersByTimeAsync(100);

    expect(errorFlush).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalled();

    // Buffer should be drained even on error (items not re-queued silently)
    // Enqueue more — should work fine
    buf.enqueue(makeItem("!r1", "e3"));
    await vi.advanceTimersByTimeAsync(100);
    expect(errorFlush).toHaveBeenCalledTimes(2);

    consoleSpy.mockRestore();
    buf.dispose();
  });

  it("dispose() flushes remaining items and stops timers", async () => {
    const buf = new WriteBuffer(onFlush, { delayMs: 200 });

    buf.enqueue(makeItem("!r1", "e1"));
    await buf.dispose();

    // Remaining item was flushed
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toHaveLength(1);

    // No additional flushes after dispose
    await vi.advanceTimersByTimeAsync(500);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});

describe("WriteBuffer.hasPending", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sees a buffered item of the room", () => {
    const buf = new WriteBuffer<BufferedWrite>(async () => {});
    buf.enqueue(makeItem("!a:s"));
    expect(buf.hasPending((i) => i.roomId === "!a:s")).toBe(true);
    expect(buf.hasPending((i) => i.roomId === "!b:s")).toBe(false);
  });

  it("still sees an item whose flush is committing, until the commit ends", async () => {
    let finish!: () => void;
    const buf = new WriteBuffer<BufferedWrite>(() => new Promise<void>((r) => { finish = r; }), { delayMs: 150 });
    buf.enqueue(makeItem("!a:s"));
    await vi.advanceTimersByTimeAsync(150); // timer moved the item into the in-flight flush

    expect(buf.hasPending((i) => i.roomId === "!a:s")).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(buf.hasPending((i) => i.roomId === "!a:s")).toBe(false);
  });
});

