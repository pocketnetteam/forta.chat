import { afterEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn(() => "web");
const registerPlugin = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => getPlatform(),
    isNativePlatform: () => getPlatform() !== "web",
  },
  registerPlugin: (...args: unknown[]) => registerPlugin(...args),
}));

describe("resolveAppUpdaterEnabled", () => {
  afterEach(() => {
    getPlatform.mockReset();
    getPlatform.mockReturnValue("web");
    registerPlugin.mockReset();
    vi.resetModules();
  });

  it("returns false on non-Android platforms", async () => {
    getPlatform.mockReturnValue("web");
    const { resolveAppUpdaterEnabled } = await import(
      "./resolve-app-updater-enabled"
    );
    await expect(resolveAppUpdaterEnabled()).resolves.toBe(false);
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("returns false on iOS", async () => {
    getPlatform.mockReturnValue("ios");
    const { resolveAppUpdaterEnabled } = await import(
      "./resolve-app-updater-enabled"
    );
    await expect(resolveAppUpdaterEnabled()).resolves.toBe(false);
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("returns true when Android sideload plugin reports enabled", async () => {
    getPlatform.mockReturnValue("android");
    registerPlugin.mockReturnValue({
      isEnabled: vi.fn(async () => ({ enabled: true })),
      checkForUpdate: vi.fn(),
    });
    const { resolveAppUpdaterEnabled } = await import(
      "./resolve-app-updater-enabled"
    );
    await expect(resolveAppUpdaterEnabled()).resolves.toBe(true);
  });

  it("returns false when Android Play plugin reports disabled", async () => {
    getPlatform.mockReturnValue("android");
    registerPlugin.mockReturnValue({
      isEnabled: vi.fn(async () => ({ enabled: false })),
      checkForUpdate: vi.fn(),
    });
    const { resolveAppUpdaterEnabled } = await import(
      "./resolve-app-updater-enabled"
    );
    await expect(resolveAppUpdaterEnabled()).resolves.toBe(false);
  });

  it("returns false when AppUpdater plugin is not registered (Play)", async () => {
    getPlatform.mockReturnValue("android");
    registerPlugin.mockReturnValue({
      isEnabled: vi.fn(async () => {
        throw new Error("AppUpdater does not have web implementation");
      }),
      checkForUpdate: vi.fn(),
    });
    const { resolveAppUpdaterEnabled } = await import(
      "./resolve-app-updater-enabled"
    );
    await expect(resolveAppUpdaterEnabled()).resolves.toBe(false);
  });
});
