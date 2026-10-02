// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  shouldPromptForFeedback,
  getLastFeedbackPromptAt,
  markFeedbackPromptShown,
  buildFeedbackDescription,
  FEEDBACK_COOLDOWN_MS,
  FEEDBACK_LAST_PROMPT_LS_KEY,
  SUSPICIOUS_CALL_DURATION_S,
} from "./call-feedback";
import { APP_NAME } from "@/shared/config";

const NOW = 1_700_000_000_000;
const storageKey = `${APP_NAME}:${FEEDBACK_LAST_PROMPT_LS_KEY}`;

describe("shouldPromptForFeedback", () => {
  it("asks about a failed call even right after a previous prompt", () => {
    expect(
      shouldPromptForFeedback({
        status: "failed",
        durationS: 0,
        lastPromptAtMs: NOW - 1000,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("asks about a suspiciously short call that did connect", () => {
    expect(
      shouldPromptForFeedback({
        status: "answered",
        durationS: SUSPICIOUS_CALL_DURATION_S - 1,
        lastPromptAtMs: NOW - 1000,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("stays quiet after an ordinary call inside the cooldown", () => {
    expect(
      shouldPromptForFeedback({
        status: "answered",
        durationS: 120,
        lastPromptAtMs: NOW - FEEDBACK_COOLDOWN_MS + 1000,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("asks again once the cooldown has elapsed", () => {
    expect(
      shouldPromptForFeedback({
        status: "answered",
        durationS: 120,
        lastPromptAtMs: NOW - FEEDBACK_COOLDOWN_MS,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("asks on the first ordinary call ever", () => {
    expect(
      shouldPromptForFeedback({
        status: "answered",
        durationS: 300,
        lastPromptAtMs: null,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it.each(["missed", "declined"] as const)(
    "never asks about a %s call",
    (status) => {
      // Nothing to rate, and asking reads as blaming the user for not answering.
      expect(
        shouldPromptForFeedback({
          status,
          durationS: 0,
          lastPromptAtMs: null,
          nowMs: NOW,
        }),
      ).toBe(false);
    },
  );
});

describe("feedback prompt bookkeeping", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips the last prompt time", () => {
    markFeedbackPromptShown(NOW);

    expect(getLastFeedbackPromptAt()).toBe(NOW);
  });

  it("treats a missing value as never prompted", () => {
    expect(getLastFeedbackPromptAt()).toBeNull();
  });

  it("treats a corrupt value as never prompted", () => {
    window.localStorage.setItem(storageKey, JSON.stringify("yesterday"));

    expect(getLastFeedbackPromptAt()).toBeNull();
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    expect(() => markFeedbackPromptShown(NOW)).not.toThrow();
  });
});

describe("buildFeedbackDescription", () => {
  it("carries a machine-readable tail triage can group on", () => {
    const text = buildFeedbackDescription("peer_not_heard", 7.4, "Я не слышал собеседника");

    expect(text).toContain("Я не слышал собеседника");
    expect(text).toContain("call feedback: peer_not_heard");
    expect(text).toContain("duration 7s");
  });
});
