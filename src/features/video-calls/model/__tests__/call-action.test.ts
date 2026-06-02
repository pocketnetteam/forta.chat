import { describe, it, expect } from "vitest";
import { resolveCallAction, buildPickerOptions } from "../call-action";
import type { CallProvider } from "@/shared/lib/local-db";

function provider(overrides: Partial<CallProvider> = {}): CallProvider {
  return {
    id: Math.floor(Math.random() * 1e6),
    kind: "zoom",
    label: "Zoom",
    urlTemplate: "https://zoom.us/j/1",
    isDefault: false,
    ...overrides,
  };
}

describe("resolveCallAction", () => {
  it("toggle OFF → native (A6)", () => {
    const action = resolveCallAction({ providers: [provider()], useExternal: false, isDm: true });
    expect(action.type).toBe("native");
  });

  it("no providers → native even when toggle on (A6)", () => {
    const action = resolveCallAction({ providers: [], useExternal: true, isDm: true });
    expect(action.type).toBe("native");
  });

  it("exactly one provider → send it, no picker (A3)", () => {
    const p = provider({ kind: "zoom" });
    const action = resolveCallAction({ providers: [p], useExternal: true, isDm: true });
    expect(action).toEqual({ type: "send", provider: p });
  });

  it("two providers, no default → picker (A4)", () => {
    const action = resolveCallAction({
      providers: [provider({ kind: "zoom" }), provider({ kind: "google_meet" })],
      useExternal: true,
      isDm: true,
    });
    expect(action.type).toBe("picker");
  });

  it("two providers with default → quick-send default (A4)", () => {
    const def = provider({ kind: "jitsi", isDefault: true });
    const action = resolveCallAction({
      providers: [provider({ kind: "zoom" }), def],
      useExternal: true,
      isDm: true,
    });
    expect(action).toEqual({ type: "send", provider: def });
  });

  it("forcePicker overrides default and single-provider quick paths", () => {
    const def = provider({ kind: "jitsi", isDefault: true });
    const action = resolveCallAction({
      providers: [provider({ kind: "zoom" }), def],
      useExternal: true,
      isDm: true,
      forcePicker: true,
    });
    expect(action.type).toBe("picker");
  });
});

describe("buildPickerOptions", () => {
  it("DM includes native first, then externals (A4)", () => {
    const opts = buildPickerOptions([provider({ kind: "zoom" }), provider({ kind: "google_meet" })], true);
    expect(opts).toHaveLength(3);
    expect(opts[0]).toEqual({ type: "native" });
    expect(opts[1].type).toBe("external");
  });

  it("group shows external only — no native (A4b)", () => {
    const opts = buildPickerOptions([provider({ kind: "zoom" }), provider({ kind: "google_meet" })], false);
    expect(opts).toHaveLength(2);
    expect(opts.every((o) => o.type === "external")).toBe(true);
  });
});
