#!/usr/bin/env node
/**
 * Live DOM-driven verification for the "stuck at 100%" fix (2026-08-19):
 * navigates to Settings → Local AI, taps download/resume, and watches the
 * visible status text tick through the distinct verifying/loading phase
 * labels instead of sitting frozen on "Скачивание… 100%".
 */
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

async function goToLocalAiSettings(cdp) {
  const texts = await cdp.visibleTexts();
  if (!texts.includes("Размер модели")) {
    // Not already inside Local AI settings — get there. clickByText()
    // itself now prefers a real interactive ancestor over a same-text
    // static label (e.g. a page header also reading "Настройки"), so this
    // is a no-op-safe call even if the nav tab isn't the literal match.
    if (!texts.includes("Локальный AI")) {
      await cdp.clickByText("Настройки");
      await new Promise((r) => setTimeout(r, 400));
    }
    await cdp.clickByText("Локальный AI");
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);

  try {
    await goToLocalAiSettings(cdp);
    let texts = await cdp.visibleTexts();
    const status = () => texts.find((t) => /^(Не скачана|Готова|Скачивание|Пауза|Проверка|Загрузка)/.test(t));
    console.log(`initial status: ${status() ?? "(none)"}`);

    const btn = texts.find((t) => t === "Скачать модель" || t.startsWith("Докачать модель") || t === "Обновить модель");
    if (btn) {
      console.log(`tapping: ${btn}`);
      await cdp.clickByText(btn);
    } else {
      console.log("no download/resume/update button found — model may already be fully ready");
    }

    const seenStatuses = new Set();
    const deadline = Date.now() + 120_000; // up to 2 minutes — verification of a 2.3GB file over the bridge is genuinely slow, that's the whole point being tested
    let lastPrinted = "";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      texts = await cdp.visibleTexts();
      const s = status();
      if (s && s !== lastPrinted) {
        console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
        lastPrinted = s;
      }
      if (s) {
        const phase = s.startsWith("Проверка") ? "verifying" : s.startsWith("Загрузка") ? "loading" : s.startsWith("Скачивание") ? "downloading" : s.startsWith("Готова") ? "ready" : "other";
        seenStatuses.add(phase);
      }
      if (s === "Готова") break;
      if (texts.some((t) => t.startsWith("Не удалось"))) {
        console.log("❌ error surfaced:", texts.find((t) => t.startsWith("Не удалось")));
        break;
      }
    }

    console.log("\nPhases observed:", Array.from(seenStatuses).join(", "));
    console.log(seenStatuses.has("verifying") ? "✅ verifying phase was visible" : "⚠️  verifying phase was not observed (may have been too fast, or already verified)");
    console.log(seenStatuses.has("loading") ? "✅ loading phase was visible" : "⚠️  loading phase was not observed (may have been too fast)");
    console.log(seenStatuses.has("ready") ? "✅ ended in Готова (ready)" : "⚠️  did not reach ready within the time budget");
  } finally {
    await cdp.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
