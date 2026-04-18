import { createKeyPair } from "./key-pair";

/** Async wrapper around createKeyPair that offloads the expensive BIP39
 *  mnemonicToSeedSync (PBKDF2 2048 rounds) to a Web Worker where supported.
 *
 *  Why: On Android 7 / low-end devices the sync path can take >10s on the
 *  main thread and trigger ANR. Offloading to a worker keeps the UI
 *  responsive. For private-key inputs (not mnemonics) the sync path is cheap,
 *  so we delegate directly to createKeyPair.
 *
 *  When Worker is unavailable (old WebViews, SSR, test environment) we fall
 *  back to the synchronous createKeyPair so behavior is preserved.
 */
export async function createKeyPairAsync(
  cryptoCredential: string,
): Promise<{ privateKey: Buffer; publicKey: Buffer }> {
  // Non-mnemonic (private key / WIF) — cheap, sync path is fine.
  const isMnemonic =
    typeof bitcoin !== "undefined" &&
    bitcoin.bip39 &&
    bitcoin.bip39.validateMnemonic(cryptoCredential);
  if (!isMnemonic) return createKeyPair(cryptoCredential);

  // Worker not available — fall back with a warning. bitcoin.* is loaded as a
  // global in index.html, so we still need it on the main thread for the
  // bip32/ECPair work even when a worker is used.
  if (typeof Worker === "undefined") {
    console.warn(
      "[key-pair-async] Worker unavailable, falling back to sync mnemonicToSeedSync",
    );
    return createKeyPair(cryptoCredential);
  }

  try {
    const worker = new Worker(
      new URL("../../../shared/lib/crypto-worker/key-pair.worker.ts", import.meta.url),
      { type: "module" },
    );
    const seedHex = await new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        worker.terminate();
        reject(new Error("key-pair worker timed out"));
      }, 30_000);

      worker.onmessage = (e: MessageEvent<{ seed?: string; error?: string }>) => {
        clearTimeout(timeoutId);
        worker.terminate();
        if (e.data?.error) return reject(new Error(e.data.error));
        if (e.data?.seed) return resolve(e.data.seed);
        reject(new Error("key-pair worker: empty response"));
      };
      worker.onerror = (err) => {
        clearTimeout(timeoutId);
        worker.terminate();
        reject(err);
      };
      worker.postMessage({ mnemonic: cryptoCredential });
    });

    // Finish derivation on the main thread using the pre-computed seed.
    const seed = Buffer.from(seedHex, "hex");
    const node = bitcoin.bip32.fromSeed(seed);
    const childNode = node.derivePath(`m/44'/0'/0'/0'`);
    const wif = childNode.toWIF();
    return bitcoin.ECPair.fromWIF(wif);
  } catch (err) {
    console.warn(
      "[key-pair-async] Worker failed, falling back to sync path:",
      err,
    );
    return createKeyPair(cryptoCredential);
  }
}
