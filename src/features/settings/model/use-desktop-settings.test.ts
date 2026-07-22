import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElectronApiMock } from "@/shared/lib/platform/create-electron-api-mock";

describe("useDesktopSettings", () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.electronAPI;
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.resetModules();
  });

  it("is unavailable outside Electron", async () => {
    const { useDesktopSettings } = await import("./use-desktop-settings");
    const { isAvailable } = useDesktopSettings();
    expect(isAvailable).toBe(false);
  });

  it("hydrates and persists closeToTray / openAtLogin via electronAPI", async () => {
    const getDesktopSettings = vi.fn(async () => ({
      closeToTray: false,
      openAtLogin: true,
    }));
    const setDesktopSettings = vi.fn(async (patch: {
      closeToTray?: boolean;
      openAtLogin?: boolean;
    }) => ({
      closeToTray: patch.closeToTray ?? false,
      openAtLogin: patch.openAtLogin ?? true,
    }));

    window.electronAPI = createElectronApiMock({
      getDesktopSettings,
      setDesktopSettings,
    });

    const { useDesktopSettings } = await import("./use-desktop-settings");
    const settings = useDesktopSettings();
    expect(settings.isAvailable).toBe(true);

    await vi.waitFor(() => {
      expect(getDesktopSettings).toHaveBeenCalled();
    });
    expect(settings.closeToTray.value).toBe(false);
    expect(settings.openAtLogin.value).toBe(true);

    await settings.setCloseToTray(true);
    expect(setDesktopSettings).toHaveBeenCalledWith({ closeToTray: true });
    expect(settings.closeToTray.value).toBe(true);

    await settings.setOpenAtLogin(false);
    expect(setDesktopSettings).toHaveBeenCalledWith({ openAtLogin: false });
    expect(settings.openAtLogin.value).toBe(false);
  });
});
