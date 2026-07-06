import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useChannelStore } from "../channel-store";
import { useAuthStore } from "@/entities/auth";

vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(),
}));

describe("channel-store — getProfileFeed only on channel entry", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(useAuthStore).mockReset();
  });

  it("fetchChannels does NOT call getProfileFeed — lastContent from getSubscribesChannels is enough", async () => {
    const getSubscribesChannels = vi.fn().mockResolvedValueOnce({
      channels: [
        {
          address: "addr_A",
          name: "A",
          lastContent: { txid: "t1", caption: "hi", time: 1 },
        },
      ],
      height: 1000,
    });
    const getProfileFeed = vi.fn().mockResolvedValue([]);

    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getSubscribesChannels,
      getProfileFeed,
      cachePost: vi.fn(),
    } as unknown as ReturnType<typeof useAuthStore>);

    const store = useChannelStore();
    await store.fetchChannels(true);

    expect(getSubscribesChannels).toHaveBeenCalledTimes(1);
    expect(getProfileFeed).not.toHaveBeenCalled();
    expect(store.channels[0]?.lastContent?.caption).toBe("hi");
  });

  it("setActiveChannel lazy-loads posts via getProfileFeed exactly once", async () => {
    const getProfileFeed = vi.fn().mockResolvedValue([]);
    const cachePost = vi.fn();

    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getProfileFeed,
      cachePost,
    } as unknown as ReturnType<typeof useAuthStore>);

    const store = useChannelStore();
    store.setActiveChannel("addr_A");
    // setActiveChannel kicks off fetchPosts asynchronously.
    await Promise.resolve();
    await Promise.resolve();

    expect(getProfileFeed).toHaveBeenCalledTimes(1);
    expect(getProfileFeed).toHaveBeenCalledWith(
      "addr_A",
      expect.objectContaining({ startTxid: "", count: 10 }),
    );
  });

  it("setActiveChannel does not refetch posts already in the store", async () => {
    const getProfileFeed = vi.fn().mockResolvedValue([]);

    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getProfileFeed,
      cachePost: vi.fn(),
    } as unknown as ReturnType<typeof useAuthStore>);

    const store = useChannelStore();
    store.posts.set("addr_A", []);
    store.setActiveChannel("addr_A");
    await Promise.resolve();

    expect(getProfileFeed).not.toHaveBeenCalled();
  });
});
