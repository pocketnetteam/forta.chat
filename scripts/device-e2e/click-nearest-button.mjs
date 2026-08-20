import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);
  try {
    const marker = process.argv[2];
    const result = await cdp.evalJs(`
      (function(){
        var marker = ${JSON.stringify(marker)};
        var all = document.querySelectorAll('*');
        var target = null;
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.children.length === 0 && el.textContent && el.textContent.trim() === marker && el.offsetParent !== null) { target = el; break; }
        }
        if (!target) return "MARKER_NOT_FOUND";
        var cur = target;
        for (var d = 0; d < 8 && cur; d++, cur = cur.parentElement) {
          if (cur.tagName === 'BUTTON') { cur.click(); return "clicked BUTTON"; }
        }
        return "NO_BUTTON_ANCESTOR";
      })()
    `);
    console.log("click:", result);
    await new Promise((r) => setTimeout(r, 700));
    const texts = await cdp.visibleTexts();
    console.log(JSON.stringify(texts.slice(-15), null, 1));
  } finally {
    cdp.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
