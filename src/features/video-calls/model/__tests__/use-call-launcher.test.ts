import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CallProvider } from "@/shared/lib/local-db";

// ── Mocks ────────────────────────────────────────────────────────────
const startCall = vi.fn();
const sendCallLink = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
const providersRef: { value: CallProvider[] } = { value: [] };

vi.mock("../call-service", () => ({
  useCallService: () => ({ startCall }),
}));
vi.mock("../send-call-link", () => ({
  sendCallLink: (...args: unknown[]) => sendCallLink(...args),
}));
vi.mock("@/shared/lib/local-db", () => ({
  isChatDbReady: () => true,
  getChatDb: () => ({ callProviders: { toArray: async () => providersRef.value } }),
}));

import { useCallLauncher } from "../use-call-launcher";

function provider(overrides: Partial<CallProvider> = {}): CallProvider {
  return { id: 1, label: "Zoom", urlTemplate: "https://zoom.us/j/1", ...overrides };
}

describe("useCallLauncher", () => {
  beforeEach(() => {
    startCall.mockClear();
    sendCallLink.mockClear();
    providersRef.value = [];
  });

  it("DM, no providers → native call", async () => {
    const l = useCallLauncher();
    await l.launch("!room:s", "voice", true);
    expect(startCall).toHaveBeenCalledWith("!room:s", "voice");
    expect(sendCallLink).not.toHaveBeenCalled();
    expect(l.pickerOpen.value).toBe(false);
  });

  it("DM, one provider → opens menu with native + link", async () => {
    providersRef.value = [provider()];
    const l = useCallLauncher();
    await l.launch("!room:s", "voice", true);
    expect(l.pickerOpen.value).toBe(true);
    expect(l.pickerOptions.value).toHaveLength(2);
    expect(l.pickerOptions.value[0]).toEqual({ type: "native" });
    expect(startCall).not.toHaveBeenCalled();
    expect(sendCallLink).not.toHaveBeenCalled();
  });

  it("group, one provider → sends link directly, no menu", async () => {
    const p = provider({ label: "Jitsi" });
    providersRef.value = [p];
    const l = useCallLauncher();
    await l.launch("!group:s", "voice", false);
    expect(sendCallLink).toHaveBeenCalledWith("!group:s", p);
    expect(l.pickerOpen.value).toBe(false);
    expect(startCall).not.toHaveBeenCalled();
  });

  it("group, two providers → menu with external only", async () => {
    providersRef.value = [provider({ label: "A" }), provider({ id: 2, label: "B" })];
    const l = useCallLauncher();
    await l.launch("!group:s", "voice", false);
    expect(l.pickerOpen.value).toBe(true);
    expect(l.pickerOptions.value).toHaveLength(2);
    expect(l.pickerOptions.value.every((o) => o.type === "external")).toBe(true);
  });

  it("picking native from the menu places a native call", async () => {
    providersRef.value = [provider()];
    const l = useCallLauncher();
    await l.launch("!room:s", "voice", true);
    await l.pick({ type: "native" });
    expect(startCall).toHaveBeenCalledWith("!room:s", "voice");
    expect(sendCallLink).not.toHaveBeenCalled();
    expect(l.pickerOpen.value).toBe(false);
  });

  it("picking an external provider sends its link", async () => {
    const meet = provider({ id: 2, label: "Meet" });
    providersRef.value = [provider({ label: "Zoom" }), meet];
    const l = useCallLauncher();
    await l.launch("!room:s", "video", true);
    await l.pick({ type: "external", provider: meet });
    expect(sendCallLink).toHaveBeenCalledWith("!room:s", meet);
    expect(startCall).not.toHaveBeenCalled();
  });
});
