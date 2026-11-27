// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick, ref, defineComponent, h } from "vue";

/**
 * Policy 1A: opening ForwardPicker on mobile/native must NOT autofocus the
 * search input — the IME covers the room list and fights useIOSKeyboardDismiss
 * (open → scroll/tap → close flicker), especially on bulk file forward.
 */

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: { value: "en" } }),
}));

vi.mock("@/shared/lib/composables/use-android-back-handler", () => ({
  useAndroidBackHandler: vi.fn(),
}));

const mockIsMobile = ref(true);
vi.mock("@/shared/lib/composables/use-media-query", () => ({
  useMobile: () => mockIsMobile,
}));

vi.mock("@/shared/lib/platform", () => ({
  isNative: true,
  isAndroid: true,
  isIOS: false,
}));

vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({
    sortedRooms: [],
    forwardingMessages: [],
    forwardingMessage: null,
    getRoomMemberCount: vi.fn(() => 0),
    saveForwardDraft: vi.fn(),
    saveBulkForwardDraft: vi.fn(),
    setActiveRoom: vi.fn(),
    exitSelectionMode: vi.fn(),
    cancelForward: vi.fn(),
  }),
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

vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    name: "RecycleScroller",
    props: { items: { type: Array, default: () => [] } },
    setup(_props, { slots }) {
      return () => h("div", { "data-testid": "forward-room-list" }, []);
    },
  }),
}));
vi.mock("vue-virtual-scroller/dist/vue-virtual-scroller.css", () => ({}));

vi.mock("../../model/use-external-share", () => ({
  canShareExternally: false,
  useExternalShare: () => ({ share: vi.fn(), isSharing: ref(false) }),
}));

vi.mock("../../model/external-share-plan", () => ({
  buildForwardSharePlan: vi.fn(),
  buildMessagesSharePlan: vi.fn(),
}));

import ForwardPicker from "../ForwardPicker.vue";

const stubs = {
  Avatar: defineComponent({ name: "Avatar", render: () => h("div") }),
};

let wrapper: VueWrapper | undefined;

describe("ForwardPicker — no autofocus on mobile (policy 1A)", () => {
  beforeEach(() => {
    mockIsMobile.value = true;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
  });

  it("does not focus the search input when opened on mobile/native", async () => {
    wrapper = mount(ForwardPicker, {
      props: { show: true },
      global: { stubs },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const input = document.body.querySelector("input");
    expect(input).not.toBeNull();
    expect(document.activeElement).not.toBe(input);
  });

  it("blocks autofocus when native even if the viewport is wide", async () => {
    mockIsMobile.value = false;
    wrapper = mount(ForwardPicker, {
      props: { show: true },
      global: { stubs },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();
    const input = document.body.querySelector("input");
    expect(input).not.toBeNull();
    expect(document.activeElement).not.toBe(input);
  });
});
