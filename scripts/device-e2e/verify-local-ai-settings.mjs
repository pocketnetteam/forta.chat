#!/usr/bin/env node
/**
 * DOM-driven (not screenshot-driven) live verification for Settings →
 * Local AI — see cdp-client.mjs's doc comment for why. Drives the app
 * purely through its own DOM (click by visible text, read visible text
 * back), reporting pass/fail per assertion instead of a human eyeballing
 * screenshots. Navigation is by clicking the real bottom-nav/list items —
 * this app's tab state lives in a Pinia store (useSidebarTab), not the
 * router, so `location.hash` assignment is a no-op here.
 */
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

let failures = 0;
function ok(label, condition) {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) failures++;
}

async function goToLocalAiSettings(cdp) {
  await cdp.clickByText("Настройки", "*");
  await new Promise((r) => setTimeout(r, 400));
  await cdp.clickByText("Локальный AI", "*");
  await new Promise((r) => setTimeout(r, 400));
}

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);

  try {
    await goToLocalAiSettings(cdp);
    let texts = await cdp.visibleTexts();
    ok("landed on Local AI settings", texts.includes("Локальный AI") && texts.some((t) => t.includes("Офлайн AI-чат")));

    const hasDeleteOrDiscard = () => texts.some((t) => t === "Удалить модель" || t === "Отменить загрузку");
    const hasPause = () => texts.some((t) => t === "Пауза");
    const hasResume = () => texts.some((t) => t === "Возобновить");
    const status = () => texts.find((t) => /^(Не скачана|Готова|Скачивание|Пауза)/.test(t));

    console.log(`initial status: ${status() ?? "(none)"}, delete/discard: ${hasDeleteOrDiscard()}`);

    // Start a fresh download if nothing is in flight yet, so the
    // active-download / paused states below are genuine, not assumed.
    if (!texts.some((t) => t.startsWith("Скачивание")) && !hasResume()) {
      const downloadBtn = texts.find((t) => t === "Скачать модель" || t.startsWith("Докачать модель"));
      if (downloadBtn) {
        await cdp.clickByText(downloadBtn);
        await new Promise((r) => setTimeout(r, 1500)); // let the first real onProgress tick land
        texts = await cdp.visibleTexts();
      }
    }

    console.log(`after starting download — status: ${status() ?? "(none)"}`);

    // The actual regression under test: delete/discard must never be
    // visible at the same time as an active (un-paused) download.
    if (status()?.startsWith("Скачивание")) {
      ok("delete/discard is hidden while actively (un-paused) downloading", !hasDeleteOrDiscard());
      ok("Pause button is present while actively downloading", hasPause());

      await cdp.clickByText("Пауза");
      await new Promise((r) => setTimeout(r, 800));
      texts = await cdp.visibleTexts();
      console.log(`after pausing — status: ${status() ?? "(none)"}`);

      ok("Resume button appears once paused", hasResume());
      ok("delete/discard reappears once paused", hasDeleteOrDiscard());
      ok(
        "delete/discard reads 'Отменить загрузку' (not 'Удалить модель') for a paused, not-yet-complete download",
        texts.includes("Отменить загрузку") && !texts.includes("Удалить модель"),
      );
    } else {
      console.log("⚠️  no active download to test against (no network, or manifest unavailable) — skipping the live pause/delete assertions");
    }
  } finally {
    await cdp.disconnect();
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
