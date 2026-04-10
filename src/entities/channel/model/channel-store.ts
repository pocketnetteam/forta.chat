import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { useAuthStore } from "@/entities/auth";

import type { Channel, ChannelPost } from "./types";

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
  /** Per-channel session height: 0 until first getProfileFeed response, then the server-returned height */
  const sessionHeight = ref(new Map<string, number>());
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
    }

    if (!hasMoreChannels.value) return;

    isLoadingChannels.value = true;
    channelError.value = null;

    try {
      const result = await authStore.getSubscribesChannels(
        addr,
        0,
        channelsPage.value,
        20
      );

      if (!result) {
        channelError.value = "Failed to load channels";
        return;
      }

      // height from channels response is not used; getProfileFeed manages its own session height
      const parsed = (result.channels ?? []).map((raw: any) => parseChannel(raw));

      if (reset) {
        channels.value = parsed;
      } else {
        channels.value = [...channels.value, ...parsed];
      }

      hasMoreChannels.value = parsed.length >= 20;
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
      sessionHeight.value.delete(channelAddress);
    }

    if (hasMorePosts.value.get(channelAddress) === false) return;

    isLoadingPosts.value = true;
    postsError.value = null;

    try {
      const startTxid = postsStartTxid.value.get(channelAddress) ?? "";
      const count = 10;
      const height = sessionHeight.value.get(channelAddress) ?? 0;

      const feedResult = await authStore.getProfileFeed(channelAddress, {
        height,
        startTxid,
        count,
      });

      if (!feedResult || !Array.isArray(feedResult.posts)) {
        postsError.value = "Failed to load posts";
        return;
      }

      if (feedResult.height && !sessionHeight.value.has(channelAddress)) {
        sessionHeight.value.set(channelAddress, feedResult.height);
      }

      feedResult.posts.forEach((raw: any) => authStore.cachePost(raw));

      const parsed = feedResult.posts.map((raw: any) => parsePost(raw));
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
    fetchPosts(address, true);
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
    sessionHeight.value = new Map();
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
    sessionHeight,
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
