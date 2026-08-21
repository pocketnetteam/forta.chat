#!/usr/bin/env node
/**
 * Plan §11 open question #6 (docs/plans/llama2/2026-08-20-local-ai-perf-tuning-plan.md):
 * the @LlamaCpp_onToken -> notifyListeners bridge was already confirmed via logcat
 * (local-ai/docs/decisions.md's "Android per-token streaming fixed" entry, 2026-08-20),
 * but nobody had confirmed the *chat screen* actually paints text token-by-token rather
 * than the whole reply appearing as one block once generation finishes.
 *
 * Anchors on the streaming cursor markup itself (AiChatView.vue: a
 * `.animate-pulse` span rendered only `v-if="message.status === 'streaming'"`,
 * sibling to the bubble's text) rather than a generic "nearest preceding text"
 * heuristic — the latter produced a false-positive match against unrelated
 * sidebar/list text in an earlier run (same class of bug
 * verify-utf8-streaming-fix.mjs's doc comment already warns about).
 *
 * Polls every ~500ms while the cursor element exists, recording
 * (elapsedMs, textLength) of the streaming bubble's own text. A real
 * incremental render shows length climbing across many samples while the
 * cursor is present; a batch-at-the-end render would show 0 (or a fixed
 * placeholder) for the whole streaming window and then a jump the instant
 * the cursor disappears.
 */
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";
import { writeFileSync } from "node:fs";

async function sendMessage(cdp, text) {
  const typed = await cdp.evalJs(`
    (function(){
      var textarea = Array.prototype.find.call(document.querySelectorAll('textarea'), function(el){ return el.offsetParent !== null; });
      if (!textarea) return false;
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, ${JSON.stringify(text)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  if (!typed) throw new Error("sendMessage: no visible textarea found");
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
  if (!clicked) throw new Error("sendMessage: no send button found near the composer");
}

/** Reads the streaming bubble's current text length by anchoring on the
 *  `.animate-pulse` cursor span (AiChatView.vue line ~146) — its parent is
 *  the bubble div, `textContent.length` on that parent is the bubble's
 *  current rendered text (includes the zero-width cursor node itself, which
 *  contributes ~0 to textContent). Falls back to "cursor gone" (null) once
 *  generation finishes and the span is removed. */
async function readStreamingBubble(cdp) {
  return cdp.evalJs(`
    (function(){
      var cursor = document.querySelector('.animate-pulse.bg-current');
      if (!cursor) return { streaming: false };
      var bubble = cursor.closest('.rounded-2xl');
      if (!bubble) return { streaming: false };
      return { streaming: true, len: bubble.textContent.length, snippet: bubble.textContent.slice(0, 50) };
    })()
  `);
}

async function readLastAssistantBubbleText(cdp) {
  return cdp.evalJs(`
    (function(){
      var bubbles = document.querySelectorAll('.justify-start .rounded-2xl');
      if (bubbles.length === 0) return null;
      return bubbles[bubbles.length - 1].textContent;
    })()
  `);
}

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);
  const samples = [];

  try {
    const testMessage = `ping-stream-${Date.now()} Расскажи очень короткую историю про собаку (2-3 предложения)`;
    const sentAt = Date.now();
    await sendMessage(cdp, testMessage);
    console.log("sent at", new Date(sentAt).toISOString(), "wall-clock ms:", sentAt);

    console.log("polling every 500ms for up to 150s, anchored on the streaming cursor span...");
    let sawCursor = false;
    let lastLen = -1;
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const elapsedMs = Date.now() - sentAt;
      const state = await readStreamingBubble(cdp).catch(() => ({ streaming: false }));
      if (state.streaming) {
        sawCursor = true;
        if (state.len !== lastLen) {
          samples.push({ elapsedMs, len: state.len, snippet: state.snippet });
          console.log(`[+${(elapsedMs / 1000).toFixed(1)}s] STREAMING len=${state.len} snippet=${JSON.stringify(state.snippet)}`);
          lastLen = state.len;
        }
      } else if (sawCursor) {
        // cursor was present before and is now gone -> generation finished, stop.
        const finalText = await readLastAssistantBubbleText(cdp).catch(() => null);
        samples.push({ elapsedMs, len: finalText ? finalText.length : null, snippet: finalText ? finalText.slice(0, 50) : null, final: true });
        console.log(`[+${(elapsedMs / 1000).toFixed(1)}s] CURSOR GONE (final) len=${finalText ? finalText.length : null} snippet=${JSON.stringify(finalText ? finalText.slice(0, 50) : null)}`);
        break;
      }
      // Give up if cursor never appeared within 60s (model gate / stuck / no message sent).
      if (!sawCursor && elapsedMs > 60000) {
        console.log("never saw the streaming cursor within 60s — aborting");
        break;
      }
    }

    writeFileSync(
      "logs/visual-streaming-samples.json",
      JSON.stringify({ sentAtMs: sentAt, samples }, null, 2),
    );
    console.log("\nwrote logs/visual-streaming-samples.json");

    const growthDuringStreaming = samples.filter((s) => !s.final && s.len > 0);
    console.log(`\ndistinct in-flight (streaming) length samples: ${growthDuringStreaming.length}`);
    if (growthDuringStreaming.length >= 3) {
      console.log("✅ bubble text length climbed across 3+ samples WHILE the streaming cursor was present — incremental rendering confirmed");
    } else {
      console.log("❌ too few distinct in-flight samples — cannot confirm incremental rendering from this run");
      process.exit(1);
    }
  } finally {
    cdp.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
