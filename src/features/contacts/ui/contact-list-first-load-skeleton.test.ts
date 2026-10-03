import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Cold start with an empty Dexie: until the first sync lands the room tabs
 * must show the loader. ChatSidebar's own skeleton is skipped as soon as
 * channels are cached, which left "Личные"/"Группы" blank (neither the
 * skeleton nor the "no conversations" hint). The list mounts RecycleScroller
 * and half the stores, so this checks the source (same approach as
 * contact-list-row-cache.test.ts).
 */
const source = readFileSync(resolve(__dirname, "ContactList.vue"), "utf-8");
const template = source.slice(source.indexOf("<template>"));

describe("ContactList first-load skeleton", () => {
  it("shows the first-load skeleton while the room list is loading and the tab is empty", () => {
    expect(template).toMatch(
      /<RoomListSkeleton\s+v-if="filteredRooms\.length === 0 && chatStore\.isRoomListLoading"\s+:first-load="true"\s+:slow="chatStore\.isRoomListLoadingSlow"/,
    );
  });

  it("the empty-state hint is the else branch of the skeleton", () => {
    const skeletonIdx = template.indexOf("<RoomListSkeleton");
    const hintIdx = template.indexOf('v-else-if="filteredRooms.length === 0 && (chatStore.sortedRooms.length > 0 || chatStore.isRoomListAuthoritativeEmpty)"');
    expect(skeletonIdx).toBeGreaterThan(-1);
    expect(hintIdx).toBeGreaterThan(skeletonIdx);
  });

  it("keeps a loading header above cached channels while rooms are still loading", () => {
    expect(template).toMatch(
      /<RoomListSkeleton\s+v-if="filteredRooms\.length > 0 && chatStore\.isRoomListLoading"\s+:first-load="true"\s+:slow="chatStore\.isRoomListLoadingSlow"\s+:rows="0"/,
    );
    // The scroller shares the column with that header instead of taking 100%.
    expect(template).toMatch(/key-field="_key"\s+class="min-h-0 flex-1"/);
  });

  it("the sidebar skeleton still yields to cached channels (so the list must cover room tabs)", () => {
    const sidebar = readFileSync(resolve(__dirname, "../../../widgets/sidebar/ChatSidebar.vue"), "utf-8");
    expect(sidebar).toContain("chatStore.isRoomListLoading && channelStore.channels.length === 0");
  });
});
