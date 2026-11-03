import { describe, it, expect, vi } from "vitest";
import { ANSWER_REMINDER_DELAY_MS, createAnswerReminder } from "./answer-reminder";

const deps = (visible: boolean) => ({
  schedule: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  isPageVisible: vi.fn(() => visible),
  text: (callerName: string) => ({ title: callerName, body: "Open Forta to answer" }),
});

describe("createAnswerReminder", () => {
  // iPhone XR 2026-10-17: Accept on CallKit with Forta in the background — the answer
  // asked for the microphone, WebKit never started the capture off screen, and the
  // call silently did not connect. The user has to open Forta; tell them to.
  it("schedules the reminder for an answer taken while Forta is off screen", async () => {
    const d = deps(false);
    const reminder = createAnswerReminder(d);

    reminder.answered("Alice");
    await new Promise((r) => setTimeout(r, 0));

    expect(d.schedule).toHaveBeenCalledWith({ delayMs: ANSWER_REMINDER_DELAY_MS, title: "Alice", body: "Open Forta to answer" });
  });

  it("does nothing for an answer taken in the open app", () => {
    const d = deps(true);
    const reminder = createAnswerReminder(d);

    reminder.answered("Alice");
    reminder.settle();

    expect(d.schedule).not.toHaveBeenCalled();
    expect(d.cancel).not.toHaveBeenCalled();
  });

  it("withdraws the reminder once the call connects, ends or Forta is opened, and only once", async () => {
    const d = deps(false);
    const reminder = createAnswerReminder(d);

    reminder.answered("Alice");
    reminder.settle();
    reminder.settle();
    await new Promise((r) => setTimeout(r, 0));

    expect(d.cancel).toHaveBeenCalledOnce();
  });

  it("withdraws after the schedule even when the call connects at once", async () => {
    const order: string[] = [];
    const d = {
      ...deps(false),
      text: async (name: string) => ({ title: name, body: "b" }),
      schedule: vi.fn(async () => { order.push("schedule"); }),
      cancel: vi.fn(async () => { order.push("cancel"); }),
    };
    const reminder = createAnswerReminder(d);

    reminder.answered("Alice");
    reminder.settle();
    await new Promise((r) => setTimeout(r, 0));

    expect(order).toEqual(["schedule", "cancel"]);
  });

  // iPhone XR 2026-10-19: CallKit full screen hid Forta at the Accept, Forta came back on
  // screen a moment later, and the reminder still fired: the visibility event never came.
  it("withdraws the reminder when Forta is back on screen without a visibility event", async () => {
    vi.useFakeTimers();
    try {
      let visible = false;
      const d = { ...deps(false), isPageVisible: vi.fn(() => visible) };
      const reminder = createAnswerReminder(d);

      reminder.answered("Alice");
      await vi.advanceTimersByTimeAsync(300);
      expect(d.cancel).not.toHaveBeenCalled();

      visible = true;
      await vi.advanceTimersByTimeAsync(300);
      expect(d.cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops watching once the reminder is due", async () => {
    vi.useFakeTimers();
    try {
      let visible = false;
      const d = { ...deps(false), isPageVisible: vi.fn(() => visible) };
      const reminder = createAnswerReminder(d);

      reminder.answered("Alice");
      await vi.advanceTimersByTimeAsync(ANSWER_REMINDER_DELAY_MS + 500);
      const checks = d.isPageVisible.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(d.isPageVisible.mock.calls.length).toBe(checks);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws when native is missing the methods", async () => {
    const d = {
      ...deps(false),
      schedule: vi.fn(() => { throw new TypeError("not a function"); }),
      cancel: vi.fn(() => { throw new TypeError("not a function"); }),
    };
    const reminder = createAnswerReminder(d);

    expect(() => reminder.answered("Alice")).not.toThrow();
    expect(() => reminder.settle()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.schedule).toHaveBeenCalledOnce();
  });
});
