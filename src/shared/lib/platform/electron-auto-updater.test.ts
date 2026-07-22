import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createUpdateState,
  mapUpdateInfo,
  mapProgress,
} = require("../../../../electron/auto-updater.cjs") as {
  createUpdateState: (patch?: Record<string, unknown>) => {
    status: string;
    version: string | null;
    percent: number | null;
    error: string | null;
    enabled: boolean;
  };
  mapUpdateInfo: (info: { version?: string } | null | undefined) => {
    version: string | null;
  };
  mapProgress: (progress: { percent?: number } | null | undefined) => {
    percent: number;
  };
};

describe("electron/auto-updater.cjs helpers", () => {
  it("createUpdateState merges defaults with patch", () => {
    expect(createUpdateState()).toEqual({
      status: "idle",
      version: null,
      percent: null,
      error: null,
      enabled: false,
    });
    expect(createUpdateState({ enabled: true, status: "checking" })).toMatchObject({
      enabled: true,
      status: "checking",
      version: null,
    });
  });

  it("mapUpdateInfo extracts version safely", () => {
    expect(mapUpdateInfo({ version: "1.12.0" })).toEqual({ version: "1.12.0" });
    expect(mapUpdateInfo({})).toEqual({ version: null });
    expect(mapUpdateInfo(null)).toEqual({ version: null });
    expect(mapUpdateInfo(undefined)).toEqual({ version: null });
  });

  it("mapProgress clamps and rounds percent", () => {
    expect(mapProgress({ percent: 33.333 })).toEqual({ percent: 33.3 });
    expect(mapProgress({ percent: -5 })).toEqual({ percent: 0 });
    expect(mapProgress({ percent: 150 })).toEqual({ percent: 100 });
    expect(mapProgress(null)).toEqual({ percent: 0 });
  });
});
