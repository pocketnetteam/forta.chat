import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";
const adbPath = findAdb();
const socket = await findWebviewSocket(adbPath, "com.forta.chat");
const cdp = await connectCdp(adbPath, socket);
try {
  await new Promise((r) => setTimeout(r, 500));
  await cdp.clickByText("New chat", "*");
  console.log("clicked New chat");
  await new Promise((r) => setTimeout(r, 800));
  const hasTextarea = await cdp.evalJs("!!document.querySelector('textarea')");
  console.log("textarea present:", hasTextarea);
} finally {
  cdp.disconnect();
}
