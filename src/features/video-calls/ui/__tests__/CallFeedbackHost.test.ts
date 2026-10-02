// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const openBugReport = vi.fn();
vi.mock("@/features/bug-report", () => ({
  useBugReport: () => ({ open: openBugReport }),
}));

/** The host reads `history.length` and `history[0]`; the real store unshifts
 *  each finished call onto that same array (call-store.ts:174). */
vi.mock("@/entities/call", async () => {
  const { reactive } = await import("vue");
  const history = reactive<CallHistoryEntry[]>([]);
  return { useCallStore: () => ({ history }) };
});

import { useCallStore } from "@/entities/call";
import type { CallHistoryEntry } from "@/entities/call";
import CallFeedbackHost from "../CallFeedbackHost.vue";
import {
  acquireCallFeedbackDock,
  useCallFeedbackPrompt,
  __resetCallFeedbackPromptForTests,
} from "../../model/use-call-feedback-prompt";

const history = useCallStore().history;

function endCall(status: CallHistoryEntry["status"], duration: number): void {
  history.unshift({
    id: `call-${history.length}`,
    roomId: "!room:test",
    peerId: "@peer:test",
    peerName: "Peer",
    type: "voice",
    direction: "outgoing",
    status,
    startedAt: Date.now(),
    duration,
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetCallFeedbackPromptForTests();
  history.splice(0, history.length);
  localStorage.clear();
  openBugReport.mockClear();
});

afterEach(() => {
  __resetCallFeedbackPromptForTests();
});

describe("CallFeedbackHost", () => {
  it("asks about a call that just ended", async () => {
    const wrapper = mount(CallFeedbackHost);

    endCall("answered", 3);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="call-feedback-good"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("stays quiet about a call the user never took", async () => {
    const wrapper = mount(CallFeedbackHost);

    endCall("missed", 0);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="call-feedback-good"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("stands down while a dock is drawing the card", async () => {
    const wrapper = mount(CallFeedbackHost);
    const release = acquireCallFeedbackDock();

    endCall("answered", 3);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="call-feedback-good"]').exists()).toBe(false);

    // Leaving the chat mid-prompt hands the card back to the overlay.
    release();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="call-feedback-good"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("hides the overlay once the card is dismissed", async () => {
    const { visible } = useCallFeedbackPrompt();
    const wrapper = mount(CallFeedbackHost);

    endCall("answered", 3);
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-testid="call-feedback-close"]').trigger("click");

    expect(visible.value).toBe(false);
    expect(wrapper.find('[data-testid="call-feedback-good"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
