import { describe, it, expect, beforeEach } from "vitest";
import { perfMark, perfMeasure, perfCount, getPerfCounts, resetPerfCounts } from "./perf-markers";

describe("perf-markers", () => {
  beforeEach(() => {
    resetPerfCounts();
    performance.clearMarks();
    performance.clearMeasures();
  });

  it("perfMark creates a performance mark", () => {
    perfMark("test-start");
    const marks = performance.getEntriesByName("perf:test-start", "mark");
    expect(marks).toHaveLength(1);
  });

  it("perfMeasure creates a performance measure and returns duration", () => {
    perfMark("m-start");
    perfMark("m-end");
    const duration = perfMeasure("m", "m-start", "m-end");
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("perfMeasure returns 0 on error", () => {
    const duration = perfMeasure("bad", "nonexistent-start", "nonexistent-end");
    expect(duration).toBe(0);
  });

  it("perfCount increments a named counter", () => {
    perfCount("dexie-writes");
    perfCount("dexie-writes");
    perfCount("dexie-writes");
    expect(getPerfCounts().get("dexie-writes")).toBe(3);
  });

  it("resetPerfCounts clears all counters", () => {
    perfCount("foo");
    resetPerfCounts();
    expect(getPerfCounts().size).toBe(0);
  });
});
