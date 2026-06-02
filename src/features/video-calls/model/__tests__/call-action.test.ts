import { describe, it, expect } from "vitest";
import { resolveCallAction, buildPickerOptions } from "../call-action";
import type { CallProvider } from "@/shared/lib/local-db";

function provider(overrides: Partial<CallProvider> = {}): CallProvider {
  return {
    id: Math.floor(Math.random() * 1e6),
    label: "Zoom",
    urlTemplate: "https://zoom.us/j/1",
    ...overrides,
  };
}

describe("resolveCallAction", () => {
  it("DM, no providers → native (backward compatible)", () => {
    expect(resolveCallAction({ providers: [], isDm: true })).toEqual({ type: "native" });
  });

  it("DM, one provider → menu [native, link]", () => {
    const action = resolveCallAction({ providers: [provider()], isDm: true });
    expect(action.type).toBe("picker");
    if (action.type === "picker") {
      expect(action.options).toHaveLength(2);
      expect(action.options[0]).toEqual({ type: "native" });
    }
  });

  it("DM, two providers → menu [native, link, link]", () => {
    const action = resolveCallAction({
      providers: [provider({ label: "A" }), provider({ label: "B" })],
      isDm: true,
    });
    expect(action.type).toBe("picker");
    if (action.type === "picker") expect(action.options).toHaveLength(3);
  });

  it("group, one provider → send it directly (no 1-item menu)", () => {
    const p = provider({ label: "Jitsi" });
    expect(resolveCallAction({ providers: [p], isDm: false })).toEqual({ type: "send", provider: p });
  });

  it("group, two providers → menu (external only)", () => {
    const action = resolveCallAction({
      providers: [provider({ label: "A" }), provider({ label: "B" })],
      isDm: false,
    });
    expect(action.type).toBe("picker");
    if (action.type === "picker") {
      expect(action.options).toHaveLength(2);
      expect(action.options.every((o) => o.type === "external")).toBe(true);
    }
  });

  it("group, no providers → native (defensive fallback)", () => {
    expect(resolveCallAction({ providers: [], isDm: false })).toEqual({ type: "native" });
  });
});

describe("buildPickerOptions", () => {
  it("DM includes native first, then externals", () => {
    const opts = buildPickerOptions([provider({ label: "A" }), provider({ label: "B" })], true);
    expect(opts).toHaveLength(3);
    expect(opts[0]).toEqual({ type: "native" });
    expect(opts[1].type).toBe("external");
  });

  it("group shows external only — no native", () => {
    const opts = buildPickerOptions([provider({ label: "A" }), provider({ label: "B" })], false);
    expect(opts).toHaveLength(2);
    expect(opts.every((o) => o.type === "external")).toBe(true);
  });
});
