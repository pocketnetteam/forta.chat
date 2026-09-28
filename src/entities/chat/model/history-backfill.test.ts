import { describe, it, expect, vi, afterEach } from "vitest";
import { createHistoryBackfill, type BackfillPass, type BackfillPage } from "./history-backfill";

/** A fake room: a stack of pages behind `token`, the last of which reaches stored history. */
function fakeRoom(pages: BackfillPage[], opts: { token?: string | null; failFirst?: number } = {}) {
  const saved: Array<string | null> = [];
  const ingested: string[][] = [];
  let failuresLeft = opts.failFirst ?? 0;
  let token = opts.token === undefined ? "t0" : opts.token;
  const pass = (): BackfillPass => ({
    token,
    fetchPage: async (from) => {
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error("network down");
      }
      const idx = from === "t0" ? 0 : Number(from.slice(1));
      return pages[idx];
    },
    ingestPage: async (chunk) => {
      ingested.push(chunk.map((e) => e.event_id as string));
      return chunk.some((e) => e.known === true);
    },
    saveToken: async (t) => {
      saved.push(t);
      token = t;
    },
  });
  return { pass, saved, ingested };
}

const ev = (id: string, known = false) => ({ event_id: id, known });

afterEach(() => { vi.useRealTimers(); });

describe("createHistoryBackfill", () => {
  it("pages back until a page reaches stored history, then clears the hole", async () => {
    const room = fakeRoom([
      { chunk: [ev("$3"), ev("$2")], end: "t1" },
      { chunk: [ev("$1"), ev("$0", true)], end: "t2" },
    ]);
    const bf = createHistoryBackfill({ canRun: () => true, startPass: async () => room.pass() });

    bf.enqueue("!a");
    await bf.whenIdle();

    expect(room.ingested).toEqual([["$3", "$2"], ["$1", "$0"]]);
    expect(room.saved).toEqual(["t1", null]);
  });

  it("clears the hole at the start of the room", async () => {
    const room = fakeRoom([{ chunk: [ev("$1")], end: null }]);
    const bf = createHistoryBackfill({ canRun: () => true, startPass: async () => room.pass() });
    bf.enqueue("!a");
    await bf.whenIdle();
    expect(room.saved).toEqual([null]);
  });

  it("does not page a room without a hole", async () => {
    const room = fakeRoom([], { token: null });
    const bf = createHistoryBackfill({ canRun: () => true, startPass: async () => room.pass() });
    bf.enqueue("!a");
    await bf.whenIdle();
    expect(room.ingested).toEqual([]);
  });

  it("keeps the token after an error and retries with backoff", async () => {
    vi.useFakeTimers();
    const room = fakeRoom([{ chunk: [ev("$0", true)], end: "t1" }], { failFirst: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bf = createHistoryBackfill({
      canRun: () => true,
      startPass: async () => room.pass(),
      baseDelayMs: 1_000,
      random: () => 1,
    });

    bf.enqueue("!a");
    await vi.advanceTimersByTimeAsync(0);
    expect(room.saved).toEqual([]); // nothing saved: the hole stays marked
    await vi.advanceTimersByTimeAsync(999);
    expect(room.ingested).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(room.saved).toEqual([null]);
    warn.mockRestore();
  });

  it("stops after the page limit and requeues the room behind others", async () => {
    const long = fakeRoom(Array.from({ length: 5 }, (_, i) => ({ chunk: [ev(`$l${i}`)], end: i < 4 ? `t${i + 1}` : null })));
    const other = fakeRoom([{ chunk: [ev("$o", true)], end: null }]);
    const order: string[] = [];
    const bf = createHistoryBackfill({
      canRun: () => true,
      maxPagesPerPass: 2,
      startPass: async (id) => { order.push(id); return id === "!long" ? long.pass() : other.pass(); },
    });

    bf.enqueue("!long");
    bf.enqueue("!other");
    await bf.whenIdle();

    expect(order.slice(0, 3)).toEqual(["!long", "!other", "!long"]);
    expect(long.saved).toEqual(["t1", "t2", "t3", "t4", null]); // resumed where the first pass stopped
  });

  it("puts the opened room first", async () => {
    const order: string[] = [];
    const bf = createHistoryBackfill({
      canRun: () => false,
      startPass: async (id) => { order.push(id); return fakeRoom([], { token: null }).pass(); },
    });
    bf.enqueue("!a");
    bf.enqueue("!b");
    bf.enqueue("!c", { front: true });
    expect(order).toEqual([]); // gated while the first sync runs

    let allowed = true;
    const bf2 = createHistoryBackfill({
      canRun: () => allowed,
      startPass: async (id) => { order.push(id); return fakeRoom([], { token: null }).pass(); },
    });
    allowed = false;
    bf2.enqueue("!a");
    bf2.enqueue("!b");
    bf2.enqueue("!c", { front: true });
    allowed = true;
    bf2.kick();
    await bf2.whenIdle();
    expect(order).toEqual(["!c", "!a", "!b"]);
    bf.stop();
  });
});

describe("createHistoryBackfill — giving up", () => {
  it("leaves a room alone after maxAttempts failed passes", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const startPass = vi.fn(async () => { throw new Error("403"); });
    const bf = createHistoryBackfill({ canRun: () => true, startPass, maxAttempts: 3, baseDelayMs: 10, random: () => 1 });

    bf.enqueue("!a");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(startPass).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("createHistoryBackfill — pass end", () => {
  it("reports a pass paused at the page limit as unfinished", async () => {
    const room = fakeRoom([
      { chunk: [ev("$2")], end: "t1" },
      { chunk: [ev("$1", true)], end: null },
    ]);
    const ends: boolean[] = [];
    const bf = createHistoryBackfill({
      canRun: () => true,
      maxPagesPerPass: 1,
      startPass: async () => room.pass(),
      onPassEnd: (_id, { finished }) => { ends.push(finished); },
    });
    bf.enqueue("!a");
    await bf.whenIdle();
    expect(ends).toEqual([false, true]);
  });
});

