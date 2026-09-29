import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: an app launched without network never connected to Matrix after the network came
 * back. `initMatrix()` gave up after three quick attempts, the chat list had already rendered
 * from Dexie, and nothing called it again until the app restarted (Samsung, `online2`: 91 s
 * online without `matrixReady`, ready 6 s after a restart). The store wiring is checked in
 * source — `initMatrix` needs the SDK, Pcrypto and Dexie — and the trigger logic by behaviour in
 * `matrix-reconnect.test.ts`.
 */
// Normalised to LF: a Windows checkout (core.autocrlf) has CRLF line endings,
// and the slices below match on "\n".
const source = readFileSync(resolve(__dirname, "../stores.ts"), "utf-8").replace(/\r\n/g, "\n");

function sliceBetween(from: string, to: string, start = 0): string {
  const a = source.indexOf(from, start);
  expect(a, `${from} not found`).toBeGreaterThan(-1);
  const b = source.indexOf(to, a + from.length);
  expect(b, `${to} not found after ${from}`).toBeGreaterThan(a);
  return source.slice(a, b);
}

describe("auth store: Matrix start retried after a failure", () => {
  it("imports the reconnect helper", () => {
    expect(source).toMatch(/import \{ armMatrixReconnect, onForeground \} from "\.\.\/lib\/matrix-reconnect";/);
  });

  it("retries only while signed in, not ready and no start is in flight", () => {
    const arm = sliceBetween("const armMatrixReconnectAfterFailure = (startedOffline: boolean) => {", "\n  };");
    expect(arm).toContain("stopMatrixReconnect();");
    expect(arm).toContain("armMatrixReconnect(");
    expect(arm).toContain("onConnectivityChange");
    expect(arm).toContain("onForeground");
    expect(arm).toContain("!matrixReady.value");
    expect(arm).toContain("!_initMatrixPromise");
    expect(arm).toContain("address.value");
    expect(arm).toContain("privateKey.value");
    expect(arm).toContain("initMatrix()");
  });

  it("retries on its own only when a start that began offline failed with the network back", () => {
    const arm = sliceBetween("const armMatrixReconnectAfterFailure = (startedOffline: boolean) => {", "\n  };");
    expect(arm).toMatch(/retryAfterMs: startedOffline && useConnectivity\(\)\.isOnline\.value \? \d[\d_]* : undefined/);
    const start = sliceBetween("const initMatrixInner = async () => {", "matrixReady.value = false;");
    expect(start).toContain("const startedOffline = !useConnectivity().isOnline.value;");
  });

  it("arms after the connection gives up and after an init error", () => {
    const notReady = sliceBetween("[auth] Matrix client NOT ready after", "} catch (e) {");
    expect(notReady).toContain("armMatrixReconnectAfterFailure(startedOffline);");
    const initError = sliceBetween('console.error("[auth] Matrix init error:", e);', "\n    }\n");
    expect(initError).toContain("armMatrixReconnectAfterFailure(startedOffline);");
  });

  it("disarms once Matrix is ready", () => {
    const ready = sliceBetween("if (connectResult.ready) {", "matrixError.value = null;");
    expect(ready).toContain("stopMatrixReconnect();");
  });

  it("disarms wherever the session's listeners are torn down", () => {
    const teardowns = source.split("if (_connectivityUnsub) { _connectivityUnsub(); _connectivityUnsub = null; }");
    expect(teardowns.length).toBeGreaterThanOrEqual(3);
    for (const after of teardowns.slice(1)) {
      expect(after.slice(0, 200)).toContain("stopMatrixReconnect();");
    }
  });
});
