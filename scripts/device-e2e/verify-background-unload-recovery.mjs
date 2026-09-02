#!/usr/bin/env node
/**
 * On-device regression check for the 2026-08-29 "не удалось сгенерировать
 * ответ после долгого простоя" report — reproduces the actual trigger
 * (`autoUnloadOnBackground` releasing the native runtime while the app is
 * backgrounded) via a real `adb shell input keyevent HOME` + relaunch, not
 * just a synthetic event emit, then sends a message and asserts a real
 * reply renders instead of the local-ai-store.ts fix's target bug: a
 * synchronous `RuntimeInitError('call ensureModelReady() before
 * sendMessage()')` because `modelReady` stayed stale `true` across the
 * `runtime:unloaded` (`reason: 'background'`) event.
 */
import { spawnSync } from "node:child_process";
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

let failures = 0;
function ok(label, condition) {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) failures++;
}

/** The sidebar's chat-list tabs (Все/Личные/.../AI) are panels of a
 *  horizontal-scroll `SwipeableTabs` carousel — EVERY panel stays mounted
 *  with `offsetParent !== null` at all times, just scrolled out of the
 *  viewport, so plain `offsetParent`-based visibility (what `visibleTexts()`/
 *  `clickByText()` use) can't tell the AI panel's rows apart from whatever
 *  panel is currently scrolled into view. Filter by actual on-screen
 *  horizontal position instead. */
async function inViewportTexts(cdp) {
  return cdp.evalJs(`
    (function(){
      var w = window.innerWidth;
      var out = [];
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length !== 0) continue;
        var t = (el.textContent || '').trim();
        if (!t) continue;
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.left >= -5 && r.left < w) out.push(t);
      }
      return out;
    })()
  `);
}

async function openFirstAiChat(cdp) {
  // Already inside a specific chat's message thread (not the sidebar
  // carousel) — a plain offsetParent check is fine here, that view isn't
  // part of the horizontal-scroll tab strip.
  const already = await cdp.evalJs(`
    (function(){ var ta = document.querySelector('textarea'); return !!(ta && ta.offsetParent !== null); })()
  `);
  if (already) return true;

  const clickedTab = await cdp.evalJs(`
    (function(){
      var btns = Array.prototype.filter.call(document.querySelectorAll('button'), function(el){
        return el.offsetParent !== null && el.textContent.trim() === 'AI';
      });
      if (btns.length) btns[0].click();
      return btns.length > 0;
    })()
  `);
  if (!clickedTab) return false;
  await new Promise((r) => setTimeout(r, 900)); // smooth-scroll settle (SwipeableTabs' own 400ms timer + margin)

  const texts = await inViewportTexts(cdp);
  const rowLabel = texts.find((t) => /^(New chat|Новый чат)$/.test(t));
  if (!rowLabel) return false;

  return cdp.evalJs(`
    (function(){
      var w = window.innerWidth;
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length !== 0) continue;
        if ((el.textContent || '').trim() !== ${JSON.stringify(rowLabel)}) continue;
        var r = el.getBoundingClientRect();
        if (r.left < -5 || r.left >= w) continue;
        // AiChatList.vue's row IS a <button> (handleSelect) — walk up to the
        // nearest one instead of a blind fixed depth, which overshot past it
        // into RecycleScroller's non-interactive wrapper (live bug, this run).
        var clickTarget = el;
        for (var d = 0; d < 8 && clickTarget && clickTarget.tagName !== 'BUTTON'; d++) clickTarget = clickTarget.parentElement;
        if (!clickTarget) return false;
        clickTarget.click();
        return true;
      }
      return false;
    })()
  `);
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
  await new Promise((r) => setTimeout(r, 300));

  // AiComposer.vue's send button carries title="Отправить" (t('ai.send')) —
  // select by that instead of nearest-button-by-geometry, which silently
  // picked the wrong (or no) button once after a background/resume cycle
  // shifted the composer row's layout (soft-keyboard dismissal reflow).
  const clicked = await cdp.evalJs(`
    (function(){
      var btn = document.querySelector('button[title="Отправить"]');
      if (!btn || btn.offsetParent === null) return false;
      btn.click();
      return true;
    })()
  `);
  if (!clicked) throw new Error("sendMessage: no send button (title=Отправить) found");
}

async function waitForReply(cdp, testMessage, maxWaitMs) {
  const isTimestampLike = (s) => /^\d{1,2}:\d{2}$/.test(s) || /^(New chat|Новый чат)$/.test(s);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const texts = await cdp.visibleTexts();
    const msgIdx = texts.indexOf(testMessage);
    if (msgIdx === -1) continue;
    for (let k = msgIdx - 1; k >= 0 && k >= msgIdx - 5; k--) {
      const t = texts[k];
      if (t && t !== testMessage && !isTimestampLike(t) && t.trim().length > 10) {
        return { error: /не удалось сгенерировать/i.test(t), reply: t };
      }
    }
  }
  return { error: false, reply: null };
}

async function waitForTextarea(cdp, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const found = await cdp.evalJs(
      `!!Array.prototype.find.call(document.querySelectorAll('textarea'), function(el){ return el.offsetParent !== null; })`,
    );
    if (found) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const adbPath = findAdb();
  let socket = await findWebviewSocket(adbPath, "com.forta.chat");
  let cdp = await connectCdp(adbPath, socket);

  try {
    const opened = await openFirstAiChat(cdp);
    ok("opened an AI chat", opened);
    ok("composer textarea appeared", await waitForTextarea(cdp, 20000));

    // Baseline: confirm the model is actually loaded and can reply BEFORE
    // we ever background the app — otherwise a failure below could just
    // mean "model never downloaded on this device", not the bug under test.
    const baselineMsg = `baseline ${Date.now()}`;
    await sendMessage(cdp, baselineMsg);
    console.log(`sent baseline "${baselineMsg}", waiting up to 150s for a real reply...`);
    const baseline = await waitForReply(cdp, baselineMsg, 150000);
    ok("baseline message got a real reply (model genuinely ready pre-background)", baseline.reply && !baseline.error);
    if (!baseline.reply || baseline.error) {
      console.log("baseline failed — aborting before the background/foreground step, nothing meaningful to test");
      cdp.disconnect();
      console.log(`\n❌ ${failures + 1} CHECK(S) FAILED`);
      process.exit(1);
    }

    // Trigger autoUnloadOnBackground: HOME backgrounds the app (appStateChange
    // isActive:false), then relaunch brings it back to the foreground without
    // killing the process — same "backgrounded, not restarted" scenario the
    // live device report described.
    console.log("backgrounding the app (HOME)...");
    spawnSync(adbPath, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
    await new Promise((r) => setTimeout(r, 4000));

    console.log("bringing the app back to the foreground...");
    spawnSync(adbPath, ["shell", "am", "start", "-n", "com.forta.chat/.MainActivity"]);
    await new Promise((r) => setTimeout(r, 2000));

    // Reconnect CDP — backgrounding can recycle the webview_devtools_remote
    // socket's pid-suffixed name.
    cdp.disconnect();
    socket = await findWebviewSocket(adbPath, "com.forta.chat");
    cdp = await connectCdp(adbPath, socket);

    // With the fix, AiChatView briefly swaps back to AiModelGate while
    // restoreModelIfPreviouslyDownloaded() re-verifies+reloads the
    // already-on-disk model (verify-hashing a multi-GB file isn't instant)
    // before the composer reappears — generous timeout for that.
    ok("composer textarea reappeared after resume", await waitForTextarea(cdp, 90000));

    const testMessage = `после фона ${Date.now()}`;
    await sendMessage(cdp, testMessage);
    console.log(`sent "${testMessage}" right after resuming from background, waiting up to 150s...`);
    const result = await waitForReply(cdp, testMessage, 150000);

    ok("no 'не удалось сгенерировать ответ' after background/resume", !result.error);
    ok("a real assistant reply rendered after background/resume", !!result.reply && !result.error);
    if (result.reply) console.log(`reply: ${result.reply.slice(0, 160)}`);
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
