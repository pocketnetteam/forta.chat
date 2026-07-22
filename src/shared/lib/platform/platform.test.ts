import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createElectronApiMock,
  createFetchBridgeMock,
} from "./create-electron-api-mock";

describe("createElectronApiMock (preload contract)", () => {
  it("exposes the same surface as electron/preload.cjs electronAPI", () => {
    const api = createElectronApiMock();
    expect(api.isElectron).toBe(true);
    expect(typeof api.platform).toBe("string");
    expect(typeof api.minimize).toBe("function");
    expect(typeof api.maximize).toBe("function");
    expect(typeof api.close).toBe("function");
    expect(typeof api.show).toBe("function");
    expect(typeof api.onMaximized).toBe("function");
    expect(typeof api.onUnmaximized).toBe("function");
    expect(typeof api.torSetMode).toBe("function");
    expect(typeof api.torConfigure).toBe("function");
    expect(typeof api.torGetStatus).toBe("function");
    expect(typeof api.onTorStatus).toBe("function");
    expect(typeof api.saveFile).toBe("function");
    expect(typeof api.getDesktopSettings).toBe("function");
    expect(typeof api.setDesktopSettings).toBe("function");
    expect(typeof api.setBadgeCount).toBe("function");
    expect(typeof api.setZoomFactor).toBe("function");
    expect(typeof api.getZoomFactor).toBe("function");
    expect(typeof api.onDeepLink).toBe("function");
  });

  it("allows overriding saveFile for download tests", async () => {
    const saveFile = vi.fn(async () => "/tmp/out.pdf");
    const api = createElectronApiMock({ saveFile });
    await expect(api.saveFile("out.pdf", new ArrayBuffer(0))).resolves.toBe(
      "/tmp/out.pdf",
    );
    expect(saveFile).toHaveBeenCalledOnce();
  });
});

describe("createFetchBridgeMock (preload contract)", () => {
  it("exposes send / on / invoke like preload fetchBridge", () => {
    const bridge = createFetchBridgeMock();
    expect(typeof bridge.send).toBe("function");
    expect(typeof bridge.on).toBe("function");
    expect(typeof bridge.invoke).toBe("function");
  });
});

describe("platform helpers", () => {
  afterEach(() => {
    delete window.electronAPI;
    delete window.fetchBridge;
    vi.resetModules();
  });

  it("getElectronAPI returns undefined outside Electron", async () => {
    const { getElectronAPI, isElectron, isWeb, hasTor, currentPlatform } =
      await import("./index");
    expect(getElectronAPI()).toBeUndefined();
    expect(isElectron).toBe(false);
    expect(isWeb).toBe(true);
    expect(hasTor).toBe(false);
    expect(currentPlatform).toBe("web");
  });

  it("detects Electron when preload API is present", async () => {
    window.electronAPI = createElectronApiMock({ platform: "linux" });
    const { getElectronAPI, isElectron, isWeb, hasTor, currentPlatform } =
      await import("./index");
    expect(getElectronAPI()?.isElectron).toBe(true);
    expect(getElectronAPI()?.platform).toBe("linux");
    expect(isElectron).toBe(true);
    expect(isWeb).toBe(false);
    expect(hasTor).toBe(true);
    expect(currentPlatform).toBe("electron");
  });
});
