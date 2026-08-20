import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";

async function main() {
  const adbPath = findAdb();
  const socket = await findWebviewSocket(adbPath, "com.forta.chat");
  const cdp = await connectCdp(adbPath, socket);
  try {
    const texts = await cdp.visibleTexts();
    console.log(JSON.stringify(texts, null, 1));
  } finally {
    cdp.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
