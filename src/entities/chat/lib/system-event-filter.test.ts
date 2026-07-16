import { describe, it, expect } from "vitest";
import {
  getModeratorChange,
  isServiceRoomName,
  isWithinCreationBurst,
  isCreationBurstMemberEvent,
  ROOM_CREATION_BURST_WINDOW_MS,
} from "./system-event-filter";

/**
 * WEE-99 — regression: noisy system events at chat start.
 *
 * At room creation the timeline contained a burst of system messages
 * ("joined" / "changed room permissions" ×2 / "updated the room" /
 * "invited"). These helpers reproduce bastyon-chat's filtering:
 * power_levels render only on a real moderator diff, service hash names
 * and the creation burst are hidden.
 */

describe("getModeratorChange (m.room.power_levels diff)", () => {
  it("без prev_content (initial power_levels при создании) → null", () => {
    expect(getModeratorChange({ users: { "@a:m": 100 } }, undefined)).toBeNull();
  });

  it("prev_content есть, но users без изменений → null", () => {
    const users = { "@a:m": 100, "@b:m": 0 };
    expect(getModeratorChange({ users }, { users: { ...users } })).toBeNull();
  });

  it("изменение не-user настроек (events) без diff users → null", () => {
    expect(
      getModeratorChange(
        { users: { "@a:m": 100 }, events: { "m.room.name": 50 } },
        { users: { "@a:m": 100 }, events: { "m.room.name": 100 } },
      ),
    ).toBeNull();
  });

  it("повышение до 50 → promoted moderator", () => {
    const change = getModeratorChange(
      { users: { "@a:m": 100, "@b:m": 50 } },
      { users: { "@a:m": 100, "@b:m": 0 } },
    );
    expect(change).toEqual({ userId: "@b:m", promoted: true });
  });

  it("снятие с 50 до 0 → unmarked moderator", () => {
    const change = getModeratorChange(
      { users: { "@a:m": 100, "@b:m": 0 } },
      { users: { "@a:m": 100, "@b:m": 50 } },
    );
    expect(change).toEqual({ userId: "@b:m", promoted: false });
  });

  it("удаление модератора из users map → unmarked (level падает к default)", () => {
    const change = getModeratorChange(
      { users: { "@a:m": 100 } },
      { users: { "@a:m": 100, "@b:m": 50 } },
    );
    expect(change).toEqual({ userId: "@b:m", promoted: false });
  });

  it("prevLevel берётся из prev_content.users_default, а не из нового default", () => {
    // в prev default был 50 (все модераторы), в новом 0; @b:m явно понижен до 0
    const change = getModeratorChange(
      { users: { "@a:m": 100, "@b:m": 0 }, users_default: 0 },
      { users: { "@a:m": 100 }, users_default: 50 },
    );
    expect(change).toEqual({ userId: "@b:m", promoted: false });
  });

  it("self-demote админа (100 → 0) → unmarked для самого себя", () => {
    const change = getModeratorChange(
      { users: { "@a:m": 0 } },
      { users: { "@a:m": 100 } },
    );
    expect(change).toEqual({ userId: "@a:m", promoted: false });
  });

  it("изменение уровня ниже порога модератора (0 → 25) → null", () => {
    expect(
      getModeratorChange(
        { users: { "@a:m": 100, "@b:m": 25 } },
        { users: { "@a:m": 100, "@b:m": 0 } },
      ),
    ).toBeNull();
  });
});

describe("isServiceRoomName (m.room.name hash/empty)", () => {
  it("hex-хэш при создании комнаты → служебное имя", () => {
    expect(isServiceRoomName("a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBe(true);
    expect(isServiceRoomName("#a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBe(true);
  });

  it("пустое имя → служебное", () => {
    expect(isServiceRoomName("")).toBe(true);
  });

  it("реальное имя комнаты → не служебное (changedName показывается)", () => {
    expect(isServiceRoomName("Команда Forta")).toBe(false);
    expect(isServiceRoomName("deadbeef")).toBe(false); // короткий hex — обычное имя
  });
});

describe("isWithinCreationBurst", () => {
  const createTs = 1_700_000_000_000;

  it("событие сразу после m.room.create → в burst-окне", () => {
    expect(isWithinCreationBurst(createTs + 1_000, createTs)).toBe(true);
  });

  it("событие чуть раньше m.room.create (часы рассинхронены) → в окне", () => {
    expect(isWithinCreationBurst(createTs - 1_000, createTs)).toBe(true);
  });

  it("событие позже окна → не burst", () => {
    expect(
      isWithinCreationBurst(createTs + ROOM_CREATION_BURST_WINDOW_MS + 1, createTs),
    ).toBe(false);
  });

  it("creation ts неизвестен → не скрывать", () => {
    expect(isWithinCreationBurst(createTs, null)).toBe(false);
  });
});

describe("isCreationBurstMemberEvent", () => {
  const createTs = 1_700_000_000_000;
  const inWindow = createTs + 1_000;
  const later = createTs + ROOM_CREATION_BURST_WINDOW_MS + 60_000;

  it("own-join создателя в окне создания → скрыть", () => {
    expect(isCreationBurstMemberEvent("join", true, inWindow, createTs)).toBe(true);
  });

  it("начальный invite в окне создания → скрыть", () => {
    expect(isCreationBurstMemberEvent("invite", false, inWindow, createTs)).toBe(true);
  });

  it("invite позже (реальное добавление участника) → показывать", () => {
    expect(isCreationBurstMemberEvent("invite", false, later, createTs)).toBe(false);
  });

  it("join другого участника позже → показывать", () => {
    expect(isCreationBurstMemberEvent("join", true, later, createTs)).toBe(false);
  });

  it("leave даже в окне создания → показывать", () => {
    expect(isCreationBurstMemberEvent("leave", true, inWindow, createTs)).toBe(false);
  });
});
