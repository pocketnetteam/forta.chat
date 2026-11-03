import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WriteBuffer, WRITE_BUFFER_MAX_RETRIES, type BufferedWrite, type WriteBufferOptions } from "./write-buffer";

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

  // Audit S3-01: a failed batch used to be dropped at once, losing the
  // incoming messages it held. It is now retried, in order, then dropped.
  it("retries a failed batch in order, then succeeds", async () => {
    const flushed: string[][] = [];
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error("DB busy"))
      .mockImplementation(async (items: BufferedWrite[]) => {
        flushed.push(items.map((i) => i.localMsg.eventId as string));
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const buf = new WriteBuffer(flaky, { delayMs: 100 });
    buf.enqueue(makeItem("!r1", "e1"));
    buf.enqueue(makeItem("!r1", "e2"));
    await vi.advanceTimersByTimeAsync(100);
    expect(flaky).toHaveBeenCalledTimes(1);

    buf.enqueue(makeItem("!r1", "e3"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(flushed).toEqual([["e1", "e2", "e3"]]);
    warn.mockRestore();
    await buf.dispose();
  });

  // Batch-6 review: a batch taken while an older one was still failing used to
  // land in Dexie before the older one's retry.
  it("does not let a newer batch land before an older one that failed", async () => {
    const written: string[] = [];
    let failFirst!: (e: Error) => void;
    const onFlushSpy = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { failFirst = reject; }))
      .mockImplementation(async (items: BufferedWrite[]) => {
        for (const i of items) written.push(i.localMsg.eventId as string);
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const buf = new WriteBuffer(onFlushSpy, { delayMs: 100, maxSize: 2 });
    buf.enqueue(makeItem("!r1", "old1"));
    buf.enqueue(makeItem("!r1", "old2")); // maxSize: flush #1 starts, stays pending
    buf.enqueue(makeItem("!r1", "new1"));
    buf.enqueue(makeItem("!r1", "new2")); // maxSize: flush #2 chained behind #1
    await vi.advanceTimersByTimeAsync(0); // flush #1 reaches onFlush
    failFirst(new Error("DB busy"));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(written).toEqual(["old1", "old2", "new1", "new2"]);
    warn.mockRestore();
    await buf.dispose();
  });

  it("drops a batch that keeps failing, without crashing", async () => {
    const errorFlush = vi.fn().mockRejectedValue(new Error("DB error"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const buf = new WriteBuffer(errorFlush, { delayMs: 100 });
    buf.enqueue(makeItem("!r1", "e1"));
    await vi.advanceTimersByTimeAsync(60_000);

    // First try + WRITE_BUFFER_MAX_RETRIES retries, then dropped.
    expect(errorFlush).toHaveBeenCalledTimes(1 + WRITE_BUFFER_MAX_RETRIES);
    expect(consoleSpy).toHaveBeenCalled();

    // The buffer still works afterwards.
    buf.enqueue(makeItem("!r1", "e2"));
    await vi.advanceTimersByTimeAsync(100);
    expect(errorFlush).toHaveBeenCalledTimes(2 + WRITE_BUFFER_MAX_RETRIES);

    warn.mockRestore();
    consoleSpy.mockRestore();
    await buf.dispose();
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

  // Merge of the audit retry with the in-flight set: a batch that went back
  // into the buffer behind a failed one stayed in the set after its retry
  // committed, so the room looked pending for the rest of the session.
  it("forgets a batch that was requeued behind a failed one once the retry commits", async () => {
    let failFirst!: (e: Error) => void;
    const onFlushSpy = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { failFirst = reject; }))
      .mockImplementation(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const buf = new WriteBuffer<BufferedWrite>(onFlushSpy, { delayMs: 100, maxSize: 1 });

    buf.enqueue(makeItem("!old:s", "old")); // flush #1 starts and stays pending
    buf.enqueue(makeItem("!new:s", "new")); // flush #2 chained behind #1
    await vi.advanceTimersByTimeAsync(0);
    failFirst(new Error("DB busy"));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onFlushSpy).toHaveBeenCalledTimes(2);
    expect(buf.hasPending((i) => i.roomId === "!new:s")).toBe(false);
    expect(buf.hasPending((i) => i.roomId === "!old:s")).toBe(false);
    warn.mockRestore();
    await buf.dispose();
  });
});

