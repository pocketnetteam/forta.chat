import { findAdb } from "../find-adb.mjs";
import { findWebviewSocket, connectCdp } from "./cdp-client.mjs";
const adbPath = findAdb();
const socket = await findWebviewSocket(adbPath, "com.forta.chat");
const cdp = await connectCdp(adbPath, socket);
try {
  await cdp.clickByText("AI", "*");
  console.log("clicked AI");
} finally {
  cdp.disconnect();
}
