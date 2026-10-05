import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: `item.index` is a position in the deduped timeline, but the
 * avatar / first-in-group checks looked neighbours up in the raw store list,
 * which holds every collapsed and deleted call record too — after one such
 * record every later message compared the wrong neighbours.
 */
const source = readFileSync(resolve(__dirname, "../MessageList.vue"), "utf-8");

describe("MessageList neighbour lookups", () => {
  it("index into the same list item.index points into", () => {
    expect(source).toMatch(/const timelineMessages = computed\(\(\) => dedupeCallEvents\(chatStore\.activeMessages\)\)/);
    expect(source).toMatch(/const msgs = timelineMessages\.value;/);
    expect(source).not.toMatch(/chatStore\.activeMessages\[\(item\.index/);
    expect(source).toMatch(/timelineMessages\[\(item\.index \?\? 0\) \+ 1\]/);
    expect(source).toMatch(/timelineMessages\[\(item\.index \?\? 0\) - 1\]/);
  });
});

/**
 * Regression: a read watermark on a call record the timeline drops (a deleted
 * record, a collapsed hangup whose survivor is deleted) found no row, so the
 * unread banner never rendered. The anchor resolves against the shown rows.
 */
describe("MessageList unread banner anchor", () => {
  it("resolves the watermark against the shown rows and handles no earlier row", () => {
    expect(source).toMatch(/timelineAnchorFor\(rawMsgs, msgs, watermarkId\)/);
    expect(source).toMatch(/let bannerPending = hasUnread && frozenLastReadId === null;/);
    expect(source).not.toMatch(/collapsedCallEventIds/);
  });
});
