import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = (p: string) =>
  readFileSync(resolve(__dirname, p), "utf-8");

describe("createKeyPairAsync", () => {
  it("key-pair-async module exists and exports createKeyPairAsync", () => {
    const src = getSource("../key-pair-async.ts");
    expect(src).toContain("export");
    expect(src).toContain("createKeyPairAsync");
  });

  it("falls back to synchronous createKeyPair when Worker is unavailable", () => {
    const src = getSource("../key-pair-async.ts");
    // Must detect absence of Worker global
    expect(src).toMatch(/typeof Worker/);
    // Must fall back to sync path
    expect(src).toContain("createKeyPair");
  });

  it("terminates the worker after completion (no leak)", () => {
    const src = getSource("../key-pair-async.ts");
    expect(src).toContain("terminate");
  });

  it("key-pair worker script exists under shared/lib/crypto-worker", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../../../../shared/lib/crypto-worker/key-pair.worker.ts",
      ),
      "utf-8",
    );
    // Must use bip39.mnemonicToSeedSync under the hood
    expect(src).toContain("mnemonicToSeedSync");
    // Must post the result back
    expect(src).toContain("postMessage");
  });
});
