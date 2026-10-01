import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SIDEBAR_FILTER_STORAGE_KEY,
  isAlwaysVisibleFilter,
  loadSidebarFilter,
  saveSidebarFilter,
} from "../sidebar-filter-storage";

describe("sidebar-filter-storage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("сохранённый фильтр восстанавливается после перезагрузки", () => {
    saveSidebarFilter("groups");
    expect(localStorage.getItem(SIDEBAR_FILTER_STORAGE_KEY)).toBe("groups");
    expect(loadSidebarFilter()).toBe("groups");
  });

  it("без сохранённого значения — all", () => {
    expect(loadSidebarFilter()).toBe("all");
  });

  it("мусор в storage игнорируется", () => {
    localStorage.setItem(SIDEBAR_FILTER_STORAGE_KEY, "archived");
    expect(loadSidebarFilter()).toBe("all");
  });

  it("недоступный storage не ломает ни чтение, ни запись", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadSidebarFilter()).toBe("all");
    expect(() => saveSidebarFilter("personal")).not.toThrow();
  });

  it("invites/channels/ai — условные вкладки, их применяют только когда они появились", () => {
    expect(isAlwaysVisibleFilter("all")).toBe(true);
    expect(isAlwaysVisibleFilter("personal")).toBe(true);
    expect(isAlwaysVisibleFilter("groups")).toBe(true);
    expect(isAlwaysVisibleFilter("invites")).toBe(false);
    expect(isAlwaysVisibleFilter("channels")).toBe(false);
    expect(isAlwaysVisibleFilter("ai")).toBe(false);
  });
});
