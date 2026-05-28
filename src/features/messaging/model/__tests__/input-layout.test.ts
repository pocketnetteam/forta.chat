import { describe, it, expect } from "vitest";
import { deriveInputLayout } from "../input-layout";

describe("deriveInputLayout — WEE-48 / forta-bugs#593, #515", () => {
  it("hides the dedicated PKOIN shortcut on mobile even when donate is supported", () => {
    const r = deriveInputLayout({ isMobile: true, text: "", showDonate: true });
    expect(r.showDonateShortcut).toBe(false);
  });

  it("keeps the PKOIN shortcut on desktop when donate is supported", () => {
    const r = deriveInputLayout({ isMobile: false, text: "", showDonate: true });
    expect(r.showDonateShortcut).toBe(true);
  });

  it("never shows the PKOIN shortcut when the chat does not support donate", () => {
    expect(deriveInputLayout({ isMobile: false, text: "", showDonate: false }).showDonateShortcut).toBe(false);
    expect(deriveInputLayout({ isMobile: true, text: "", showDonate: false }).showDonateShortcut).toBe(false);
  });

  it("collapses secondary actions on mobile once the textarea has content", () => {
    expect(deriveInputLayout({ isMobile: true, text: " ", showDonate: true }).showSecondaryActions).toBe(true); // whitespace-only collapses to empty
    expect(deriveInputLayout({ isMobile: true, text: "hello", showDonate: true }).showSecondaryActions).toBe(false);
  });

  it("keeps secondary actions on desktop regardless of text", () => {
    expect(deriveInputLayout({ isMobile: false, text: "", showDonate: true }).showSecondaryActions).toBe(true);
    expect(deriveInputLayout({ isMobile: false, text: "long message", showDonate: true }).showSecondaryActions).toBe(true);
  });
});
