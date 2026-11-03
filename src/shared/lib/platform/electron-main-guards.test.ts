import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const main = readFileSync(resolve(__dirname, "../../../../electron/main.cjs"), "utf-8");

function handler(channel: string): string {
  const start = main.indexOf(`ipcMain.handle("${channel}"`);
  expect(start, channel).toBeGreaterThan(-1);
  return main.slice(start, main.indexOf("\n    });", start));
}

describe("electron main process", () => {
  // Regression: "Save" wrote the sender-named file and opened it at once, so a
  // received .exe / .bat / .command ran when the user only meant to save it.
  it("reveals a saved file instead of opening it", () => {
    const save = handler("file:save");
    expect(save).not.toMatch(/shell\.openPath/);
    expect(save).toMatch(/shell\.showItemInFolder\(filePath\)/);
    expect(save).toMatch(/path\.basename\(fileName\)/);
    expect(save).toMatch(/typeof fileName !== "string"/);
  });

  // Regression: no display-media handler, so getDisplayMedia was rejected and
  // the call's screen-share button always failed on desktop.
  it("answers getDisplayMedia for calls", () => {
    expect(main).toMatch(/setDisplayMediaRequestHandler\(/);
    expect(main).toMatch(/desktopCapturer\s*\.getSources\(\{ types: \["screen"\] \}\)/);
  });
});
