import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

/**
 * Types + sends one message into whatever AI chat is currently open on
 * screen (does NOT navigate there itself — use the AI sidebar tab / "Новый
 * AI-чат" manually or via a screenshot-driven tap first, then run this).
 * Built for the perf-tuning plan's device measurements
 * (docs/plans/llama2/2026-08-20-local-ai-perf-tuning-plan.md §2/§9) — pairs
 * with a concurrently-running `adb logcat` capture read for
 * `Generating token N...`/`Reached end-of-generation` timestamps (same
 * method as `docs/decisions.md`'s "ADR 0008 §7 device-verification
 * checklist closed out" baseline entry in local-ai). Reused across phases
 * rather than one-off, since every phase needs the same before/after
 * tok/s comparison.
 */
const message = process.argv[2] || `perf-test ${Date.now()}`;

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);
  try {
    const typed = await cdp.evalJs(`
      (function(){
        var textarea = Array.prototype.find.call(document.querySelectorAll('textarea'), function(el){ return el.offsetParent !== null; });
        if (!textarea) return false;
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, ${JSON.stringify(message)});
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    console.log("typed:", typed);
    await new Promise((r) => setTimeout(r, 200));

    const clicked = await cdp.evalJs(`
      (function(){
        var textarea = Array.prototype.find.call(document.querySelectorAll('textarea'), function(el){ return el.offsetParent !== null; });
        var taRect = textarea.getBoundingClientRect();
        var buttons = Array.prototype.filter.call(document.querySelectorAll('button'), function(b){ return b.offsetParent !== null; })
          .map(function(b){ return { b: b, r: b.getBoundingClientRect() }; })
          .filter(function(c){ return Math.abs((c.r.top + c.r.bottom)/2 - (taRect.top + taRect.bottom)/2) < 60; })
          .sort(function(a,b){ return b.r.left - a.r.left; });
        if (buttons.length === 0) return false;
        buttons[0].b.click();
        return true;
      })()
    `);
    console.log("clicked send:", clicked);
    console.log("sent message:", message);
    console.log("timestamp (ms since epoch):", Date.now());
  } finally {
    cdp.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
