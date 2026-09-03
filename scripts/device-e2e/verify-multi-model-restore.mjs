#!/usr/bin/env node
/**
 * One-off verification for the restoreModelIfPreviouslyDownloaded() legacy-
 * marker fallback fix (2026-08-21) — reads whatever screen is currently up
 * on the device and, if not already on Settings → Local AI, navigates
 * there first. See local-ai-store.ts's restoreModelIfPreviouslyDownloaded()
 * doc comment for the bug this checks.
 */
import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);

  try {
    let texts = await cdp.visibleTexts();
    if (!texts.some((t) => t.includes("Офлайн AI-чат"))) {
      if (texts.some((t) => t === "Настройки")) await cdp.clickByText("Настройки", "*");
      await new Promise((r) => setTimeout(r, 500));
      texts = await cdp.visibleTexts();
      if (texts.some((t) => t === "Локальный AI")) await cdp.clickByText("Локальный AI", "*");
      await new Promise((r) => setTimeout(r, 500));
      texts = await cdp.visibleTexts();
    }
    console.log("--- visible texts ---");
    for (const t of texts) console.log(JSON.stringify(t));
  } finally {
    await cdp.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
