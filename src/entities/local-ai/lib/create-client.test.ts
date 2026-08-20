import { describe, it, expect } from "vitest";
import { computeRuntimeThreads } from "./create-client";

// perf-tuning plan §3 (docs/plans/llama2/2026-08-20-local-ai-perf-tuning-plan.md):
// createLocalAiConfig() only reaches its `local-ai/adapters/capacitor` dynamic
// import on a real native build, so it isn't unit-testable directly here —
// computeRuntimeThreads() is the pure, testable piece that decides the
// runtimeTuning.threads value that gets passed through.
describe("computeRuntimeThreads()", () => {
  it("caps a high hardwareConcurrency at 4 (conservative bigLITTLE-safe ceiling)", () => {
    expect(computeRuntimeThreads(8)).toBe(4);
    expect(computeRuntimeThreads(16)).toBe(4);
  });

  it("passes a mid-range core count through unchanged", () => {
    expect(computeRuntimeThreads(3)).toBe(3);
    expect(computeRuntimeThreads(4)).toBe(4);
  });

  it("floors a low core count at 2", () => {
    expect(computeRuntimeThreads(1)).toBe(2);
  });

  it("falls back to the 4-capped default when hardwareConcurrency is 0, undefined, or NaN", () => {
    expect(computeRuntimeThreads(0)).toBe(4);
    expect(computeRuntimeThreads(undefined)).toBe(4);
    expect(computeRuntimeThreads(Number.NaN)).toBe(4);
  });

  it("never returns NaN or a non-positive number for any input", () => {
    for (const input of [0, -1, undefined, Number.NaN, 1, 2, 4, 8, 64]) {
      const result = computeRuntimeThreads(input);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(2);
    }
  });
});
