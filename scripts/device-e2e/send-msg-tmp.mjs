import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";
const adbPath = findAdb();
const socket = await findWebviewSocket(adbPath, "com.forta.chat");
const cdp = await connectCdp(adbPath, socket);
try {
  const text = "verify-fork-" + Date.now() + " Напиши одно короткое предложение про кота.";
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
  console.log("typed:", typed, text);
  await new Promise((r) => setTimeout(r, 300));
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
} finally {
  cdp.disconnect();
}
