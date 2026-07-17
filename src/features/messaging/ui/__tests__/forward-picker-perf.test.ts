import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick, ref, defineComponent, h } from "vue";
import { readFileSync } from "fs";
import { resolve } from "path";

// WEE-100: forward picker opened slowly with no visual feedback — the whole
// room list (member counts via Matrix SDK + avatars) rendered synchronously
// on mount, so users saw nothing between the tap and the modal and tapped
// 3 times. The picker must now show its shell (header/search/spinner)
// instantly and defer the room list to the next painted frame.

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: { value: "en" } }),
}));

vi.mock("@/shared/lib/composables/use-android-back-handler", () => ({
  useAndroidBackHandler: vi.fn(),
}));

const mockIsMobile = ref(false);
vi.mock("@/shared/lib/composables/use-media-query", () => ({
  useMobile: () => mockIsMobile,
}));

const rooms = Array.from({ length: 80 }, (_, i) => ({
  id: `!room${i}:server`,
  name: `Room ${i}`,
  avatar: "",
  isGroup: i % 2 === 0,
  membership: "join",
  members: [],
}));

const mockChatStore = {
  sortedRooms: rooms,
  forwardingMessages: [],
  getRoomMemberCount: vi.fn(() => 5),
  saveForwardDraft: vi.fn(),
  saveBulkForwardDraft: vi.fn(),
  setActiveRoom: vi.fn(),
  exitSelectionMode: vi.fn(),
  cancelForward: vi.fn(),
};

vi.mock("@/entities/chat", () => ({
  useChatStore: () => mockChatStore,
}));

vi.mock("@/entities/chat/lib/use-resolved-room-name", () => ({
  useResolvedRoomName: () => ({ resolve: (r: { name: string }) => r.name }),
}));

vi.mock("@/entities/chat/lib/chat-helpers", () => ({
  isUnresolvedName: () => false,
}));

vi.mock("@/entities/user", () => ({
  UserAvatar: defineComponent({ name: "UserAvatar", render: () => h("div") }),
}));

// RecycleScroller needs real layout measurements — replace with a plain list
// so we can assert rows mount without a browser.
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    name: "RecycleScroller",
    props: { items: { type: Array, default: () => [] } },
    setup(props, { slots }) {
      return () =>
        h(
          "div",
          { "data-testid": "forward-room-list" },
          (props.items as unknown[]).map(item => slots.default?.({ item })),
        );
    },
  }),
}));
vi.mock("vue-virtual-scroller/dist/vue-virtual-scroller.css", () => ({}));

import ForwardPicker from "../ForwardPicker.vue";

// Deterministic rAF: collect callbacks, flush manually.
let rafQueue: FrameRequestCallback[] = [];
const flushRaf = async () => {
  // Two passes — the component double-rAFs so the shell paints first.
  for (let i = 0; i < 2; i++) {
    const cbs = rafQueue;
    rafQueue = [];
    cbs.forEach(cb => cb(0));
    await nextTick();
  }
};

const stubs = { Avatar: defineComponent({ name: "Avatar", render: () => h("div") }) };

let wrapper: VueWrapper | undefined;

describe("ForwardPicker — instant open (WEE-100)", () => {
  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    mockChatStore.getRoomMemberCount.mockClear();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("open показывает каркас сразу (header/spinner) до рендера полного списка", async () => {
    wrapper = mount(ForwardPicker, {
      props: { show: false },
      global: { stubs },
      attachTo: document.body,
    });

    await wrapper.setProps({ show: true });
    await nextTick();

    // Shell is visible immediately…
    const root = document.body.querySelector('[data-testid="forward-picker-root"]');
    expect(root).not.toBeNull();
    expect(document.body.querySelector('[data-testid="forward-list-loading"]')).not.toBeNull();
    // …but the heavy room list has NOT mounted yet (no rows, no SDK calls).
    expect(document.body.querySelector('[data-testid="forward-room-list"]')).toBeNull();
    expect(mockChatStore.getRoomMemberCount).not.toHaveBeenCalled();

    await flushRaf();

    // Next frame: spinner replaced by the actual list.
    expect(document.body.querySelector('[data-testid="forward-room-list"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="forward-list-loading"]')).toBeNull();
  });

  it("повторный toggle во время открытия не плодит дублей", async () => {
    wrapper = mount(ForwardPicker, {
      props: { show: true },
      global: { stubs },
      attachTo: document.body,
    });
    await nextTick();

    // Re-open while the deferred list is still pending (user taps again).
    await wrapper.setProps({ show: false });
    await wrapper.setProps({ show: true });
    await flushRaf();

    const roots = document.body.querySelectorAll('[data-testid="forward-picker-root"]');
    expect(roots.length).toBe(1);
    expect(document.body.querySelectorAll('[data-testid="forward-room-list"]').length).toBe(1);
  });

  it("member count кэшируется per-open (не дёргает Matrix SDK на каждый ререндер)", async () => {
    wrapper = mount(ForwardPicker, {
      props: { show: false },
      global: { stubs },
      attachTo: document.body,
    });
    await wrapper.setProps({ show: true });
    await flushRaf();

    // The list actually mounted and pulled member counts for group rows.
    expect(document.body.querySelector('[data-testid="forward-room-list"]')).not.toBeNull();
    const groupCount = rooms.filter(r => r.isGroup).length;
    expect(mockChatStore.getRoomMemberCount.mock.calls.length).toBeGreaterThan(0);
    // One SDK call per visible group row, not per render pass.
    expect(mockChatStore.getRoomMemberCount.mock.calls.length).toBeLessThanOrEqual(groupCount);

    const callsAfterFirstRender = mockChatStore.getRoomMemberCount.mock.calls.length;
    // Trigger a re-render via search filter round-trip. The picker teleports
    // to body, so query the document instead of the wrapper.
    const input = document.body.querySelector("input") as HTMLInputElement;
    expect(input).not.toBeNull();
    for (const value of ["Room 1", ""]) {
      input.value = value;
      input.dispatchEvent(new Event("input"));
      await nextTick();
    }

    // Cached counts are reused — no extra SDK calls for the same rooms.
    expect(mockChatStore.getRoomMemberCount.mock.calls.length).toBe(callsAfterFirstRender);
  });
});

describe("ChatWindow — forward picker open guard (WEE-100)", () => {
  it("watcher не переоткрывает пикер, если он уже показан", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../../widgets/chat-window/ChatWindow.vue"),
      "utf-8",
    );
    const watcherStart = source.indexOf("chatStore.forwardPickerRequested, (v)");
    expect(watcherStart).toBeGreaterThan(-1);
    const watcherBody = source.slice(watcherStart, watcherStart + 400);
    // Guard: repeated forward taps while the picker is open/opening are no-ops.
    expect(watcherBody).toMatch(/!showForwardPicker\.value/);
    // The request flag is always reset so the next request still fires.
    expect(watcherBody).toMatch(/forwardPickerRequested = false/);
  });
});
