import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";

// Stub the virtual scroller to render every item's default slot so the
// download-gate button is actually present in the DOM for assertions —
// mirrors ChannelList.test.ts's own stub for the same component.
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: {
    name: "RecycleScroller",
    props: ["items"],
    template: '<div class="scroller"><div v-for="item in items" :key="item.id"><slot :item="item" /></div></div>',
  },
}));
vi.mock("vue-virtual-scroller/dist/vue-virtual-scroller.css", () => ({}));

import AiChatList from "../AiChatList.vue";

// Regression: opening an AI chat whose model isn't configured/downloaded yet
// used to just show the empty chat behind AiModelGate's inline download
// gate — the user now gets sent to Settings → Local AI instead (widget layer
// owns the actual navigation via the `modelNotReady` event this emits).
const fakeAiChatStore = reactive({
  chats: [{ id: "chat-1", title: "New chat", lastMessagePreview: "", lastMessageTimestamp: null }],
  activeChatId: null as string | null,
  selectChat: vi.fn(),
  deleteChat: vi.fn(async () => {}),
});

const fakeChatStore = reactive({ setActiveRoom: vi.fn() });
const fakeChannelStore = reactive({ clearActiveChannel: vi.fn() });
const fakeLocalAiStore = reactive({
  modelReady: false,
  restoreModelIfPreviouslyDownloaded: vi.fn(async () => {}),
});

vi.mock("@/entities/ai-chat", () => ({
  useAiChatStore: () => fakeAiChatStore,
}));
vi.mock("@/entities/chat", () => ({
  useChatStore: () => fakeChatStore,
}));
vi.mock("@/entities/channel", () => ({
  useChannelStore: () => fakeChannelStore,
}));
vi.mock("@/entities/local-ai", () => ({
  useLocalAiStore: () => fakeLocalAiStore,
}));
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ address: "addr_a" }),
}));
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  fakeLocalAiStore.modelReady = false;
  fakeAiChatStore.activeChatId = null;
  vi.clearAllMocks();
});

describe("AiChatList", () => {
  it("emits modelNotReady and does not select the chat when the model isn't ready", async () => {
    const wrapper = mount(AiChatList);
    await flushPromises();

    await wrapper.find("button").trigger("click");

    expect(wrapper.emitted("modelNotReady")).toHaveLength(1);
    expect(wrapper.emitted("selectChat")).toBeUndefined();
    expect(fakeAiChatStore.selectChat).not.toHaveBeenCalled();
  });

  it("checks restoreModelIfPreviouslyDownloaded() first, so an already-set-up device isn't redirected by mistake", async () => {
    fakeLocalAiStore.restoreModelIfPreviouslyDownloaded.mockImplementation(async () => {
      fakeLocalAiStore.modelReady = true; // simulates a successful silent restore
    });
    const wrapper = mount(AiChatList);
    await flushPromises();

    await wrapper.find("button").trigger("click");

    expect(fakeLocalAiStore.restoreModelIfPreviouslyDownloaded).toHaveBeenCalledWith("addr_a");
    expect(wrapper.emitted("modelNotReady")).toBeUndefined();
    expect(wrapper.emitted("selectChat")).toEqual([["chat-1"]]);
  });

  it("selects the chat normally when the model is already ready", async () => {
    fakeLocalAiStore.modelReady = true;
    const wrapper = mount(AiChatList);
    await flushPromises();

    await wrapper.find("button").trigger("click");

    expect(fakeLocalAiStore.restoreModelIfPreviouslyDownloaded).not.toHaveBeenCalled();
    expect(fakeAiChatStore.selectChat).toHaveBeenCalledWith("chat-1");
    expect(fakeChatStore.setActiveRoom).toHaveBeenCalledWith(null);
    expect(fakeChannelStore.clearActiveChannel).toHaveBeenCalled();
    expect(wrapper.emitted("selectChat")).toEqual([["chat-1"]]);
  });

  it("right-click opens a menu with a delete action, and confirming deletes the chat", async () => {
    const wrapper = mount(AiChatList, { attachTo: document.body });
    await flushPromises();

    await wrapper.find("button").trigger("contextmenu");
    await flushPromises();

    const deleteMenuItem = document.body
      .querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(deleteMenuItem).toHaveLength(1);
    expect(deleteMenuItem[0].textContent).toContain("contactList.delete");

    deleteMenuItem[0].click();
    await flushPromises();

    // Confirmation dialog, not an immediate delete.
    expect(document.body.textContent).toContain("ai.deleteChatConfirm");
    expect(fakeAiChatStore.deleteChat).not.toHaveBeenCalled();

    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "contactList.delete",
    );
    confirmButton?.click();
    await flushPromises();

    expect(fakeAiChatStore.deleteChat).toHaveBeenCalledWith("chat-1");
    wrapper.unmount();
  });

  it("canceling the delete confirmation does not delete the chat", async () => {
    const wrapper = mount(AiChatList, { attachTo: document.body });
    await flushPromises();

    await wrapper.find("button").trigger("contextmenu");
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
    await flushPromises();

    const cancelButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "contactList.cancel",
    );
    cancelButton?.click();
    await flushPromises();

    expect(fakeAiChatStore.deleteChat).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("ai.deleteChatConfirm");
    wrapper.unmount();
  });
});
