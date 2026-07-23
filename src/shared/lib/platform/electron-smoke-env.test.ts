import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isElectronSmokeMode,
  resolveTorModeForBoot,
} = require("../../../../electron/smoke-env.cjs") as {
  isElectronSmokeMode: (env?: NodeJS.ProcessEnv) => boolean;
  resolveTorModeForBoot: (
    env?: NodeJS.ProcessEnv,
  ) => "neveruse" | undefined;
};

describe("electron/smoke-env.cjs", () => {
  it("detects FORTA_ELECTRON_SMOKE=1", () => {
    expect(isElectronSmokeMode({ FORTA_ELECTRON_SMOKE: "1" })).toBe(true);
    expect(isElectronSmokeMode({ FORTA_ELECTRON_SMOKE: "0" })).toBe(false);
    expect(isElectronSmokeMode({})).toBe(false);
  });

  it("forces Tor neveruse only in smoke mode", () => {
    expect(resolveTorModeForBoot({ FORTA_ELECTRON_SMOKE: "1" })).toBe(
      "neveruse",
    );
    expect(resolveTorModeForBoot({})).toBeUndefined();
  });
});
