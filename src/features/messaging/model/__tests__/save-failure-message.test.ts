// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";

vi.mock("@/entities/auth", () => ({ useAuthStore: () => ({}) }));
vi.mock("@/features/bug-report", () => ({ useBugReport: () => ({ open: vi.fn() }) }));

const { saveFailureMessageKey } = await import("../use-file-download");

/** Audit S4-04: a refused storage permission on Android 7-9 read as a bare "failed". */
describe("saveFailureMessageKey", () => {
  it("names a refused storage permission", () => {
    expect(saveFailureMessageKey(new Error("STORAGE_PERMISSION_DENIED"))).toBe("media.savePermissionDenied");
    expect(saveFailureMessageKey({ code: "STORAGE_PERMISSION_DENIED", message: "x" })).toBe("media.savePermissionDenied");
  });

  it("keeps the generic message otherwise", () => {
    expect(saveFailureMessageKey(new Error("save failed: disk full"))).toBe("media.saveFailed");
    expect(saveFailureMessageKey(undefined)).toBe("media.saveFailed");
  });
});
