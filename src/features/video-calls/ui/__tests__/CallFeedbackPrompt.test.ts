// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

const openBugReport = vi.fn();
vi.mock("@/features/bug-report", () => ({
  useBugReport: () => ({ open: openBugReport }),
}));

import CallFeedbackPrompt from "../CallFeedbackPrompt.vue";

function mountPrompt(durationS = 42) {
  return mount(CallFeedbackPrompt, { props: { durationS } });
}

describe("CallFeedbackPrompt", () => {
  beforeEach(() => {
    // `useI18n` reads the locale store, so the component needs a live Pinia.
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("dismisses without opening a report on thumbs up", async () => {
    const wrapper = mountPrompt();

    await wrapper.get('[data-testid="call-feedback-good"]').trigger("click");

    expect(wrapper.emitted("dismiss")).toHaveLength(1);
    expect(openBugReport).not.toHaveBeenCalled();
  });

  it("offers the symptom list on thumbs down instead of reporting straight away", async () => {
    const wrapper = mountPrompt();

    await wrapper.get('[data-testid="call-feedback-bad"]').trigger("click");

    expect(wrapper.find('[data-testid="call-feedback-problem-peer_not_heard"]').exists()).toBe(true);
    expect(wrapper.emitted("dismiss")).toBeUndefined();
    expect(openBugReport).not.toHaveBeenCalled();
  });

  it("opens a pre-filled report carrying the symptom and duration", async () => {
    // The tail is what lets triage group reports without reading prose.
    const wrapper = mountPrompt(7.4);

    await wrapper.get('[data-testid="call-feedback-bad"]').trigger("click");
    await wrapper.get('[data-testid="call-feedback-problem-not_heard_by_peer"]').trigger("click");

    expect(openBugReport).toHaveBeenCalledOnce();
    const context = openBugReport.mock.calls[0][0].context as string;
    expect(context).toContain("call feedback: not_heard_by_peer");
    expect(context).toContain("duration 7s");
    expect(wrapper.emitted("dismiss")).toHaveLength(1);
  });

  it("can be skipped from the symptom list", async () => {
    const wrapper = mountPrompt();

    await wrapper.get('[data-testid="call-feedback-bad"]').trigger("click");
    await wrapper.get('[data-testid="call-feedback-skip"]').trigger("click");

    expect(wrapper.emitted("dismiss")).toHaveLength(1);
    expect(openBugReport).not.toHaveBeenCalled();
  });

  it("closes without a report when the card is dismissed outright", async () => {
    const wrapper = mountPrompt();

    await wrapper.find('[data-testid="call-feedback-close"]').trigger("click");

    expect(wrapper.emitted("dismiss")).toHaveLength(1);
    expect(openBugReport).not.toHaveBeenCalled();
  });
});
