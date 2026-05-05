import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useChannelStore } from "../channel-store";
import { useAuthStore } from "@/entities/auth";

vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(),
}));

describe("channel-store — fetchChannels dedup + filter", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(useAuthStore).mockReset();
  });

  it("dedupes channel.address across pagination pages", async () => {
    // Backend returns full pages (>= 20) so hasMoreChannels stays true and
    // page 1 actually gets fetched. Page 1 includes addr_0 from page 0 to
    // simulate the offset-shift overlap that triggers the phantom-gap bug.
    const page0 = Array.from({ length: 20 }, (_, i) => ({
      address: `addr_${i}`,
      name: `Ch${i}`,
    }));
    const page1 = [
      { address: "addr_0", name: "Ch0" }, // дубль из page 0
      ...Array.from({ length: 19 }, (_, i) => ({
        address: `addr_${20 + i}`,
        name: `Ch${20 + i}`,
      })),
    ];

    const mockGetSubs = vi
      .fn()
      .mockResolvedValueOnce({ channels: page0, height: 1000 })
      .mockResolvedValueOnce({ channels: page1, height: 1000 });

    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getSubscribesChannels: mockGetSubs,
    } as unknown as ReturnType<typeof useAuthStore>);

    const store = useChannelStore();
    await store.fetchChannels(true);
    await store.fetchChannels(false);

    const addrs = store.channels.map((c) => c.address);
    // 20 unique from page 0 + 19 unique fresh from page 1 (addr_0 dropped)
    expect(addrs.length).toBe(39);
    expect(new Set(addrs).size).toBe(39);
    expect(addrs[0]).toBe("addr_0");
    expect(addrs[20]).toBe("addr_20");
    expect(addrs[addrs.length - 1]).toBe("addr_38");
  });

  it("filters entries without address or name", async () => {
    const mockGetSubs = vi.fn().mockResolvedValueOnce({
      channels: [
        { address: "addr_A", name: "A" },
        { address: undefined, name: "broken" }, // no address
        { address: "addr_C", name: "" },          // empty name
        { address: "addr_D", name: "D" },
      ],
      height: 1000,
    });

    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getSubscribesChannels: mockGetSubs,
    } as unknown as ReturnType<typeof useAuthStore>);

    const store = useChannelStore();
    await store.fetchChannels(true);

    const addrs = store.channels.map((c) => c.address);
    expect(addrs).toEqual(["addr_A", "addr_D"]);
  });

  it("dedupes within a single page (defensive)", async () => {
    const mockGetSubs = vi.fn().mockResolvedValueOnce({
      channels: [
        { address: "addr_A", name: "A" },
        { address: "addr_A", name: "A duplicate same page" },
        { address: "addr_B", name: "B" },
      ],
      height: 1000,
    });

    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getSubscribesChannels: mockGetSubs,
    } as unknown as ReturnType<typeof useAuthStore>);

    const store = useChannelStore();
    await store.fetchChannels(true);

    const addrs = store.channels.map((c) => c.address);
    expect(addrs).toEqual(["addr_A", "addr_B"]);
  });
});
