import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Audit W2B-01 regression tests for the inline <script id="boot-guard"> in
 * index.html. On Android System WebView < 71 there is no `globalThis`, and
 * matrix-js-sdk-bastyon uses it at module top level, so the whole module graph
 * died before Vue existed: a permanent blank white screen (reproduced on an
 * Android 9 emulator with WebView 66). The guard runs the real script text
 * against a fake window so the test exercises exactly what ships.
 */

const html = readFileSync(resolve(__dirname, "../../../index.html"), "utf8");
const guardMatch = html.match(/<script id="boot-guard">([\s\S]*?)<\/script>/);
const GUARD_SOURCE = guardMatch ? guardMatch[1] : "";

interface FakeWindow {
  globalThis?: unknown;
  __fortaBootStarted?: boolean;
  __fortaShowUnsupported?: (detail?: string) => void;
  location: { origin: string; reload: () => void };
  addEventListener: (type: string, handler: (event: ErrorEventLike) => void, capture?: boolean) => void;
  setTimeout: typeof setTimeout;
}

interface ErrorEventLike {
  filename?: string;
  message?: string;
  target?: { tagName?: string; src?: string };
}

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 9; wv) AppleWebKit/537.36 Chrome/66.0.3359.158 Mobile Safari/537.36";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";

function runGuard(language = "en-US", withGlobalThis = false, userAgent = ANDROID_UA) {
  const handlers: Array<(event: ErrorEventLike) => void> = [];
  const captures: boolean[] = [];
  const win: FakeWindow = {
    location: { origin: "https://localhost", reload: vi.fn() },
    addEventListener: (type, handler, capture?: boolean) => {
      if (type !== "error") return;
      handlers.push(handler);
      captures.push(capture === true);
    },
    setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout,
  };
  if (withGlobalThis) win.globalThis = "existing";
  new Function("window", "document", "navigator", GUARD_SOURCE)(win, document, { language, userAgent });
  const fireError = (event: ErrorEventLike) => handlers.forEach((h) => h(event));
  return { win, fireError, captures };
}

const fallback = () => document.querySelector("[data-boot-fallback]");

describe("index.html boot guard (audit W2B-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"><div id="appLoading"></div></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("ships in index.html before the module entry", () => {
    expect(GUARD_SOURCE).not.toBe("");
    expect(html.indexOf('id="boot-guard"')).toBeLessThan(html.indexOf('type="module"'));
  });

  it("defines globalThis when the WebView lacks it", () => {
    const { win } = runGuard();
    expect(win.globalThis).toBe(win);
  });

  it("keeps an existing globalThis", () => {
    const { win } = runGuard("en-US", true);
    expect(win.globalThis).toBe("existing");
  });

  it("replaces the blank page with the update-WebView message when the module graph fails", () => {
    const { fireError } = runGuard("ru-RU");
    fireError({ filename: "https://localhost/assets/matrix-C9.js", message: "ReferenceError: globalThis is not defined" });
    vi.advanceTimersByTime(4000);
    const box = fallback();
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain("Android System WebView");
    expect(box?.textContent).toContain("Попробовать снова");
    expect(box?.textContent).toContain("globalThis is not defined");
  });

  it("leaves the app alone when the module graph started", () => {
    const { win, fireError } = runGuard();
    fireError({ filename: "https://localhost/assets/index.js", message: "boom" });
    win.__fortaBootStarted = true;
    vi.advanceTimersByTime(4000);
    expect(fallback()).toBeNull();
    expect(document.getElementById("appLoading")).not.toBeNull();
  });

  it("ignores errors from other origins such as browser extensions", () => {
    const { fireError } = runGuard();
    fireError({ filename: "chrome-extension://abc/content.js", message: "boom" });
    vi.advanceTimersByTime(4000);
    expect(fallback()).toBeNull();
  });

  it("listens in the capture phase so a <script> that fails to load is seen", () => {
    const { captures, fireError } = runGuard();
    expect(captures).toEqual([true]);
    fireError({ target: { tagName: "SCRIPT", src: "https://localhost/assets/index-abc.js" } });
    vi.advanceTimersByTime(4000);
    expect(fallback()?.textContent).toContain("Failed to load https://localhost/assets/index-abc.js");
  });

  it("ignores failed images and other resources", () => {
    const { fireError } = runGuard();
    fireError({ target: { tagName: "IMG", src: "https://localhost/forta-icon.png" } });
    vi.advanceTimersByTime(4000);
    expect(fallback()).toBeNull();
  });

  it("does not send desktop or iOS users to Google Play", () => {
    const { fireError } = runGuard("en-US", false, DESKTOP_UA);
    fireError({ filename: "https://localhost/assets/index.js", message: "boom" });
    vi.advanceTimersByTime(4000);
    const text = fallback()?.textContent ?? "";
    expect(text).toContain("Update your browser or the app");
    expect(text).not.toContain("Google Play");
  });

  it("exposes the fallback for the nomodule script", () => {
    const { win } = runGuard();
    win.__fortaShowUnsupported?.("ES modules are not supported");
    expect(fallback()?.textContent).toContain("Try again");
  });
});
