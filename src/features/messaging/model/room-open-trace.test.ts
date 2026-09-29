import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { perfCount, resetPerfCounts } from "@/shared/lib/perf-markers";
import { createRoomOpenTrace, ROOM_OPEN_TAIL_MS } from "./room-open-trace";

describe("createRoomOpenTrace", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    resetPerfCounts();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("logs one summary line with the steps and the writes made during the open", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    perfCount("dexie:rw:open"); // leftover from a previous open — not counted

    const trace = createRoomOpenTrace("!room123456789:server");
    trace.mark("peek", 1);
    trace.mark("branch", "cached");
    perfCount("dexie:rw:open");
    perfCount("dexie:rw:open");
    trace.settle();

    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[room-open\] !room1234567 /);
    expect(line).toMatch(/peek=1@\d+ branch=cached@\d+ settled@\d+/);
    expect(line).toMatch(/dexie:rw:open=2 net:scrollback=0 net:event=0$/);
  });

  it("reports the background work done after the reveal in a tail line", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const trace = createRoomOpenTrace("!r:s");
    trace.settle();
    perfCount("net:scrollback"); // prefetch after the reveal
    perfCount("dexie:rw:open");
    vi.advanceTimersByTime(ROOM_OPEN_TAIL_MS);

    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1][0]).toMatch(/tail\+5s dexie:rw:open=1 net:scrollback=1 net:event=0$/);
  });

  it("settles once and ignores marks after settling", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const trace = createRoomOpenTrace("!r:s");
    trace.settle();
    trace.mark("late");
    trace.settle();
    vi.advanceTimersByTime(ROOM_OPEN_TAIL_MS);
    expect(info).toHaveBeenCalledTimes(2); // summary + tail, once
    expect(info.mock.calls[0][0]).not.toMatch(/late/);
  });
});
