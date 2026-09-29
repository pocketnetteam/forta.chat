import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Room-open wiring in MessageList (plan 2026-09-28-chat-open-local-first,
 * stage 1). The branching itself is covered by room-open-load.test.ts; these
 * source-level checks pin the template/watcher glue — mounting MessageList
 * pulls in most of the app's stores for a handful of attributes.
 */
const source = readFileSync(resolve(__dirname, "../MessageList.vue"), "utf-8").replace(/\r\n/g, "\n");
const template = source.slice(source.indexOf("<template>"));
const scrollerTag = template.slice(
  template.indexOf("<ChatVirtualScroller"),
  template.indexOf(">", template.indexOf("<ChatVirtualScroller")),
);

describe("MessageList — room open", () => {
  it("keeps the scroller mounted while loading (white-screen regression)", () => {
    expect(scrollerTag).not.toMatch(/v-if=/);
    expect(scrollerTag).toMatch(/opacity: settled \? 1 : 0/);
  });

  it("shows a retry state instead of the skeleton once the network budget is spent", () => {
    expect(template).toMatch(/<MessageSkeleton\s+v-if="!networkTimedOut &&/);
    expect(template).toMatch(/v-if="networkTimedOut && !loading && chatStore\.activeMessages\.length === 0"/);
    expect(template).toMatch(/@click="handleRetryOpen"/);
  });

  it("routes the first screen through runRoomOpenLoad, with no 2s liveQuery race", () => {
    expect(source).toMatch(/await runRoomOpenLoad\(/);
    expect(source).not.toMatch(/waitForRoomMessages\(roomId, 2000\)/);
    expect(source).not.toMatch(/waitForDexieReady/);
  });

  it("starts the background refresh only after the reveal", () => {
    const openStart = source.indexOf("const openRoom = async");
    const loadCall = source.indexOf("await runRoomOpenLoad(", openStart);
    const afterOpen = source.slice(openStart);
    const revealMatch = /settled\.value = true;\s+switching\.value = false;\s+checkScroll\(\);/.exec(afterOpen);
    const reveal = revealMatch ? openStart + revealMatch.index : -1;
    const refresh = source.indexOf("afterReveal();", reveal);
    expect(loadCall).toBeGreaterThan(openStart);
    expect(reveal).toBeGreaterThan(loadCall);
    expect(refresh).toBeGreaterThan(reveal);
  });

  it("runs the background refresh once even when the safety reveal and rAF both fire", () => {
    expect(source).toMatch(/if \(afterRevealDone\) return;/);
    expect(source.match(/afterReveal\(\);/g)?.length).toBe(2);
  });

  it("keeps the skeleton, not the empty state, while a cached open waits for its first read", () => {
    expect(template).toMatch(/<MessageSkeleton\s+v-if="[^"]*isCachedEmissionPending/);
    expect(template).toMatch(/v-if="!networkTimedOut && !isCachedEmissionPending && !loading/);
  });

  it("a cached open only queues a backfill when Dexie history is not continuous (stage 3)", () => {
    const body = source.slice(source.indexOf("const refreshInBackground = async"));
    const branch = body.slice(0, body.indexOf("if (isStale()) return;\n    if (isCacheLikelyStale"));
    expect(branch).toMatch(/await chatStore\.refreshOpenedRoom\(roomId\)/);
    expect(branch).not.toMatch(/loadMessages\(roomId\)/);
  });

  it("shows the updating pill while the backfill works on the open room", () => {
    expect(template).toMatch(/!!chatStore\.activeRoomId && chatStore\.backfillActiveRoomId === chatStore\.activeRoomId/);
  });

  it("goes straight to the reveal when the room's snapshot is already on screen (stage 4)", () => {
    const open = source.slice(source.indexOf("const openRoom = async"));
    expect(open).toMatch(/\} else if \(hasValidMessages\) \{[\s\S]*?openResult = \{ branch: "cached", networkTimedOut: false \};/);
  });

  it("reveals a snapshot at once unless an unread banner needs scrolling to", () => {
    expect(source).toMatch(/settled\.value = chatStore\.activeMessages\[0\]\?\.roomId === roomId\s+&& !\(\(chatStore\.getPreOpenUnreadCount\(roomId\) \?\? 0\) > 0\);/);
  });

  it("with unread messages waiting, a snapshot does not replace the real read (stage 4)", () => {
    expect(source).toMatch(/&& !\(chatStore\.isShowingSnapshot && hasPreOpenUnread\);/);
    expect(source).toMatch(/chatStore\.activeMessagesRoomId === roomId && !chatStore\.isShowingSnapshot/);
  });
});

