#!/usr/bin/env node
/** One-off live verification for the Settings → Local AI UI rework
 *  (2026-08-21) — kebab menu / delete confirm wording, and starting a
 *  download on the second (not-yet-downloaded) model to confirm the
 *  progress bar names the right model. */
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);

  try {
    // Assumes already on Settings -> Local AI from the prior check.
    // Find and click the first row's kebab (⋮) button via evalJs, since it
    // has no text for clickByText() to match on.
    const clicked = await cdp.evalJs(`
      (function () {
        var rows = document.querySelectorAll('.rounded-xl');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].textContent.includes('Qwen3 4B')) {
            var buttons = rows[i].querySelectorAll('button');
            if (buttons.length > 0) { buttons[0].click(); return true; }
          }
        }
        return false;
      })()
    `);
    console.log("clicked kebab on Qwen3 4B row:", clicked);
    await new Promise((r) => setTimeout(r, 400));

    let texts = await cdp.visibleTexts();
    console.log("menu open — visible texts include 'Delete model'/'Удалить модель':", texts.some((t) => t.includes("Удалить") || t === "Delete model"));
    console.log(texts.filter((t) => t.length < 30));

    // Close the menu (click the backdrop) rather than actually deleting.
    await cdp.evalJs(`
      (function () {
        var backdrops = document.querySelectorAll('.fixed.inset-0.z-10');
        if (backdrops.length > 0) { backdrops[0].click(); return true; }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));

    // Start downloading the second model.
    const startedDownload = await cdp.evalJs(`
      (function () {
        var rows = document.querySelectorAll('.rounded-xl');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].textContent.includes('Qwen3 1.7B')) {
            var buttons = rows[i].querySelectorAll('button');
            var btn = buttons[buttons.length - 1];
            if (btn) { btn.click(); return true; }
          }
        }
        return false;
      })()
    `);
    console.log("clicked download on Qwen3 1.7B row:", startedDownload);
    await new Promise((r) => setTimeout(r, 2500));

    texts = await cdp.visibleTexts();
    console.log("--- after starting download ---");
    for (const t of texts) console.log(JSON.stringify(t));
  } finally {
    await cdp.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
