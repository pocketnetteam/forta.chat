#!/usr/bin/env node
/** Verifies clicking "Переключиться" on an already-resident, inactive
 *  model switches instantly (no re-download bar reaching 0%→X% over the
 *  network) — multi-model UI rework, 2026-08-21. */
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);

  try {
    const clicked = await cdp.evalJs(`
      (function () {
        var rows = document.querySelectorAll('.rounded-xl');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].textContent.includes('Qwen3 4B')) {
            var buttons = rows[i].querySelectorAll('button');
            var btn = buttons[buttons.length - 1];
            if (btn) { btn.click(); return btn.textContent.trim(); }
          }
        }
        return null;
      })()
    `);
    console.log("clicked button on Qwen3 4B row, label was:", clicked);

    // Sample texts a few times over the next few seconds — an instant
    // switch should skip straight to "Загрузка модели в память…" (no
    // "Скачивание… 0%"/"1%"/etc network phase at all).
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const texts = await cdp.visibleTexts();
      const status = texts.find((t) => /^(Скачивание|Загрузка|Активна|Переключиться|Проверка)/.test(t));
      console.log(`t+${(i + 1) * 0.7}s:`, status ?? "(none)");
    }
  } finally {
    await cdp.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
