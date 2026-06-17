import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * WEE-99 — source-level regression: buildSystemMessage must route noisy
 * room-setup events through the system-event-filter helpers instead of
 * unconditionally emitting system messages.
 *
 * Behavioral coverage of the filters lives in
 * `../../lib/system-event-filter.test.ts`; these tests pin the wiring in
 * chat-store.ts so it can't silently regress to the old unconditional
 * templates ("changed room permissions" / "updated the room" burst).
 */

const chatStoreSource = readFileSync(
  resolve(__dirname, "../chat-store.ts"),
  "utf-8",
);

const enLocale = readFileSync(
  resolve(__dirname, "../../../../shared/lib/i18n/locales/en.ts"),
  "utf-8",
);
const ruLocale = readFileSync(
  resolve(__dirname, "../../../../shared/lib/i18n/locales/ru.ts"),
  "utf-8",
);

const buildSystemMessageBody = (() => {
  const start = chatStoreSource.indexOf("const buildSystemMessage = (");
  expect(start).toBeGreaterThan(-1);
  // The next top-level helper after buildSystemMessage:
  const end = chatStoreSource.indexOf("const parseSingleEvent = ", start);
  return chatStoreSource.slice(start, end > -1 ? end : undefined);
})();

describe("buildSystemMessage wiring (WEE-99)", () => {
  it("импортирует фильтры из system-event-filter", () => {
    expect(chatStoreSource).toContain('from "../lib/system-event-filter"');
    expect(chatStoreSource).toContain("getModeratorChange");
    expect(chatStoreSource).toContain("isServiceRoomName");
    expect(chatStoreSource).toContain("isCreationBurstMemberEvent");
  });

  it("m.room.power_levels не эмитит безусловный system.changedPermissions", () => {
    expect(buildSystemMessageBody).not.toContain('"system.changedPermissions"');
    expect(buildSystemMessageBody).toContain("getModeratorChange(");
    expect(buildSystemMessageBody).toContain('"system.markedModerator"');
    expect(buildSystemMessageBody).toContain('"system.unmarkedModerator"');
  });

  it("модераторские шаблоны сохраняют {target} даже при self-demote (target === sender)", () => {
    expect(buildSystemMessageBody).toContain("keepSelfTarget = true");
    expect(buildSystemMessageBody).toContain("targetAddr !== sender || keepSelfTarget");
  });

  it("prev_content читается с фолбэком на deprecated top-level поле", () => {
    expect(buildSystemMessageBody).toContain("raw.prev_content");
  });

  it("m.room.name с hash/empty не эмитит system.updatedRoom (скрывается)", () => {
    expect(buildSystemMessageBody).not.toContain('"system.updatedRoom"');
    expect(buildSystemMessageBody).toContain("isServiceRoomName(");
    // реальная смена имени по-прежнему показывается
    expect(buildSystemMessageBody).toContain('"system.changedName"');
  });

  it("member join/invite в окне создания скрываются через isCreationBurstMemberEvent", () => {
    expect(buildSystemMessageBody).toContain("isCreationBurstMemberEvent(");
    // обычные membership-события сохранены
    expect(buildSystemMessageBody).toContain('"system.joined"');
    expect(buildSystemMessageBody).toContain('"system.invited"');
    expect(buildSystemMessageBody).toContain('"system.left"');
  });

  it("m.room.avatar в окне создания скрывается, позже — показывается", () => {
    expect(buildSystemMessageBody).toContain('"system.changedPhoto"');
    expect(buildSystemMessageBody).toContain("isWithinCreationBurst(");
  });
});

describe("i18n ключи модератора (WEE-99)", () => {
  it.each([
    ["en", enLocale],
    ["ru", ruLocale],
  ])("%s содержит system.markedModerator / system.unmarkedModerator", (_name, src) => {
    expect(src).toContain('"system.markedModerator"');
    expect(src).toContain('"system.unmarkedModerator"');
  });
});
