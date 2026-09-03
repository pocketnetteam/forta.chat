import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);
  try {
    const marker = process.argv[2];
    const clicked = await cdp.evalJs(`
      (function(){
        var marker = ${JSON.stringify(marker)};
        var all = document.querySelectorAll('*');
        var target = null;
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.children.length === 0 && el.textContent && el.textContent.trim() === marker && el.offsetParent !== null) {
            target = el;
            break;
          }
        }
        if (!target) return "MARKER_NOT_FOUND";
        var row = target;
        for (var d = 0; d < 8 && row; d++, row = row.parentElement) {
          if (row.getAttribute && (row.getAttribute('role') === 'button' || row.onclick || row.tagName === 'BUTTON' || row.tagName === 'A')) break;
        }
        // fallback: click a reasonable ancestor a few levels up (list row container)
        var clickTarget = target;
        for (var d2 = 0; d2 < 5 && clickTarget.parentElement; d2++) clickTarget = clickTarget.parentElement;
        clickTarget.click();
        return "clicked ancestor of: " + target.textContent.trim();
      })()
    `);
    console.log("click result:", clicked);
    await new Promise((r) => setTimeout(r, 600));
    const texts = await cdp.visibleTexts();
    console.log(JSON.stringify(texts.slice(-20), null, 1));
  } finally {
    cdp.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
