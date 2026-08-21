#!/usr/bin/env node
/** Companion to verify-ai-chat-delete.mjs — exercises the actual confirm
 *  (not just cancel) path: right-click a specific throwaway test chat
 *  ("ping-utf8-" prefixed, left over from the UTF-8 streaming fix
 *  verification), confirm the delete, and assert the row is gone from the
 *  list afterwards. */
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

    const targetPrefix = "New chat";
    const targetSnippet = "ping-utf8-";

    const before = (await cdp.visibleTexts()).filter((t) => t.includes(targetSnippet));
    ok(`throwaway test chat ("${targetSnippet}...") present before delete`, before.length > 0);
    if (before.length === 0) {
      console.log("nothing to delete, exiting");
      cdp.disconnect();
      process.exit(1);
    }

    const dispatched = await cdp.evalJs(`
      (function(){
        var rows = document.querySelectorAll('button');
        for (var i = 0; i < rows.length; i++) {
          var b = rows[i];
          if (b.offsetParent === null) continue;
          var rect = b.getBoundingClientRect();
          if (rect.height < 40) continue;
          if ((b.textContent || '').indexOf(${JSON.stringify(targetSnippet)}) === -1) continue;
          var evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 20, clientY: rect.y + 20 });
          b.dispatchEvent(evt);
          return true;
        }
        return false;
      })()
    `);
    ok("dispatched contextmenu on the target chat row", dispatched);
    await new Promise((r) => setTimeout(r, 300));

    await cdp.evalJs(`document.querySelector('[role=menuitem]')?.click()`);
    await new Promise((r) => setTimeout(r, 300));

    const confirmed = await cdp.evalJs(`
      (function(){
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].textContent.trim() === 'Удалить') { btns[i].click(); return true; }
        }
        return false;
      })()
    `);
    ok("clicked the confirm-delete button", confirmed);
    await new Promise((r) => setTimeout(r, 600));

    const after = (await cdp.visibleTexts()).filter((t) => t.includes(targetSnippet));
    ok("test chat no longer in the list after confirming delete", after.length === 0);
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
