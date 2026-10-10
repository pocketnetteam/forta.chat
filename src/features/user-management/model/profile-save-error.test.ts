import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { en } from "@/shared/lib/i18n/locales/en";
import { ru } from "@/shared/lib/i18n/locales/ru";
import { profileSaveErrorKey } from "./profile-save-error";

/** Audit W2A-04: the profile form always said "check your connection". */
describe("profileSaveErrorKey", () => {
  it("names the reason editUserData reported", () => {
    expect(profileSaveErrorKey("timeout")).toBe("profile.saveFailedTimeout");
    expect(profileSaveErrorKey("rejected")).toBe("profile.saveFailedRejected");
    expect(profileSaveErrorKey("network")).toBe("profile.saveFailed");
    expect(profileSaveErrorKey(undefined)).toBe("profile.saveFailed");
  });

  it("has every message in both locales", () => {
    for (const key of ["profile.saveFailedTimeout", "profile.saveFailedRejected", "profile.saveFailed"] as const) {
      expect(en[key], key).toBeTruthy();
      expect(ru[key], key).toBeTruthy();
    }
  });

  it("is what UserEditForm shows for a failed save", () => {
    const form = readFileSync(resolve(__dirname, "../ui/UserEditForm.vue"), "utf-8");
    expect(form).toContain("profileSaveErrorKey(");
    expect(form).not.toMatch(/saveError\.value = t\("profile\.saveFailed"\);/);
  });
});
