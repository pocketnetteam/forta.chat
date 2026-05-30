import { describe, it, expect } from "vitest";
import { deriveInputLayout } from "../input-layout";

describe("deriveInputLayout — WEE-48 / forta-bugs#593, #515", () => {
  it("keeps the PKOIN shortcut visible on mobile while the input is idle", () => {
    const r = deriveInputLayout({ isMobile: true, text: "", showDonate: true });
    expect(r.showDonateShortcut).toBe(true);
  });

  it("hides the PKOIN shortcut on mobile as soon as the user starts typing", () => {
    const r = deriveInputLayout({ isMobile: true, text: "hello", showDonate: true });
    expect(r.showDonateShortcut).toBe(false);
  });

  it("keeps the PKOIN shortcut on desktop regardless of text contents", () => {
    expect(deriveInputLayout({ isMobile: false, text: "", showDonate: true }).showDonateShortcut).toBe(true);
    expect(deriveInputLayout({ isMobile: false, text: "long message", showDonate: true }).showDonateShortcut).toBe(true);
  });

  it("never shows the PKOIN shortcut when the chat does not support donate", () => {
    expect(deriveInputLayout({ isMobile: false, text: "", showDonate: false }).showDonateShortcut).toBe(false);
    expect(deriveInputLayout({ isMobile: true, text: "", showDonate: false }).showDonateShortcut).toBe(false);
    expect(deriveInputLayout({ isMobile: true, text: "hi", showDonate: false }).showDonateShortcut).toBe(false);
  });

  it("treats whitespace-only text as idle (matches showSecondaryActions semantics)", () => {
    const r = deriveInputLayout({ isMobile: true, text: "   ", showDonate: true });
    expect(r.showSecondaryActions).toBe(true);
    expect(r.showDonateShortcut).toBe(true);
  });

  it("collapses secondary actions (including PKOIN) on mobile once the user types", () => {
    const r = deriveInputLayout({ isMobile: true, text: "hello", showDonate: true });
    expect(r.showSecondaryActions).toBe(false);
    expect(r.showDonateShortcut).toBe(false);
  });

  it("keeps secondary actions on desktop regardless of text", () => {
    expect(deriveInputLayout({ isMobile: false, text: "", showDonate: true }).showSecondaryActions).toBe(true);
    expect(deriveInputLayout({ isMobile: false, text: "long message", showDonate: true }).showSecondaryActions).toBe(true);
  });
});
