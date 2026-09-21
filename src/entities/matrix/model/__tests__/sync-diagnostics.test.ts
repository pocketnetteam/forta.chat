import { describe, it, expect } from "vitest";
import { SyncDiagnosticsRecorder, describeSyncError } from "../sync-diagnostics";

const LIVE = { host: "matrix.test", hasSyncToken: true, chatsReady: true, roomCount: 3, online: true };

function makeRecorder() {
  let now = 1_000_000;
  const recorder = new SyncDiagnosticsRecorder(() => now);
  return { recorder, advance: (ms: number) => { now += ms; } };
}

describe("describeSyncError", () => {
  it("MatrixError-like: errcode + HTTP status + message", () => {
    expect(describeSyncError({ errcode: "M_UNKNOWN_TOKEN", httpStatus: 401, message: "Invalid token" }))
      .toBe("M_UNKNOWN_TOKEN HTTP 401 Invalid token");
  });

  it("ConnectionError-like: name + message + cause", () => {
    const err = Object.assign(new Error("fetch failed"), {
      name: "ConnectionError",
      cause: new TypeError("Failed to fetch"),
    });
    expect(describeSyncError(err)).toBe("ConnectionError fetch failed (cause: Failed to fetch)");
  });

  it("non-object / nullish values never throw", () => {
    expect(describeSyncError(undefined)).toBe("unknown");
    expect(describeSyncError(null)).toBe("unknown");
    expect(describeSyncError("boom")).toBe("boom");
    expect(describeSyncError(42)).toBe("42");
  });

  it("truncates very long messages", () => {
    expect(describeSyncError({ message: "x".repeat(5000) }).length).toBeLessThanOrEqual(300);
  });
});

describe("SyncDiagnosticsRecorder", () => {
  it("fresh snapshot: nothing recorded, live fields passed through", () => {
    const { recorder } = makeRecorder();
    const s = recorder.snapshot(LIVE);
    expect(s).toMatchObject({
      ...LIVE,
      lastState: null,
      lastHealthyAgeMs: null,
      healthyCount: 0,
      errorsSinceHealthy: 0,
      lastError: null,
      unexpectedErrorCount: 0,
      timelineEventCount: 0,
      lastTimelineEventAgeMs: null,
      listenerErrorCount: 0,
      hostSwitches: [],
    });
  });

  it("dead /sync: errors accumulate, last healthy age grows, last error kept", () => {
    const { recorder, advance } = makeRecorder();
    recorder.recordSyncState("PREPARED");
    advance(10_000);
    recorder.recordSyncState("ERROR", { name: "ConnectionError", message: "fetch failed" });
    advance(5_000);
    recorder.recordSyncState("RECONNECTING");
    advance(5_000);
    recorder.recordSyncState("ERROR", { errcode: "M_LIMIT_EXCEEDED", httpStatus: 429 });

    const s = recorder.snapshot(LIVE);
    expect(s.lastState).toBe("ERROR");
    expect(s.lastHealthyAgeMs).toBe(20_000);
    expect(s.healthyCount).toBe(1);
    expect(s.errorsSinceHealthy).toBe(2);
    expect(s.lastError).toBe("M_LIMIT_EXCEEDED HTTP 429");
    expect(s.lastErrorAgeMs).toBe(0);
  });

  it("healthy sync resets the error streak but keeps the last error for context", () => {
    const { recorder, advance } = makeRecorder();
    recorder.recordSyncState("ERROR", { message: "down" });
    advance(1_000);
    recorder.recordSyncState("SYNCING");

    const s = recorder.snapshot(LIVE);
    expect(s.errorsSinceHealthy).toBe(0);
    expect(s.lastHealthyAgeMs).toBe(0);
    expect(s.lastError).toBe("down");
  });

  it("records SDK-swallowed batch errors (SyncUnexpectedError)", () => {
    const { recorder, advance } = makeRecorder();
    recorder.recordUnexpectedError(new TypeError("Cannot read properties of undefined"));
    advance(2_000);
    recorder.recordUnexpectedError(new TypeError("second"));

    const s = recorder.snapshot(LIVE);
    expect(s.unexpectedErrorCount).toBe(2);
    expect(s.lastUnexpectedError).toBe("TypeError second");
    expect(s.lastUnexpectedErrorAgeMs).toBe(0);
  });

  it("counts live timeline events and listener errors", () => {
    const { recorder, advance } = makeRecorder();
    recorder.recordTimelineEvent();
    recorder.recordTimelineEvent();
    advance(7_000);
    recorder.recordListenerError("Room.timeline", new Error("boom"));

    const s = recorder.snapshot(LIVE);
    expect(s.timelineEventCount).toBe(2);
    expect(s.lastTimelineEventAgeMs).toBe(7_000);
    expect(s.listenerErrorCount).toBe(1);
    expect(s.lastListenerError).toBe("Room.timeline: Error boom");
  });

  it("keeps only the last 5 host switches with their ages", () => {
    const { recorder, advance } = makeRecorder();
    for (let i = 0; i < 7; i++) {
      recorder.recordHostSwitch(`h${i}`, `h${i + 1}`, "watchdog failover");
      advance(1_000);
    }
    const s = recorder.snapshot(LIVE);
    expect(s.hostSwitches).toHaveLength(5);
    expect(s.hostSwitches[0]).toEqual({ from: "h2", to: "h3", reason: "watchdog failover", ageMs: 5_000 });
    expect(s.hostSwitches[4].ageMs).toBe(1_000);
  });
});
