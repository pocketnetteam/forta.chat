import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { useAuthStore } from "@/entities/auth";

import type { Channel, ChannelPost } from "./types";

const CHANNELS_PAGE_SIZE = 20;

function tryDecode(val: unknown): string {
  if (typeof val !== "string") return "";
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function parsePost(raw: Record<string, unknown>): ChannelPost {
  return {
    txid: (raw.txid as string) ?? "",
    type: (raw.type as ChannelPost["type"]) ?? "share",
    caption: tryDecode(raw.caption ?? raw.c),
    message: tryDecode(raw.message ?? raw.m),
    time: Number(raw.time ?? 0),
    height: Number(raw.height ?? 0),
    scoreSum: Number(raw.scoreSum ?? 0),
    scoreCnt: Number(raw.scoreCnt ?? 0),
    comments: Number(raw.comments ?? 0),
    images: Array.isArray(raw.images ?? raw.i)
      ? (raw.images ?? raw.i) as string[]
      : undefined,
    url: (raw.url ?? raw.u) ? tryDecode(raw.url ?? raw.u) : undefined,
    tags: Array.isArray(raw.tags ?? raw.t)
      ? (raw.tags ?? raw.t) as string[]
      : undefined,
    settings: (raw.settings ?? raw.s) as { v?: string } | undefined,
  };
}

function parseChannel(raw: Record<string, unknown>): Channel {
  const lastRaw = raw.lastContent as Record<string, unknown> | null | undefined;
  return {
    address: (raw.address as string) ?? "",
    name: tryDecode(raw.name),
    avatar: (raw.avatar as string) ?? "",
    lastContent: lastRaw ? parsePost(lastRaw) : null,
  };
}

export const useChannelStore = defineStore("channel", () => {
  const channels = ref<Channel[]>([]);
  const activeChannelAddress = ref<string | null>(null);
  const posts = ref(new Map<string, ChannelPost[]>());
  const isLoadingChannels = ref(false);
  const isLoadingPosts = ref(false);
  const channelsPage = ref(0);
  const hasMoreChannels = ref(true);
  const postsStartTxid = ref(new Map<string, string>());
  const hasMorePosts = ref(new Map<string, boolean>());
  const blockHeight = ref(0);
  const channelError = ref<string | null>(null);
  const postsError = ref<string | null>(null);

  const activeChannel = computed(() =>
    channels.value.find((c) => c.address === activeChannelAddress.value) ?? null
  );

  const activePosts = computed(() =>
    activeChannelAddress.value
      ? posts.value.get(activeChannelAddress.value) ?? []
      : []
  );

  const activeHasMorePosts = computed(() =>
    activeChannelAddress.value
      ? hasMorePosts.value.get(activeChannelAddress.value) ?? true
      : false
  );

  async function fetchChannels(reset = false) {
    const authStore = useAuthStore();
    const addr = authStore.address;
    if (!addr) return;

    if (reset) {
      channelsPage.value = 0;
      hasMoreChannels.value = true;
      channels.value = [];
      blockHeight.value = 4675546;
    }

    if (!hasMoreChannels.value) return;

    isLoadingChannels.value = true;
    channelError.value = null;

    try {
      const result = await authStore.getSubscribesChannels(
        addr,
        blockHeight.value,
        channelsPage.value,
        CHANNELS_PAGE_SIZE
      );

      if (!result) {
        channelError.value = "Failed to load channels";
        return;
      }

      blockHeight.value = result.height ?? blockHeight.value;

      // Drop entries with empty address or name (treated as broken-output,
      // not "channel without a display name"). RecycleScroller uses address
      // as key-field; empty / duplicate keys collide and Vue stops rendering
      // the duplicates, leaving phantom empty slots in the list.
      const rawList = (result.channels ?? []) as Array<Record<string, unknown>>;
      const rawParsed = rawList.map((raw) => parseChannel(raw));
      const parsed = rawParsed.filter((c) => Boolean(c.address) && Boolean(c.name));
      // Use the raw page size, not the filtered size, so a partially-broken
      // page doesn't prematurely stop pagination.
      const pageHadFullCount = rawParsed.length >= CHANNELS_PAGE_SIZE;

      // Dedup-by-address — page 0 and page 1 may overlap when a new channel
      // appears between requests and shifts the offset, producing the same
      // address in both pages.
      const existingAddrs = new Set(
        reset ? [] : channels.value.map((c) => c.address)
      );
      const fresh: Channel[] = [];
      for (const channel of parsed) {
        if (existingAddrs.has(channel.address)) continue;
        existingAddrs.add(channel.address);
        fresh.push(channel);
      }

      if (reset) {
        channels.value = fresh;
      } else {
        channels.value = [...channels.value, ...fresh];
      }

      hasMoreChannels.value = pageHadFullCount;
      channelsPage.value += 1;
    } catch (e) {
      console.error("[channel-store] fetchChannels error:", e);
      channelError.value = String(e);
    } finally {
      isLoadingChannels.value = false;
    }
  }

  async function fetchPosts(channelAddress: string, reset = false) {
    const authStore = useAuthStore();

    if (reset) {
      postsStartTxid.value.delete(channelAddress);
      hasMorePosts.value.set(channelAddress, true);
      posts.value.set(channelAddress, []);
    }

    if (hasMorePosts.value.get(channelAddress) === false) return;

    isLoadingPosts.value = true;
    postsError.value = null;

    try {
      const startTxid = postsStartTxid.value.get(channelAddress) ?? "";
      const count = 10;

      const rawPosts = await authStore.getProfileFeed(channelAddress, {
        height: blockHeight.value,
        startTxid,
        count,
      });

      if (!rawPosts || !Array.isArray(rawPosts)) {
        postsError.value = "Failed to load posts";
        return;
      }

      // Cache raw posts so PostCard can find them without a separate API call
      rawPosts.forEach((raw: any) => authStore.cachePost(raw));

      const parsed = rawPosts.map((raw: any) => parsePost(raw));
      const existing = posts.value.get(channelAddress) ?? [];

      if (reset) {
        posts.value.set(channelAddress, parsed);
      } else {
        posts.value.set(channelAddress, [...existing, ...parsed]);
      }

      if (parsed.length > 0) {
        postsStartTxid.value.set(channelAddress, parsed[parsed.length - 1].txid);
      }

      hasMorePosts.value.set(channelAddress, parsed.length >= count);
    } catch (e) {
      console.error("[channel-store] fetchPosts error:", e);
      postsError.value = String(e);
    } finally {
      isLoadingPosts.value = false;
    }
  }

  function setActiveChannel(address: string) {
    activeChannelAddress.value = address;
    if (!posts.value.has(address)) {
      fetchPosts(address, true);
    }
  }

  function clearActiveChannel() {
    activeChannelAddress.value = null;
  }

  const cleanup = () => {
    channels.value = [];
    activeChannelAddress.value = null;
    posts.value = new Map();
    isLoadingChannels.value = false;
    isLoadingPosts.value = false;
    channelsPage.value = 0;
    hasMoreChannels.value = true;
    postsStartTxid.value = new Map();
    hasMorePosts.value = new Map();
    blockHeight.value = 0;
    channelError.value = null;
    postsError.value = null;
  };

  return {
    channels,
    activeChannelAddress,
    posts,
    isLoadingChannels,
    isLoadingPosts,
    channelsPage,
    hasMoreChannels,
    postsStartTxid,
    hasMorePosts,
    blockHeight,
    channelError,
    postsError,
    activeChannel,
    activePosts,
    activeHasMorePosts,
    fetchChannels,
    fetchPosts,
    setActiveChannel,
    clearActiveChannel,
    cleanup,
  };
});
