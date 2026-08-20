import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);
  try {
    const testMessage = `тест ${Date.now()}`;
    const typed = await cdp.evalJs(`
      (function(){
        var textarea = Array.prototype.find.call(document.querySelectorAll('textarea'), function(el){ return el.offsetParent !== null; });
        if (!textarea) return "NO_TEXTAREA";
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, ${JSON.stringify(testMessage)});
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return "typed";
      })()
    `);
    console.log("typed:", typed);
    await new Promise((r) => setTimeout(r, 300));

    const clicked = await cdp.evalJs(`
      (function(){
        var textarea = Array.prototype.find.call(document.querySelectorAll('textarea'), function(el){ return el.offsetParent !== null; });
        var taRect = textarea.getBoundingClientRect();
        var buttons = Array.prototype.filter.call(document.querySelectorAll('button'), function(b){ return b.offsetParent !== null; })
          .map(function(b){ return { b: b, r: b.getBoundingClientRect() }; })
          .filter(function(c){ return Math.abs((c.r.top + c.r.bottom)/2 - (taRect.top + taRect.bottom)/2) < 60; })
          .sort(function(a,b){ return b.r.left - a.r.left; });
        if (buttons.length === 0) return "NO_SEND_BUTTON";
        buttons[0].b.click();
        return "clicked";
      })()
    `);
    console.log("send clicked:", clicked);

    // Check composer state shortly after sending, while generation should be starting/in-progress
    await new Promise((r) => setTimeout(r, 1500));
    const state = await cdp.evalJs(`
      (function(){
        var textarea = Array.prototype.find.call(document.querySelectorAll('textarea'), function(el){ return el.offsetParent !== null; });
        if (!textarea) return "NO_TEXTAREA";
        return JSON.stringify({ disabled: textarea.disabled, value: textarea.value });
      })()
    `);
    console.log("composer state during generation:", state);
  } finally {
    cdp.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
