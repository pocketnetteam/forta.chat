// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

const isSearching = ref(false);
const searchResults = ref<Array<{ address: string; name: string }>>([]);
const chatResults = ref<Array<{ id: string; name: string; avatar?: string }>>([]);

vi.mock("../../model/use-contacts", () => ({
  useContacts: () => ({
    searchResults,
    searchError: ref(null),
    isSearching,
    isCreatingRoom: ref(false),
    debouncedSearch: vi.fn(),
    getOrCreateRoom: vi.fn(),
  }),
}));
vi.mock("@/features/search", () => ({
  useSearch: () => ({ query: ref(""), chatResults, messageResults: ref([]) }),
}));
vi.mock("@/entities/chat", () => ({ useChatStore: () => ({ setActiveRoom: vi.fn() }) }));
vi.mock("@/entities/user", () => ({ UserAvatar: { name: "UserAvatar", template: "<i />" } }));
vi.mock("@/shared/lib/utils/format-preview", () => ({ useFormatPreview: () => ({ formatPreview: () => "" }) }));
vi.mock("@/entities/chat/lib/use-resolved-room-name", () => ({
  useResolvedRoomName: () => ({ resolve: (r: { name: string }) => r.name }),
}));

import ContactSearch from "../ContactSearch.vue";

function mountSearch() {
  return mount(ContactSearch, {
    props: { query: "max" },
    global: { stubs: { Avatar: true, UserAvatar: true } },
  });
}

describe("ContactSearch loading indicator", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    isSearching.value = false;
    searchResults.value = [];
    chatResults.value = [];
  });

  it("does not insert a loader row above results while the directory search runs", async () => {
    chatResults.value = [{ id: "!r1", name: "maxtest" }];
    isSearching.value = true;
    const w = mountSearch();
    await flushPromises();

    expect(w.find("[data-testid='contact-search-loading']").exists()).toBe(false);
    // The local chat hit is the first thing in the list, not pushed down.
    expect(w.findAll("button")[0].text()).toContain("maxtest");
  });

  it("shows the loader only while nothing is listed yet", async () => {
    isSearching.value = true;
    const w = mountSearch();
    await flushPromises();
    expect(w.find("[data-testid='contact-search-loading']").exists()).toBe(true);

    searchResults.value = [{ address: "PAddr", name: "maxtest" }];
    await flushPromises();
    expect(w.find("[data-testid='contact-search-loading']").exists()).toBe(false);
  });

  it("reports the search state to the parent and clears it on unmount", async () => {
    const onSearching = vi.fn();
    const w = mount(ContactSearch, {
      props: { query: "max", onSearching },
      global: { stubs: { Avatar: true, UserAvatar: true } },
    });
    await flushPromises();
    isSearching.value = true;
    await flushPromises();
    isSearching.value = false;
    await flushPromises();
    isSearching.value = true;
    await flushPromises();
    w.unmount();

    expect(onSearching.mock.calls).toEqual([[false], [true], [false], [true], [false]]);
  });
});
