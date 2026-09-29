import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, defineComponent } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

/**
 * forta-bugs#1091: a call card in the timeline had no menu at all, so a call
 * record could not be deleted. A long press or right-click now opens the
 * message menu with Delete only, and the press that opened it does not also
 * dial the peer back.
 */

const launch = vi.fn();
vi.mock("@/features/video-calls", () => ({
  useCallLauncher: () => ({
    launch,
    pickerOpen: ref(false),
    pickerOptions: ref([]),
    pickerAnchor: ref({ x: 0, y: 0 }),
    pick: vi.fn(),
    closePicker: vi.fn(),
  }),
  CallProviderPicker: defineComponent({ template: "<div />" }),
}));
vi.mock("@/entities/call", () => ({ useCallStore: () => ({ isInCall: false }) }));
vi.mock("@/entities/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/entities/chat")>()),
  useChatStore: () => ({ selectionMode: false, rooms: [] }),
}));
vi.mock("@/shared/lib/composables/use-media-query", () => ({ useMobile: () => ref(false) }));

const callMessage = {
  id: "$hangup",
  roomId: "!r:s",
  senderId: "peer",
  content: "",
  timestamp: 1_700_000_000_000,
  status: "sent",
  type: "system",
  callInfo: { callType: "voice", missed: false, duration: 12, callId: "c1" },
} as never;

describe("call card menu (#1091)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    launch.mockClear();
    vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the menu on right-click", async () => {
    const { default: CallEventCard } = await import("../CallEventCard.vue");
    const wrapper = mount(CallEventCard, { props: { message: callMessage, isOwn: false, tailClass: "" } });

    await wrapper.find("button").trigger("contextmenu", { clientX: 10, clientY: 20 });

    expect(wrapper.emitted("contextmenu")?.[0]).toEqual([{ message: callMessage, x: 10, y: 20 }]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("opens the menu on a long press and does not call back on the release", async () => {
    vi.useFakeTimers();
    const { default: CallEventCard } = await import("../CallEventCard.vue");
    const wrapper = mount(CallEventCard, { props: { message: callMessage, isOwn: false, tailClass: "" } });
    const button = wrapper.find("button");

    await button.trigger("pointerdown", { clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(600);
    await button.trigger("pointerup");
    await button.trigger("click");

    expect(wrapper.emitted("contextmenu")).toHaveLength(1);
    expect(launch).not.toHaveBeenCalled();

    // The next ordinary tap still calls back.
    await button.trigger("pointerdown", { clientX: 5, clientY: 5 });
    await button.trigger("pointerup");
    await button.trigger("click");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  // A scroll that starts on the card ends in pointercancel, not pointerup: the
  // armed timer must not open the menu mid-scroll.
  it("does not open the menu when the press turns into a scroll", async () => {
    vi.useFakeTimers();
    const { default: CallEventCard } = await import("../CallEventCard.vue");
    const wrapper = mount(CallEventCard, { props: { message: callMessage, isOwn: false, tailClass: "" } });
    const button = wrapper.find("button");

    await button.trigger("pointerdown", { clientX: 5, clientY: 5 });
    await button.trigger("pointercancel");
    vi.advanceTimersByTime(600);

    expect(wrapper.emitted("contextmenu")).toBeUndefined();
  });

  it("offers only Delete for a call card, without the reactions row", async () => {
    const { default: MessageContextMenu } = await import("../MessageContextMenu.vue");
    const { ContextMenu } = await import("@/shared/ui/context-menu");
    const wrapper = mount(MessageContextMenu, {
      props: { show: true, x: 0, y: 0, message: callMessage, isOwn: false },
      global: { stubs: { teleport: true } },
    });
    await flushPromises();

    const items = wrapper.findComponent(ContextMenu).props("items") as Array<{ action: string }>;
    expect(items.map((i) => i.action)).toEqual(["delete"]);
    expect(wrapper.findComponent({ name: "ReactionPicker" }).exists()).toBe(false);
  });
});
