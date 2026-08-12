import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: ChatInfoPanel rendered every room.members entry as a DOM row
 * with no cap. Private/group rooms stay small (E2E encryption already caps
 * them under 50 — canBeEncrypt()), but public/shareable-by-link rooms are
 * typically large channels (hundreds/thousands of members) — rendering them
 * all froze scrolling on low-end Android, and each row's UserAvatar
 * independently fetches its own profile on scroll-into-view, so opening the
 * panel alone could queue up hundreds of fetches.
 *
 * Fix: cap the rendered list to 50 and show "and N more" instead of the
 * remaining rows. Gated on `roomShareable` (not the narrower `roomPublic`)
 * so Bastyon world_readable broadcast channels — which commonly keep
 * join_rule="invite" but are still effectively public, see roomShareable's
 * own doc comment — get the same cap; private/group rooms are unaffected —
 * visibleMembers falls back to the full (already-small) list.
 *
 * Source verification — this component is a 1200+ line SFC; a full mount
 * would need the same scale of mocking as ChatWindow.test.ts. The computed
 * logic here is pure (slice/length math), so asserting its shape directly
 * is more direct than reconstructing that mock surface.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../ChatInfoPanel.vue"), "utf-8");

describe("ChatInfoPanel — member list capped for shareable-by-link rooms", () => {
  it("visibleMembers falls back to the full list for non-shareable rooms", () => {
    const source = getSource();
    const start = source.indexOf("const visibleMembers = computed(() => {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("});", start);
    const section = source.slice(start, end);
    expect(section).toContain("if (!roomShareable.value || isAdmin.value) return room.value.members;");
  });

  it("visibleMembers slices to MEMBER_LIST_CAP (50) for shareable rooms", () => {
    const source = getSource();
    expect(source).toMatch(/const MEMBER_LIST_CAP = 50;/);
    const start = source.indexOf("const visibleMembers = computed(() => {");
    const end = source.indexOf("});", start);
    const section = source.slice(start, end);
    expect(section).toContain("room.value.members.slice(0, MEMBER_LIST_CAP)");
  });

  it("hiddenMemberCount is 0 for non-shareable rooms", () => {
    const source = getSource();
    const start = source.indexOf("const hiddenMemberCount = computed(() => {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("});", start);
    const section = source.slice(start, end);
    expect(section).toContain("if (!room.value || !roomShareable.value || isAdmin.value) return 0;");
  });

  it("does not cap the member list for an admin of this room", () => {
    // Regression (review): capping unconditionally removed the only UI path
    // to kick/mute/promote a member beyond position 50 — the panel's search
    // box only finds NEW users to invite, not a filter over existing
    // members, so an admin of a large room would permanently lose the
    // ability to manage anyone past the cap.
    const source = getSource();
    const visStart = source.indexOf("const visibleMembers = computed(() => {");
    const visEnd = source.indexOf("});", visStart);
    expect(source.slice(visStart, visEnd)).toContain("isAdmin.value");

    const hiddenStart = source.indexOf("const hiddenMemberCount = computed(() => {");
    const hiddenEnd = source.indexOf("});", hiddenStart);
    expect(source.slice(hiddenStart, hiddenEnd)).toContain("isAdmin.value");
  });

  it("hiddenMemberCount uses the authoritative server member count, not just room.members.length", () => {
    // Regression: room.members can be a partial list right after opening a
    // room (full member state still landing via /sync) — using its raw
    // .length alone would undercount (or hide entirely) the "and N more"
    // banner for a large room the client hasn't fully synced yet.
    const source = getSource();
    const start = source.indexOf("const hiddenMemberCount = computed(() => {");
    const end = source.indexOf("});", start);
    const section = source.slice(start, end);
    expect(section).toContain("chatStore.getRoomMemberCount(room.value.id)");
    expect(section).toContain("Math.max(0, totalCount - visibleMembers.value.length)");
  });

  it("visibleMembers always includes the current user's own row, even past the cap", () => {
    // Regression (review): member order is server/insertion order, not
    // sorted — a non-admin ranked past position 50 in a large room would
    // silently lose their OWN row (and the rename/mute/admin badges gated on
    // `member === myHexId`) with a plain positional slice.
    const source = getSource();
    const start = source.indexOf("const visibleMembers = computed(() => {");
    const end = source.indexOf("});", start);
    const section = source.slice(start, end);
    expect(section).toContain("const self = myHexId.value;");
    expect(section).toContain("!capped.includes(self)");
    expect(section).toContain("return [...capped, self];");
  });

  it("the joined-members template loop iterates visibleMembers, not the raw member list", () => {
    const source = getSource();
    expect(source).toMatch(/v-for="member in visibleMembers"/);
    expect(source).not.toMatch(/v-for="member in room\.members"/);
  });

  it("renders an 'and N more' line gated on hiddenMemberCount", () => {
    const source = getSource();
    const idx = source.indexOf('v-if="hiddenMemberCount > 0"');
    expect(idx).toBeGreaterThan(-1);
    const section = source.slice(idx, idx + 300);
    expect(section).toContain('t("info.andNMore", { count: hiddenMemberCount })');
  });
});
