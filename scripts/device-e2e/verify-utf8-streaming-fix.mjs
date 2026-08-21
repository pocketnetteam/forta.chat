#!/usr/bin/env node
/**
 * Live regression check for the 2026-08-21 "\x90byte: \xbe" report —
 * llama-cpp-pro's per-token formatter (`tokens_to_output_formatted_string`)
 * emitted literal "byte: \xNN" debug text for a lone UTF-8 continuation
 * byte instead of buffering it across tokens until a complete character
 * formed (patches/llama-cpp-pro+0.2.4.patch's new
 * `format_token_utf8_safe()`, replacing the debug formatter at the two
 * real per-token streaming call sites). Sends a prompt specifically
 * designed to provoke multi-byte characters (emoji, Cyrillic — byte-level
 * BPE tokenizers routinely split these across several tokens) and asserts
 * the reply contains no "byte: \x" debug leakage.
 *
 * Live run confirmed 2026-08-21: an existing pre-fix chat in this same
 * account has the exact reported garbage ("Классика! byte: \x90byte:
 * \xbe..."); a fresh chat after the native rebuild produced a clean reply
 * with correctly-rendered emoji (🎉 🐱 ✨) right next to it in the list.
 */
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

let failures = 0;
function ok(label, condition) {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) failures++;
}

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

/** Finds the AI chat list row whose preview text starts with `prefix` and
 *  clicks it via elementFromPoint (survives the row itself being a deeply
 *  nested, non-leaf clickable container — walks up from the located point
 *  to the nearest button/link/[role=button], falling back to the leaf
 *  element itself). */
async function openChatByPreviewPrefix(cdp, prefix) {
  const info = await cdp.evalJs(`
    (function(){
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.offsetParent === null || el.children.length > 0) continue;
        if ((el.textContent || '').indexOf(${JSON.stringify(prefix)}) !== 0) continue;
        var rect = el.getBoundingClientRect();
        return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
      return { found: false };
    })()
  `);
  if (!info.found) return false;
  await cdp.evalJs(`
    (function(){
      var el = document.elementFromPoint(${info.x}, ${info.y});
      if (!el) return false;
      var t = el;
      for (var d = 0; d < 10 && t; d++) {
        if (t.tagName === 'BUTTON' || t.tagName === 'A' || (t.getAttribute && t.getAttribute('role') === 'button')) { t.click(); return true; }
        t = t.parentElement;
      }
      el.click();
      return true;
    })()
  `);
  return true;
}

async function main() {
  const adbPath = findAdb();

  // Navigation below assumes a known starting screen (chat list, nothing
  // already open, no leftover chat from a previous run mid-conversation).
  // If it's not landing right, force-relaunch manually first:
  //   adb shell am force-stop com.forta.chat && adb shell am start -n com.forta.chat/.MainActivity
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);

  try {
    await cdp.clickByText("AI", "*").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    const openedNew = await cdp.clickByText("Новый AI-чат", "*").then(() => true).catch(() => false);
    ok("opened a new AI chat", openedNew);
    await new Promise((r) => setTimeout(r, 800));

    const prefix = `ping-utf8-${Date.now()}`;
    const testMessage = `${prefix} Расскажи очень короткую историю про кота и добавь эмодзи 🐱🎉🚀`;
    await sendMessage(cdp, testMessage);

    // Sending can navigate back to the chat list depending on the app's
    // own post-send routing — re-locate and open the chat by its preview
    // text if we're not looking at the composer anymore.
    await new Promise((r) => setTimeout(r, 1500));
    const hasComposer = await cdp.evalJs(
      `Array.prototype.some.call(document.querySelectorAll('textarea'), function(el){ return el.offsetParent !== null; })`,
    );
    if (!hasComposer) {
      await openChatByPreviewPrefix(cdp, prefix);
    }

    let texts = [];
    let candidateReply = null;
    console.log("waiting up to 150s for a reply...");
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      texts = await cdp.visibleTexts();
      const msgIdx = texts.findIndex((t) => t.startsWith(prefix));
      if (msgIdx === -1) continue;
      const isTimestampLike = (s) => /^\d{1,2}:\d{2}$/.test(s) || /^(New chat|Новый чат)$/.test(s);
      for (let k = msgIdx - 1; k >= 0 && k >= msgIdx - 5; k--) {
        const t = texts[k];
        if (t && !t.startsWith(prefix) && !isTimestampLike(t) && t.trim().length > 3) {
          candidateReply = t;
          break;
        }
      }
      if (candidateReply) {
        console.log(`[${(i + 1) * 3}s] reply: ${JSON.stringify(candidateReply)}`);
        break;
      }
    }

    ok("a reply rendered", candidateReply !== null);
    if (candidateReply) {
      ok("reply contains no 'byte: \\x' debug leakage", !/byte:\s*\\x[0-9a-f]{2}/i.test(candidateReply));
    }
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
