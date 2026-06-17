import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { usePreviewTimeout } from "./use-preview-timeout";

describe("usePreviewTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("marks room timed-out after the timeout elapses", () => {
    const { noteResolving, isTimedOut } = usePreviewTimeout(10_000);

    noteResolving("!room1");
    expect(isTimedOut("!room1")).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(isTimedOut("!room1")).toBe(true);
  });

  test("noteResolving is idempotent — repeated calls don't restart the timer", () => {
    const { noteResolving, isTimedOut } = usePreviewTimeout(10_000);

    noteResolving("!room1");
    vi.advanceTimersByTime(9_000);
    noteResolving("!room1"); // re-render mid-countdown must not reset it
    vi.advanceTimersByTime(1_000);
    expect(isTimedOut("!room1")).toBe(true);
  });

  test("WEE-96 A4: success before timeout cancels the timer — no late re-render", () => {
    const { noteResolving, noteReady, isTimedOut } = usePreviewTimeout(10_000);

    noteResolving("!room1");
    vi.advanceTimersByTime(5_000);
    noteReady("!room1"); // preview decrypted at T+5s

    vi.advanceTimersByTime(60_000);
    // Without the cancel, the timer fired at T+10s and mutated the reactive
    // set → a second row re-render with no visible change.
    expect(isTimedOut("!room1")).toBe(false);
  });

  test("a room that timed out stays timed-out after late success (no skeleton re-phase)", () => {
    const { noteResolving, noteReady, isTimedOut } = usePreviewTimeout(10_000);

    noteResolving("!room1");
    vi.advanceTimersByTime(10_000);
    expect(isTimedOut("!room1")).toBe(true);

    noteReady("!room1"); // late decrypt at T+15s
    expect(isTimedOut("!room1")).toBe(true);

    // A subsequent encrypted preview shows the label immediately instead of
    // re-entering the skeleton phase.
    noteResolving("!room1");
    expect(isTimedOut("!room1")).toBe(true);
  });

  test("tracks rooms independently", () => {
    const { noteResolving, noteReady, isTimedOut } = usePreviewTimeout(10_000);

    noteResolving("!a");
    noteResolving("!b");
    noteReady("!a");
    vi.advanceTimersByTime(10_000);

    expect(isTimedOut("!a")).toBe(false);
    expect(isTimedOut("!b")).toBe(true);
  });

  test("dispose clears all pending timers", () => {
    const { noteResolving, isTimedOut, dispose } = usePreviewTimeout(10_000);

    noteResolving("!room1");
    dispose();
    vi.advanceTimersByTime(60_000);
    expect(isTimedOut("!room1")).toBe(false);
  });

  test("noteReady on unknown room is a no-op", () => {
    const { noteReady, isTimedOut } = usePreviewTimeout(10_000);
    noteReady("!never-seen");
    expect(isTimedOut("!never-seen")).toBe(false);
  });
});
