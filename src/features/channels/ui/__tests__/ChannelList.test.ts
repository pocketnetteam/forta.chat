import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";

// Fake channel store — reactive so template updates propagate. `fetchPosts`
// (which triggers getProfileFeed) is spied so the regression can assert the
// list NEVER calls it just to render previews.
const fakeChannelStore = reactive({
  channels: [] as Array<{
    address: string;
    name: string;
    avatar: string;
    lastContent: {
      txid: string;
      type: string;
      caption: string;
      message: string;
      time: number;
      height: number;
      scoreSum: number;
      scoreCnt: number;
      comments: number;
    } | null;
  }>,
  isLoadingChannels: false,
  channelError: null as string | null,
  hasMoreChannels: true,
  activeChannelAddress: null as string | null,
  fetchChannels: vi.fn(),
  fetchPosts: vi.fn(),
  hydrateFromDexie: vi.fn(async () => {}),
  setActiveChannel: vi.fn(),
});

vi.mock("@/entities/channel", async () => {
  const actual = await vi.importActual<typeof import("@/entities/channel")>(
    "@/entities/channel",
  );
  return {
    ...actual,
    useChannelStore: () => fakeChannelStore,
  };
});

vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({ setActiveRoom: vi.fn() }),
}));

vi.mock("@/entities/ai-chat", () => ({
  useAiChatStore: () => ({ selectChat: vi.fn() }),
}));

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

vi.mock("@/shared/lib/format", () => ({
  formatRelativeTime: () => "now",
}));

// Stub the virtual scroller to render every item's default slot so preview
// text is actually present in the DOM for assertions.
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: {
    name: "RecycleScroller",
    props: ["items"],
    template:
      '<div class="scroller"><div v-for="item in items" :key="item.address"><slot :item="item" /></div></div>',
  },
}));

vi.mock("vue-virtual-scroller/dist/vue-virtual-scroller.css", () => ({}));

import ChannelList from "../ChannelList.vue";

const mountOpts = {
  global: {
    stubs: {
      Avatar: { name: "Avatar", template: "<div />" },
    },
  },
};

function makeChannel(caption: string, message = "") {
  return {
    address: `addr_${caption}`,
    name: `Ch ${caption}`,
    avatar: "",
    lastContent: {
      txid: "tx",
      type: "post",
      caption,
      message,
      time: 1_700_000_000,
      height: 100,
      scoreSum: 0,
      scoreCnt: 0,
      comments: 0,
    },
  };
}

beforeEach(() => {
  fakeChannelStore.channels = [];
  fakeChannelStore.isLoadingChannels = false;
  fakeChannelStore.channelError = null;
  fakeChannelStore.hasMoreChannels = true;
  fakeChannelStore.activeChannelAddress = null;
  fakeChannelStore.fetchChannels.mockReset();
  fakeChannelStore.fetchPosts.mockReset();
  fakeChannelStore.hydrateFromDexie.mockReset().mockResolvedValue(undefined);
  fakeChannelStore.setActiveChannel.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ChannelList — no getProfileFeed prefetch for the list", () => {
  it("refreshes the channel list but never prefetches per-channel posts on render", async () => {
    fakeChannelStore.channels = [makeChannel("hello"), makeChannel("world")];

    const wrapper = mount(ChannelList, mountOpts);
    await flushPromises();

    // The list refresh (getsubscribeschannels) still runs...
    expect(fakeChannelStore.fetchChannels).toHaveBeenCalledWith(true);
    // ...but getProfileFeed (fetchPosts) must NOT be called just to paint rows.
    expect(fakeChannelStore.fetchPosts).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("renders preview text from lastContent (not from a fetched feed)", async () => {
    fakeChannelStore.channels = [makeChannel("preview-from-last-content")];

    const wrapper = mount(ChannelList, mountOpts);
    await flushPromises();

    expect(wrapper.text()).toContain("preview-from-last-content");
    expect(fakeChannelStore.fetchPosts).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("delegates channel entry to the store (which lazy-loads posts), not the list", async () => {
    fakeChannelStore.channels = [makeChannel("hello")];

    const wrapper = mount(ChannelList, mountOpts);
    await flushPromises();

    await wrapper.find("button.flex").trigger("click");

    expect(fakeChannelStore.setActiveChannel).toHaveBeenCalledWith("addr_hello");
    // The list itself does not call fetchPosts directly — that is the store's job.
    expect(fakeChannelStore.fetchPosts).not.toHaveBeenCalled();

    wrapper.unmount();
  });
});
