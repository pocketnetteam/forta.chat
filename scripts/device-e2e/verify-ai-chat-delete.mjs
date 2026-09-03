#!/usr/bin/env node
/**
 * Live check for the AI-chat delete UI (2026-08-21): right-click / long-press
 * on a chat row in the AI tab should pop a context menu with "Delete", which
 * opens a confirmation dialog before actually deleting — same pattern as
 * ContactList's per-room menu (AiChatList.vue). A real right-click isn't
 * available over adb, so this dispatches a genuine `contextmenu` MouseEvent
 * at the row (same event the Vue `@contextmenu.prevent` listener reacts to
 * on a desktop right-click) rather than simulating a long-press timer.
 */
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

let failures = 0;
function ok(label, condition) {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) failures++;
}

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);

  try {
    await cdp.clickByText("AI", "*").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));

    // Ensure there's at least one chat to test against.
    const hasChatRow = await cdp.evalJs(
      `Array.prototype.some.call(document.querySelectorAll('button'), function(b){ return b.offsetParent !== null && b.querySelector('svg') && /чат|chat/i.test(b.textContent || ''); })`,
    );
    if (!hasChatRow) {
      await cdp.clickByText("Новый AI-чат", "*").catch(() => undefined);
      await new Promise((r) => setTimeout(r, 800));
      await cdp.clickByText("AI", "*").catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }

    // Dispatch a genuine `contextmenu` event on an actual AI chat row — found
    // by its "New chat" title text, not just document order: SwipeableTabs
    // keeps adjacent tabs' rows mounted (just translated off-screen) for the
    // swipe animation, so a plain "first visible row" query can land on a
    // regular ContactList row instead of an AiChatList one.
    const dispatched = await cdp.evalJs(`
      (function(){
        var rows = document.querySelectorAll('button');
        for (var i = 0; i < rows.length; i++) {
          var b = rows[i];
          if (b.offsetParent === null) continue;
          var rect = b.getBoundingClientRect();
          if (rect.height < 40) continue; // skip small header buttons, want a list row
          if (!/^(New chat|Новый чат)/.test((b.textContent || '').trim())) continue;
          var evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 20, clientY: rect.y + 20 });
          b.dispatchEvent(evt);
          return true;
        }
        return false;
      })()
    `);
    ok("dispatched contextmenu on an AI chat row", dispatched);
    await new Promise((r) => setTimeout(r, 300));

    const menuItem = await cdp.evalJs(
      `(function(){ var el = document.querySelector('[role=menuitem]'); return el ? el.textContent.trim() : null; })()`,
    );
    ok("context menu opened with a menu item", menuItem !== null);
    console.log(`   menu item text: ${JSON.stringify(menuItem)}`);

    if (menuItem !== null) {
      await cdp.evalJs(`document.querySelector('[role=menuitem]').click()`);
      await new Promise((r) => setTimeout(r, 300));

      const dialogTexts = await cdp.visibleTexts();
      const hasConfirmTitle = dialogTexts.some((t) => t.includes("Удалить чат") || t.toLowerCase().includes("delete chat"));
      ok("confirmation dialog appeared (not an immediate delete)", hasConfirmTitle);

      // Cancel — verify the chat is NOT deleted.
      await cdp.clickByText("Отмена", "*").catch(() => cdp.clickByText("Cancel", "*")).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      const dialogGoneAfterCancel = !(await cdp.visibleTexts()).some((t) => t.includes("Удалить чат") || t.toLowerCase().includes("delete chat"));
      ok("dialog closes on cancel", dialogGoneAfterCancel);
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
