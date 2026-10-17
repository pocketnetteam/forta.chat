import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(__dirname, "../../../..");

const navigation = require("../../../../electron/navigation.cjs") as {
  isExternalUrlAllowed: (url: string) => boolean;
  isAppNavigation: (url: string, appUrl: string) => boolean;
  guardWindowNavigation: (
    webContents: unknown,
    deps: { appUrl: string; openExternal: (url: string) => unknown },
  ) => void;
};
const contextMenu = require("../../../../electron/context-menu.cjs") as {
  contextMenuTemplate: (params: {
    isEditable: boolean;
    selectionText: string;
    editFlags: Record<string, boolean>;
  }) => Array<{ role?: string; enabled?: boolean; type?: string }>;
  isReloadKey: (input: { type: string; key: string; control?: boolean; meta?: boolean; alt?: boolean }) => boolean;
};
const tray = require("../../../../electron/tray.cjs") as {
  trayIconCandidates: (baseDir: string) => string[];
};

const mainSource = readFileSync(resolve(root, "electron/main.cjs"), "utf-8");

/** Audit S10-04: the window followed any plain link, and any scheme went to openExternal. */
describe("electron/navigation.cjs", () => {
  it("hands only http, https and mailto links to the OS", () => {
    expect(navigation.isExternalUrlAllowed("https://example.com/a")).toBe(true);
    expect(navigation.isExternalUrlAllowed("http://example.com")).toBe(true);
    expect(navigation.isExternalUrlAllowed("mailto:a@b.c")).toBe(true);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "ms-msdt:/id", "not a url"]) {
      expect(navigation.isExternalUrlAllowed(url), url).toBe(false);
    }
  });

  it("keeps the window on the app's own pages only", () => {
    expect(navigation.isAppNavigation("app://chat/index.html#/chats", "app://chat/index.html")).toBe(true);
    expect(navigation.isAppNavigation("app://evil/index.html", "app://chat/index.html")).toBe(false);
    expect(navigation.isAppNavigation("https://evil.example/", "app://chat/index.html")).toBe(false);
    expect(navigation.isAppNavigation("http://localhost:5173/#/login", "http://localhost:5173/")).toBe(true);
    expect(navigation.isAppNavigation("http://localhost:5174/", "http://localhost:5173/")).toBe(false);
  });

  it("stops a navigation away from the app and opens it outside instead", () => {
    const handlers: Record<string, (event: { preventDefault: () => void }, url: string) => void> = {};
    let openHandler: ((details: { url: string }) => { action: string }) | null = null;
    const webContents = {
      on: (name: string, fn: (event: { preventDefault: () => void }, url: string) => void) => {
        handlers[name] = fn;
      },
      setWindowOpenHandler: (fn: (details: { url: string }) => { action: string }) => {
        openHandler = fn;
      },
    };
    const openExternal = vi.fn(async () => {});
    navigation.guardWindowNavigation(webContents, { appUrl: "app://chat/index.html", openExternal });

    const away = { preventDefault: vi.fn() };
    handlers["will-navigate"](away, "https://evil.example/");
    expect(away.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://evil.example/");

    const inside = { preventDefault: vi.fn() };
    handlers["will-navigate"](inside, "app://chat/index.html");
    expect(inside.preventDefault).not.toHaveBeenCalled();
    expect(handlers["will-redirect"]).toBeTypeOf("function");

    openExternal.mockClear();
    expect(openHandler!({ url: "file:///C:/Windows/system32/calc.exe" })).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();
    expect(openHandler!({ url: "https://example.com" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("is what the main window uses", () => {
    expect(mainSource).toContain("guardWindowNavigation(win.webContents, {");
    expect(mainSource).not.toMatch(/setWindowOpenHandler\(\(\{ url \}\) => \{\s*shell\.openExternal\(url\)/);
  });
});

/** Audit S8-04: no right-click menu (no Paste) and no F5. */
describe("electron/context-menu.cjs", () => {
  it("offers cut, copy and paste in an editable field", () => {
    const items = contextMenu.contextMenuTemplate({
      isEditable: true,
      selectionText: "",
      editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
    });
    expect(items.map((i) => i.role ?? i.type)).toEqual(["cut", "copy", "paste", "separator", "selectAll"]);
    expect(items.find((i) => i.role === "paste")?.enabled).toBe(true);
    expect(items.find((i) => i.role === "cut")?.enabled).toBe(false);
  });

  it("offers copy for selected text, and nothing elsewhere", () => {
    expect(
      contextMenu.contextMenuTemplate({ isEditable: false, selectionText: "hi", editFlags: { canCopy: true } }).map((i) => i.role),
    ).toEqual(["copy"]);
    expect(contextMenu.contextMenuTemplate({ isEditable: false, selectionText: " ", editFlags: {} })).toEqual([]);
  });

  it("reloads on plain F5 only", () => {
    expect(contextMenu.isReloadKey({ type: "keyDown", key: "F5" })).toBe(true);
    expect(contextMenu.isReloadKey({ type: "keyUp", key: "F5" })).toBe(false);
    expect(contextMenu.isReloadKey({ type: "keyDown", key: "F5", control: true })).toBe(false);
    expect(contextMenu.isReloadKey({ type: "keyDown", key: "r" })).toBe(false);
  });

  it("is wired onto the main window", () => {
    expect(mainSource).toContain("wireContextMenuAndReload(win, Menu);");
  });
});

/** Audit S8-03: the packaged app found no tray icon, and close-to-tray hid the window for good. */
describe("electron/tray.cjs", () => {
  it("looks for an icon the packaged app actually contains", () => {
    const builder = JSON.parse(readFileSync(resolve(root, "electron-builder.json"), "utf-8")) as { files: string[] };
    const packed = (rel: string) =>
      builder.files.some((glob) => glob.endsWith("/**/*") && rel.startsWith(glob.slice(0, -"**/*".length)));

    const candidates = tray.trayIconCandidates(resolve(root, "electron")).map((p) => relative(root, p));
    const packaged = candidates.filter(packed);
    expect(packaged).toContain("dist/forta-icon.png");
    // dist/ is Vite's copy of public/, so the source must exist.
    expect(existsSync(resolve(root, "public/forta-icon.png"))).toBe(true);
  });

  it("does not hide the window when there is no tray to bring it back", () => {
    expect(mainSource).toContain("if (isQuitting || !desktopSettings.closeToTray || !tray) return;");
    expect(mainSource).toContain("if (!desktopSettings.closeToTray || isQuitting || !tray) app.quit();");
  });
});
