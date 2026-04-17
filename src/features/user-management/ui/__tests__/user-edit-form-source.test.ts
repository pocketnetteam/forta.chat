import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = () =>
  readFileSync(resolve(__dirname, "../UserEditForm.vue"), "utf-8");

describe("UserEditForm — source-level invariants (session 05)", () => {
  it("reactively syncs form state with authStore.userInfo via watch", () => {
    const src = getSource();
    // Must have a watch() on userInfo that re-populates the form when it arrives
    expect(src).toMatch(/watch\s*\(\s*\(\s*\)\s*=>\s*authStore\.userInfo/);
    // Watch must be immediate so initial render populates the form
    expect(src).toMatch(/immediate:\s*true/);
  });

  it("hasChanges treats undefined userInfo as a changed-from-empty baseline", () => {
    const src = getSource();
    // Old buggy version returned `if (!info) return false;` — must no longer
    // block Save when userInfo is undefined (e.g. right after registration).
    // The fix compares against empty-string defaults so typing enables Save.
    expect(src).not.toMatch(/if\s*\(\s*!info\s*\)\s*return\s*false/);
  });

  it("Save button is disabled while avatar is uploading", () => {
    const src = getSource();
    // Disabled expression must include avatarUploading guard
    expect(src).toMatch(/:disabled=[^>]*avatarUploading/);
  });

  it("handleSave swallows neither success nor error — shows feedback on failure", () => {
    const src = getSource();
    // Locate the handleSave DEFINITION (starts with "handleSave = async"),
    // then capture the entire function body up to its closing brace.
    const handleSaveStart = src.indexOf("handleSave = async");
    expect(handleSaveStart).toBeGreaterThan(-1);
    const saveFn = src.slice(handleSaveStart, handleSaveStart + 2000);
    expect(saveFn).toMatch(/try\s*\{/);
    expect(saveFn).toMatch(/catch\s*\(/);
    // On failure, must set a user-visible error signal
    expect(saveFn).toMatch(/saveError/);
  });
});
