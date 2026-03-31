import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock localStorage
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  removeItem: vi.fn((key: string) => storage.delete(key)),
  clear: vi.fn(() => storage.clear()),
  length: 0,
  key: vi.fn(() => null),
};
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

// Import after mocking localStorage
const { tRaw } = await import("./index");

describe("tRaw", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("returns English text when no locale is set", () => {
    const result = tRaw("push.newMessage");
    expect(result).toBe("New message");
  });

  it("returns Russian text when locale is JSON-encoded 'ru'", () => {
    storage.set("forta-chat:locale", JSON.stringify("ru"));
    const result = tRaw("push.newMessage");
    expect(result).toBe("Новое сообщение");
  });

  it("handles plain string locale (legacy format)", () => {
    storage.set("forta-chat:locale", "ru");
    const result = tRaw("push.newMessage");
    expect(result).toBe("Новое сообщение");
  });

  it("falls back to English for unknown locale", () => {
    storage.set("forta-chat:locale", JSON.stringify("fr"));
    const result = tRaw("push.newMessage");
    expect(result).toBe("New message");
  });

  it("interpolates parameters", () => {
    const result = tRaw("sync.error" as any);
    expect(typeof result).toBe("string");
  });

  it("returns key itself when key not found", () => {
    const result = tRaw("nonexistent.key" as any);
    expect(result).toBe("nonexistent.key");
  });
});
