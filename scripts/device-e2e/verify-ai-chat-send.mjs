#!/usr/bin/env node
/**
 * Live regression check for the 2026-08-19 "не удалось сгенерировать
 * ответ" report — DOM-driven (see cdp-client.mjs's doc comment), not
 * screenshot-driven. Opens an existing AI chat, sends a message, and
 * asserts a real assistant reply renders rather than an error bubble.
 *
 * Composer send button is located by position (closest same-row button to
 * the visible textarea, picking the rightmost), not by text — it's
 * icon-only, and clickByText's exact-match strategy has no text to match
 * here. Enter-key dispatch was tried first and does NOT trigger send in
 * this app (no keydown.enter handler on the composer) — button click is
 * the only reliable path found this session.
 */
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

let failures = 0;
function ok(label, condition) {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) failures++;
}

async function openFirstAiChat(cdp) {
  // The chat list re-renders between runs and can land on different
  // starting screens (fresh install vs. a warm session already inside a
  // chat) — try the normal nav path, then fall back to whatever's already
  // on screen if the sidebar tab click finds nothing to click.
  await cdp.clickByText("AI", "*").catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
  const opened = await cdp.evalJs(`
    (function(){
      var textarea = document.querySelector('textarea');
      if (textarea && textarea.offsetParent !== null) return true; // already inside a chat
      var rows = document.querySelectorAll('*');
      for (var i = 0; i < rows.length; i++) {
        var el = rows[i];
        if (el.children.length === 0 && el.offsetParent !== null && /^(New chat|Новый чат)$/.test((el.textContent||'').trim())) {
          var clickTarget = el;
          for (var d = 0; d < 5 && clickTarget.parentElement; d++) clickTarget = clickTarget.parentElement;
          clickTarget.click();
          return true;
        }
      }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  return opened;
}

/** Types into the composer and clicks the send button (rightmost visible button on the same row as the textarea). Returns the message actually sent. */
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

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);

  try {
    const opened = await openFirstAiChat(cdp);
    ok("opened an AI chat", opened);

    const testMessage = `тест ${Date.now()}`;
    await sendMessage(cdp, testMessage);

    let texts = [];
    let sawError = false;
    let sawReply = false;
    console.log(`sent "${testMessage}", waiting up to 150s (cold model load + CPU generation can both be slow)...`);
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      texts = await cdp.visibleTexts();
      const msgIdx = texts.indexOf(testMessage);
      if (msgIdx === -1) continue;
      // DOM is reverse-chronological (column-reverse virtual scroller) —
      // the reply to our message, if rendered yet, sits a few elements
      // before it (timestamp/sender labels can be interleaved), so scan
      // backward for the first substantial, non-timestamp-looking string.
      const isTimestampLike = (s) => /^\d{1,2}:\d{2}$/.test(s) || /^(New chat|Новый чат)$/.test(s);
      let candidateReply = null;
      for (let k = msgIdx - 1; k >= 0 && k >= msgIdx - 5; k--) {
        const t = texts[k];
        if (t && t !== testMessage && !isTimestampLike(t) && t.trim().length > 10) {
          candidateReply = t;
          break;
        }
      }
      if (candidateReply && /не удалось сгенерировать/i.test(candidateReply)) {
        sawError = true;
        break;
      }
      if (candidateReply) {
        sawReply = true;
        console.log(`[${(i + 1) * 3}s] reply: ${candidateReply.slice(0, 160)}`);
        break;
      }
    }

    ok("no 'не удалось сгенерировать ответ' error", !sawError);
    ok("a real assistant reply rendered", sawReply);
  } finally {
    cdp.disconnect();
  }

  console.log(failures === 0 ? "\n✅ ALL CHECKS PASSED" : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
