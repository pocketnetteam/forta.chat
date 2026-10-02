import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

// Stub stores BEFORE component import (vi.mock is hoisted).
const loadCollection = vi.fn();
const getCachedCollection = vi.fn((): BastyonCollectionData | null => null);
const loadUsersInfo = vi.fn().mockResolvedValue(undefined);
const loadPost = vi.fn();
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    getCachedCollection,
    loadCollection,
    loadUsersInfo,
    loadPost,
    getBastyonUserData: () => ({ name: "Alice", image: "" }),
  }),
}));
vi.mock("@/shared/lib/image-url", () => ({
  normalizePocketnetImageUrl: (x: string) => x,
}));

const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
vi.mock("@/shared/lib/open-external-url", () => ({ openExternalUrl }));

import CollectionCard from "../CollectionCard.vue";
import type { BastyonCollectionData } from "@/shared/lib/bastyon-collection";

const TXID = "a".repeat(64);
const COLLECTION_LOAD_TIMEOUT_MS = 15_000;

const collection: BastyonCollectionData = {
  txid: TXID,
  address: "PAuthor",
  caption: "Best posts",
  description: "Hand-picked",
  image: "https://img/cover.jpg",
  contentCount: 7,
  deleted: false,
};

function mountCard() {
  return mount(CollectionCard, { props: { txid: TXID, isOwn: false } });
}

describe("CollectionCard", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    loadCollection.mockReset();
    loadPost.mockReset();
    openExternalUrl.mockReset();
    getCachedCollection.mockReturnValue(null);
  });

  it("renders cover, caption, description, author and publications count", async () => {
    loadCollection.mockResolvedValue(collection);
    const w = mountCard();
    await flushPromises();

    const text = w.text();
    expect(text).toContain("Collection");
    expect(text).toContain("Best posts");
    expect(text).toContain("Hand-picked");
    expect(text).toContain("Alice");
    expect(text).toContain("Publications: 7");
    expect(w.find('img[src="https://img/cover.jpg"]').exists()).toBe(true);
    expect(loadUsersInfo).toHaveBeenCalledWith(["PAuthor"]);
  });

  it("does not load the publications of the collection", async () => {
    loadCollection.mockResolvedValue(collection);
    mountCard();
    await flushPromises();

    expect(loadCollection).toHaveBeenCalledWith(TXID);
    expect(loadPost).not.toHaveBeenCalled();
  });

  it("uses the cached collection without a skeleton or a new request", async () => {
    getCachedCollection.mockReturnValue(collection);
    const w = mountCard();

    expect(w.find(".animate-pulse").exists()).toBe(false);
    await flushPromises();
    expect(loadCollection).not.toHaveBeenCalled();
    expect(w.text()).toContain("Best posts");
  });

  it("opens the collection in Bastyon", async () => {
    loadCollection.mockResolvedValue(collection);
    const w = mountCard();
    await flushPromises();

    await w.find("button").trigger("click");
    expect(openExternalUrl).toHaveBeenCalledWith(`https://bastyon.com/collection?c=${TXID}`);
  });

  it("shows the deleted state for a removed collection", async () => {
    loadCollection.mockResolvedValue({ ...collection, deleted: true });
    const w = mountCard();
    await flushPromises();

    expect(w.text()).toBe("Collection was deleted");
  });

  it("shows not found + retry when the collection is missing", async () => {
    loadCollection.mockResolvedValue(null);
    const w = mountCard();
    await flushPromises();

    expect(w.find("a").text()).toBe("Collection not found");
    await w.find("button").trigger("click");
    await flushPromises();
    expect(loadCollection).toHaveBeenCalledTimes(2);
  });

  describe("bounded skeleton", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("turns the skeleton into an error with retry after the timeout", async () => {
      loadCollection.mockReturnValue(new Promise(() => {}));
      const w = mountCard();
      await flushPromises();
      expect(w.find(".animate-pulse").exists()).toBe(true);

      await vi.advanceTimersByTimeAsync(COLLECTION_LOAD_TIMEOUT_MS + 1);
      await flushPromises();

      expect(w.find(".animate-pulse").exists()).toBe(false);
      expect(w.find("button").exists()).toBe(true);
    });
  });
});
