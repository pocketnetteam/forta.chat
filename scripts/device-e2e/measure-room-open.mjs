#!/usr/bin/env node
/** Measures repeated opens of one chat on a connected Android device
 *  (plan docs/plans/2026-09-28-chat-open-local-first.md, stage 0).
 *
 *  Opens the chat whose sidebar row contains `<name>`, goes back, and repeats
 *  `<times>` times; prints the `[room-open]` summary lines the app logs
 *  (MessageList → room-open-trace.ts): peek size, branch, time to the first
 *  liveQuery emission and to the reveal, plus Dexie writes / network
 *  requests during the open and 5 s after it.
 *
 *  Usage: node scripts/device-e2e/measure-room-open.mjs "<chat name part>" [times=5] [openMs=6000] [backMs=1500]
 *  Short pauses (e.g. 800 300) stress re-entry while the previous visit's work still runs.
 *  Needs a logged-in app. Enables the `forta-chat:perf` flag itself. */
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

const OPEN_WAIT_MS = Number(process.argv[4] ?? 6_000); // default covers the 5 s tail line
const BACK_WAIT_MS = Number(process.argv[5] ?? 1_500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const name = process.argv[2];
  const times = Number(process.argv[3] ?? 5);
  if (!name) throw new Error('usage: measure-room-open.mjs "<chat name part>" [times]');

  const adbPath = findAdb();
  const cdp = await connectCdp(adbPath, await findWebviewSocket(adbPath, "com.forta.chat"));
  try {
    await cdp.evalJs(`
      (function(){
        localStorage.setItem("forta-chat:perf", "1");
        window.__roomOpenLog = [];
        if (!window.__roomOpenHooked) {
          window.__roomOpenHooked = true;
          var info = console.info.bind(console);
          console.info = function () {
            var first = arguments[0];
            if (typeof first === "string" && first.indexOf("[room-open]") === 0) window.__roomOpenLog.push(first);
            return info.apply(null, arguments);
          };
        }
      })()
    `);

    const openChat = () => cdp.evalJs(`
      (function(){
        var name = ${JSON.stringify(name)};
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var node, hit = null;
        while ((node = walker.nextNode())) {
          var el = node.parentElement;
          if (el && el.offsetParent !== null && node.textContent.indexOf(name) !== -1) { hit = el; break; }
        }
        if (!hit) return false;
        var row = hit.closest("button") || hit;
        row.click();
        return true;
      })()
    `);
    const goBack = () => cdp.evalJs(`
      (function(){
        var btn = document.querySelector('[data-testid="chat-header"] button');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);

    for (let i = 0; i <= times; i++) {
      if (!(await openChat())) throw new Error(`no visible sidebar row contains "${name}"`);
      await sleep(OPEN_WAIT_MS);
      if (!(await goBack())) throw new Error("chat header back button not found");
      await sleep(BACK_WAIT_MS);
    }

    await sleep(Math.max(0, 5_500 - BACK_WAIT_MS)); // let the last tail line land
    const lines = await cdp.evalJs("window.__roomOpenLog");
    console.log(`opens: 1 cold + ${times} repeated`);
    for (const line of lines) console.log(line);
  } finally {
    await cdp.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
