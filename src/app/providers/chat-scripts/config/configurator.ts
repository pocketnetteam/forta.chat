/** Hex-encode a string: each char → 2-digit hex of its char code. */
function hexEncode(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    let ch = text.charCodeAt(i);
    if (ch > 0xff) ch -= 0x350;
    let hex = ch.toString(16);
    while (hex.length < 2) hex = "0" + hex;
    result += hex;
  }
  return result;
}

export class PocketnetInstanceConfigurator {
  static setTimeDifference(value: number) {
    window.POCKETNETINSTANCE.platform.timeDifference = value;
  }

  static setUserAddress(value: string) {
    window.POCKETNETINSTANCE.user.address.value = value;
  }

  static setUserGetKeyPairFc(getKeyPairFc: () => { privateKey: Buffer; publicKey: Buffer }) {
    window.POCKETNETINSTANCE.user.keys = getKeyPairFc;

    // Set up getstate() and signature() so the SDK's fetchauth sign() works.
    // Matches pocketnet/js/user.js signature implementation.
    window.POCKETNETINSTANCE.user.getstate = () => 1;

    window.POCKETNETINSTANCE.user.signature = (session?: string) => {
      const str = session || "pocketnetproxy";
      const exp = 360;
      const keyPair = getKeyPairFc() as { privateKey: Buffer; publicKey: Buffer; sign(hash: Buffer): Buffer };
      const currentMomentInUTC = new Date().toISOString();
      const nonce = "date=" + currentMomentInUTC + ",exp=" + exp + ",s=" + hexEncode(str);
      const hash = bitcoin.crypto.sha256(Buffer.from(nonce));
      const sig = keyPair.sign(hash);

      return {
        nonce,
        signature: sig.toString("hex"),
        pubkey: keyPair.publicKey.toString("hex"),
        address: window.POCKETNETINSTANCE.user.address.value!,
        v: 1,
      };
    };
  }
}
