import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref } from "vue";
import type { CallProvider } from "@/shared/lib/local-db";

// ── Mocks ────────────────────────────────────────────────────────────
const startCall = vi.fn();
const sendCallLink = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
const providersRef: { value: CallProvider[] } = { value: [] };
const useExternalProviders = ref(true);

vi.mock("../call-service", () => ({
  useCallService: () => ({ startCall }),
}));
vi.mock("../send-call-link", () => ({
  sendCallLink: (...args: unknown[]) => sendCallLink(...args),
}));
vi.mock("../use-call-provider-settings", () => ({
  useCallProviderSettings: () => ({ useExternalProviders }),
}));
vi.mock("@/shared/lib/local-db", () => ({
  isChatDbReady: () => true,
  getChatDb: () => ({ callProviders: { toArray: async () => providersRef.value } }),
}));

import { useCallLauncher } from "../use-call-launcher";

function provider(overrides: Partial<CallProvider> = {}): CallProvider {
  return { id: 1, kind: "zoom", label: "Zoom", urlTemplate: "https://zoom.us/j/1", isDefault: false, ...overrides };
}

describe("useCallLauncher", () => {
  beforeEach(() => {
    startCall.mockClear();
    sendCallLink.mockClear();
    providersRef.value = [];
    useExternalProviders.value = true;
  });

  it("no providers → native call (A6)", async () => {
    const l = useCallLauncher();
    await l.launch("!room:s", "voice", true);
    expect(startCall).toHaveBeenCalledWith("!room:s", "voice");
    expect(sendCallLink).not.toHaveBeenCalled();
    expect(l.pickerOpen.value).toBe(false);
  });

  it("toggle off → native even with providers (A6)", async () => {
    useExternalProviders.value = false;
    providersRef.value = [provider()];
    const l = useCallLauncher();
    await l.launch("!room:s", "video", true);
    expect(startCall).toHaveBeenCalled();
    expect(sendCallLink).not.toHaveBeenCalled();
  });

  it("one provider → sends link, no native, no picker (A3)", async () => {
    const p = provider({ kind: "zoom" });
    providersRef.value = [p];
    const l = useCallLauncher();
    await l.launch("!room:s", "video", true);
    expect(sendCallLink).toHaveBeenCalledWith("!room:s", p, "video");
    expect(startCall).not.toHaveBeenCalled();
    expect(l.pickerOpen.value).toBe(false);
  });

  it("two providers (no default) → opens picker with native option in DM (A4)", async () => {
    providersRef.value = [provider({ kind: "zoom" }), provider({ id: 2, kind: "google_meet" })];
    const l = useCallLauncher();
    await l.launch("!room:s", "voice", true);
    expect(l.pickerOpen.value).toBe(true);
    expect(l.pickerOptions.value).toHaveLength(3);
    expect(l.pickerOptions.value[0]).toEqual({ type: "native" });
  });

  it("two providers in group → picker has external only (A4b)", async () => {
    providersRef.value = [provider({ kind: "zoom" }), provider({ id: 2, kind: "jitsi" })];
    const l = useCallLauncher();
    await l.launch("!group:s", "voice", false);
    expect(l.pickerOpen.value).toBe(true);
    expect(l.pickerOptions.value).toHaveLength(2);
    expect(l.pickerOptions.value.every((o) => o.type === "external")).toBe(true);
  });

  it("picking native from the picker places a native call", async () => {
    providersRef.value = [provider({ kind: "zoom" }), provider({ id: 2, kind: "google_meet" })];
    const l = useCallLauncher();
    await l.launch("!room:s", "voice", true);
    await l.pick({ type: "native" });
    expect(startCall).toHaveBeenCalledWith("!room:s", "voice");
    expect(sendCallLink).not.toHaveBeenCalled();
    expect(l.pickerOpen.value).toBe(false);
  });

  it("picking an external provider sends its link", async () => {
    const meet = provider({ id: 2, kind: "google_meet" });
    providersRef.value = [provider({ kind: "zoom" }), meet];
    const l = useCallLauncher();
    await l.launch("!room:s", "video", true);
    await l.pick({ type: "external", provider: meet });
    expect(sendCallLink).toHaveBeenCalledWith("!room:s", meet, "video");
    expect(startCall).not.toHaveBeenCalled();
  });

  it("forcePicker opens picker even with a single provider", async () => {
    providersRef.value = [provider({ kind: "zoom" })];
    const l = useCallLauncher();
    await l.launch("!room:s", "voice", true, { forcePicker: true });
    expect(l.pickerOpen.value).toBe(true);
    expect(sendCallLink).not.toHaveBeenCalled();
  });
});
