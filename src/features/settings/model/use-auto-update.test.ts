import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElectronApiMock } from "@/shared/lib/platform/create-electron-api-mock";
import type { ElectronUpdateState } from "@/shared/types/electron";

describe("useAutoUpdate", () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.electronAPI;
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.resetModules();
  });

  it("is unavailable outside Electron", async () => {
    const { useAutoUpdate } = await import("./use-auto-update");
    expect(useAutoUpdate().isAvailable).toBe(false);
  });

  it("hydrates status and forwards check / install via electronAPI", async () => {
    const listeners: Array<(state: ElectronUpdateState) => void> = [];
    const getUpdateStatus = vi.fn(async (): Promise<ElectronUpdateState> => ({
      status: "idle",
      version: "1.11.0",
      percent: null,
      error: null,
      enabled: true,
    }));
    const checkForUpdates = vi.fn(async (): Promise<ElectronUpdateState> => ({
      status: "checking",
      version: null,
      percent: null,
      error: null,
      enabled: true,
    }));
    const quitAndInstallUpdate = vi.fn(async () => true);
    const onUpdateStatus = vi.fn((cb: (state: ElectronUpdateState) => void) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    });

    window.electronAPI = createElectronApiMock({
      getUpdateStatus,
      checkForUpdates,
      quitAndInstallUpdate,
      onUpdateStatus,
    });

    const { useAutoUpdate } = await import("./use-auto-update");
    const update = useAutoUpdate();
    expect(update.isAvailable).toBe(true);

    await vi.waitFor(() => {
      expect(getUpdateStatus).toHaveBeenCalled();
    });
    expect(update.enabled.value).toBe(true);
    expect(update.version.value).toBe("1.11.0");

    await update.checkForUpdates();
    expect(checkForUpdates).toHaveBeenCalled();
    expect(update.status.value).toBe("checking");
    expect(update.isBusy.value).toBe(true);

    for (const cb of listeners) {
      cb({
        status: "downloaded",
        version: "1.12.0",
        percent: 100,
        error: null,
        enabled: true,
      });
    }
    expect(update.status.value).toBe("downloaded");
    expect(update.canInstall.value).toBe(true);
    expect(update.version.value).toBe("1.12.0");

    await update.quitAndInstall();
    expect(quitAndInstallUpdate).toHaveBeenCalled();
  });
});
