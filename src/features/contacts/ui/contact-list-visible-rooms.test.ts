import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Roadmap stage 3: the chat list tells the store which rows are on screen so
 * their encrypted previews decrypt first (chatStore.setVisibleSidebarRooms).
 * Two ways the report went stale (code review):
 *  - a new message moves an off-screen room to the top without any scroll —
 *    the list must re-report on reorder, not only on scroll/tab change;
 *  - a tab with no chat rows (channels, empty filter) returned before
 *    reporting, so the store kept the previous tab's rows.
 * The list mounts RecycleScroller and half the stores, so this checks the
 * source (same approach as contact-list-row-cache.test.ts).
 */
const source = readFileSync(resolve(__dirname, "ContactList.vue"), "utf-8");

const block = (from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("ContactList reports its visible rows", () => {
  it("reports before the empty-rows early return", () => {
    const fn = block("const loadVisibleRooms = () => {", "let scrollDebounceTimer");
    const reportIdx = fn.indexOf("chatStore.setVisibleSidebarRooms(visibleIds, visibleRowsOwner)");
    const earlyReturnIdx = fn.indexOf("if (visibleIds.length === 0) return;");
    expect(reportIdx).toBeGreaterThan(-1);
    expect(earlyReturnIdx).toBeGreaterThan(reportIdx);
  });

  it("re-reports when the room list changes (reorder on a new message)", () => {
    const start = source.search(/watch\(\s*filteredRooms,/);
    expect(start).toBeGreaterThan(-1);
    const watcher = source.slice(start, source.indexOf("{ immediate: true }", start));
    expect(watcher).toContain("reportVisibleRoomsSoon()");
  });

  it("only the list on screen reports (SwipeableTabs keeps every tab mounted)", () => {
    const fn = block("const loadVisibleRooms = () => {", "let scrollDebounceTimer");
    expect(fn).toContain("if (props.active && clientHeight > 0) chatStore.setVisibleSidebarRooms(visibleIds, visibleRowsOwner)");
    const soon = block("const reportVisibleRoomsSoon = () => {", "/** Calculate which rooms are visible");
    expect(soon).toContain("!props.active");
  });

  it("gives up its rows when its tab leaves the screen or the list unmounts", () => {
    expect(source).toMatch(/else chatStore\.releaseVisibleSidebarRooms\(visibleRowsOwner, "hidden"\)/);
    const unmount = block("onUnmounted(() => {", "});");
    expect(unmount).toContain('chatStore.releaseVisibleSidebarRooms(visibleRowsOwner, "unmounted")');
  });

  it("re-reports when the list is shown again or resized (mobile: hidden behind an open chat)", () => {
    expect(source).toMatch(/new ResizeObserver\(\(\) => reportVisibleRoomsSoon\(\)\)/);
    const attach = block("const attachScrollListener = () => {", "onMounted(");
    expect(attach).toContain("resizeObserver?.observe(scrollEl)");
    expect(block("onUnmounted(() => {", "});")).toContain("resizeObserver?.disconnect()");
  });

  it("the sidebar passes which tab is active", () => {
    const sidebar = readFileSync(resolve(__dirname, "../../../widgets/sidebar/ChatSidebar.vue"), "utf-8");
    for (const f of ["all", "personal", "groups", "invites"]) {
      expect(sidebar).toContain(`:active="activeFilter === '${f}'"`);
    }
  });

  it("the reorder report is debounced and only reports rows", () => {
    const fn = block("const reportVisibleRoomsSoon = () => {", "/** Calculate which rooms are visible");
    expect(fn).toMatch(/if \(reportVisibleTimer \|\| !props\.active\) return;/);
    expect(fn).toContain("chatStore.setVisibleSidebarRooms(visibleRange(");
    expect(fn).not.toContain("ensureRoomsLoaded");
    expect(fn).not.toContain("loadProfilesForRoomIds");
  });
});
