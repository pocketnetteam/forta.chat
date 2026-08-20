#!/usr/bin/env node
/**
 * Chrome DevTools Protocol client for the app's own WebView — real DOM
 * inspection/interaction on-device, no screenshots and no `adb shell input
 * tap` coordinate guessing (see docs/plans/llama2/device-ai-loop.md).
 *
 * Every Capacitor debug build exposes its WebView as a debuggable Chromium
 * target over a Unix domain socket named `webview_devtools_remote_<pid>`
 * (`adb shell cat /proc/net/unix | grep devtools` to find it). Forwarding
 * that socket to a local TCP port and talking CDP over it gives direct
 * access to the real DOM (`document.querySelector`, `.click()`,
 * `.textContent`, `getBoundingClientRect()`, `location.hash` for the
 * current route, etc.) — exactly the "DOM analysis, not screenshots"
 * verification this project's device-testing convention now expects,
 * rather than tapping physical pixel coordinates and hoping the right
 * thing was on screen at the right scroll position when the tap landed.
 *
 * Usage (see navigate-and-click.mjs / device-ai-loop.md for a full example):
 *   import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";
 *   const socket = await findWebviewSocket(adbPath);
 *   const cdp = await connectCdp(adbPath, socket);
 *   const html = await cdp.evalJs("document.querySelector('button')?.outerHTML");
 *   await cdp.click("button.btn-press");
 *   await cdp.disconnect();
 */
import { spawnSync } from "node:child_process";

/** Finds the `webview_devtools_remote_<pid>` abstract socket name for a
 *  running app — `packageFilter` narrows by pid via `adb shell pidof
 *  <package>` when more than one WebView-debuggable process is present
 *  (Chrome itself, other apps' Stetho sockets, etc.). */
export async function findWebviewSocket(adbPath, packageName = "com.forta.chat") {
  const pidResult = spawnSync(adbPath, ["shell", "pidof", packageName], { encoding: "utf8" });
  const pid = pidResult.stdout.trim().split(/\s+/)[0];
  if (!pid) throw new Error(`findWebviewSocket: ${packageName} is not running (pidof returned nothing)`);

  const netResult = spawnSync(adbPath, ["shell", "cat", "/proc/net/unix"], { encoding: "utf8" });
  const line = netResult.stdout.split("\n").find((l) => l.includes(`webview_devtools_remote_${pid}`));
  if (!line) {
    throw new Error(
      `findWebviewSocket: no webview_devtools_remote_${pid} socket found — is this a debug build? (release builds disable WebView debugging)`,
    );
  }
  return `webview_devtools_remote_${pid}`;
}

/** Forwards `socketName` to a free-ish local TCP port and returns a
 *  connected CDP client for the app's main page target (the first `type:
 *  "page"` entry — the WebView has exactly one in this app, no iframes/
 *  popups). */
export async function connectCdp(adbPath, socketName, localPort = 9333) {
  const forward = spawnSync(adbPath, ["forward", `tcp:${localPort}`, `localabstract:${socketName}`], { encoding: "utf8" });
  if (forward.status !== 0) throw new Error(`adb forward failed: ${forward.stderr}`);

  const listResp = await fetch(`http://127.0.0.1:${localPort}/json`);
  const targets = await listResp.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error(`connectCdp: no page target found among ${targets.length} targets`);

  // The CDP server reports its own websocket URL with hostname "localhost"
  // regardless of what we connected to /json with — force 127.0.0.1 again
  // here, or this hits the same ::1/IPv4 mismatch the /json fetch above did.
  const wsUrl = page.webSocketDebuggerUrl.replace("localhost", "127.0.0.1");
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (e) => reject(new Error(`CDP websocket error: ${e.message ?? e}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error: ${msg.error.message}`));
      else resolve(msg.result);
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send("Runtime.enable");

  return {
    /** Evaluates `expression` in the page's main world and returns its
     *  value (must be JSON-serializable — `returnByValue: true`). Throws
     *  if the expression itself throws. */
    async evalJs(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`evalJs threw: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`);
      }
      return result.result.value;
    },

    /** Clicks the first element matching `selector` via a real
     *  `.click()` call (fires Vue's registered handler synchronously,
     *  same as a genuine tap) — throws if nothing matches. */
    async click(selector) {
      const found = await this.evalJs(
        `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
      );
      if (!found) throw new Error(`click: no element matches ${selector}`);
    },

    /** Clicks the first element (default: any element, narrow with
     *  `selector`) whose trimmed textContent exactly equals `text` —
     *  the DOM-analysis equivalent of tapping a button by its visible
     *  label, without needing a CSS selector or pixel coordinates. */
    async clickByText(text, selector = "*") {
      // Only considers genuinely visible, laid-out elements (offsetParent
      // !== null, matching visibleTexts()'s own filter) — a broad selector
      // otherwise happily matches a hidden duplicate (a responsive
      // layout's alternate nav, an off-screen clone, etc.) and
      // "successfully" clicks something with no visible effect at all.
      //
      // Real apps routinely have the SAME exact text twice on screen at
      // once for entirely unrelated reasons — a page header/title
      // ("Настройки") and a nav tab's label (also "Настройки") is a very
      // ordinary pattern, not a bug, and picking the wrong one silently
      // "succeeds" (the click does land, on a plain non-interactive
      // <span>) while doing nothing. Break ties by preferring a match that
      // IS a button/link/[role=button], or is INSIDE one within a few
      // levels — the nav tab's label span, nested inside its <button>,
      // wins over the header's bare title span. Only when there's no such
      // interactive candidate does this fall back to plain document order.
      const found = await this.evalJs(`
        (function(){
          var interactiveSelector = "button, a, [role=button]";
          function nearestInteractive(el) {
            var cur = el;
            for (var depth = 0; cur && depth < 4; depth++, cur = cur.parentElement) {
              if (cur.matches && cur.matches(interactiveSelector)) return cur;
            }
            return null;
          }
          var candidates = Array.prototype.filter.call(
            document.querySelectorAll(${JSON.stringify(selector)}),
            function(el) { return el.offsetParent !== null && el.textContent.trim() === ${JSON.stringify(text)}; }
          );
          if (candidates.length === 0) return false;
          var withTarget = candidates.map(function(el) {
            return { el: el, target: nearestInteractive(el) || el };
          });
          withTarget.sort(function(a, b) {
            var aInteractive = a.target !== a.el || (a.el.matches && a.el.matches(interactiveSelector)) ? 0 : 1;
            var bInteractive = b.target !== b.el || (b.el.matches && b.el.matches(interactiveSelector)) ? 0 : 1;
            if (aInteractive !== bInteractive) return aInteractive - bInteractive;
            return a.target.textContent.length - b.target.textContent.length;
          });
          withTarget[0].target.click();
          return true;
        })()
      `);
      if (!found) throw new Error(`clickByText: no visible element matching "${selector}" has exact text "${text}"`);
    },

    /** Current SPA route — `location.hash` (Vue Router hash mode), e.g. "#/settings". */
    async route() {
      return this.evalJs("location.hash");
    },

    /** All visible text nodes' trimmed content under `selector` (default
     *  body) as a flat array — cheap way to assert "X is/isn't on screen"
     *  without screenshotting. */
    async visibleTexts(selector = "body") {
      return this.evalJs(`
        (function(){
          var root = document.querySelector(${JSON.stringify(selector)});
          if (!root) return [];
          var out = [];
          var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          var node;
          while ((node = walker.nextNode())) {
            var t = node.textContent.trim();
            if (!t) continue;
            var el = node.parentElement;
            if (!el) continue;
            var style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            out.push(t);
          }
          return out;
        })()
      `);
    },

    async disconnect() {
      ws.close();
    },
  };
}
