/* eslint-disable no-var */

/** Bastyon SDK global type declarations */

interface BitcoinLib {
  crypto: {
    sha256(data: Buffer): Buffer;
    hash160(data: Buffer): Buffer;
    ripemd160(data: Buffer): Buffer;
  };
  bip39: {
    validateMnemonic(mnemonic: string): boolean;
    mnemonicToSeedSync(mnemonic: string): Buffer;
    entropyToMnemonic(entropy: Buffer): string;
    generateMnemonic(): string;
  };
  bip32: {
    fromSeed(seed: Buffer): {
      derivePath(path: string): {
        toWIF(): string;
        privateKey: Buffer;
        publicKey: Buffer;
      };
    };
  };
  ECPair: {
    fromWIF(wif: string): { privateKey: Buffer; publicKey: Buffer };
    fromPrivateKey(buffer: Buffer): { privateKey: Buffer; publicKey: Buffer };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ecc: any;
  payments: {
    p2pkh(opts: { pubkey: Buffer }): { address: string };
    embed(opts: { data: Buffer[] }): { output: Buffer };
    [key: string]: (opts: { pubkey: Buffer }) => { address: string };
  };
  networks: {
    bitcoin: { pubKeyHash: number; scriptHash: number; wif: number };
    [key: string]: { pubKeyHash: number; scriptHash: number; wif: number };
  };
  TransactionBuilder: new (network?: unknown) => {
    addInput(txId: string, vout: number, sequence?: number | null, scriptPubKey?: Buffer): void;
    addOutput(address: string | Buffer, amount: number): void;
    sign(index: number, keyPair: { privateKey: Buffer; publicKey: Buffer }): void;
    build(): { toHex(): string; getId(): string; virtualSize(): number };
    setLockTime(n: number): void;
  };
}

interface PocketnetInstanceType {
  apiHandlers: { error: () => null; success: () => null };
  menuOpen: () => void;
  mobile: { supportimagegallery: () => null };
  options: {
    address: string;
    backmap: undefined;
    device: string;
    fingerPrint: string;
    firebase: string;
    fullName: string;
    imageServer: string;
    imageServerup1: string;
    imageStorage: string;
    listofnodes: null;
    listofproxies: Array<{ host: string; port: number; wss: number }>;
    localStoragePrefix: string;
    matrix: string;
    name: string;
    nav: { navPrefix: string };
    rtc: string;
    rtchttp: string;
    rtcws: string;
    server: string;
    url: string;
  };
  platform: {
    matrixchat: { link: () => null };
    sdk: {
      syncStorage: {
        eventListeners: Record<string, Record<string, (e: StorageEvent) => void>>;
        _storageHandler: ((e: StorageEvent) => void) | null;
        init(): void;
        off(eventType: string, lStorageProp: string): void;
        on(eventType: string, lStorageProp: string, callback: (e: StorageEvent) => void): void;
      };
      /** Wallet API — only available when running inside Bastyon main app */
      wallet?: {
        txbase(
          inputs: string[],
          outputs: Array<{ address: string; amount: number }>,
          fees: number,
          feeDirection: string,
          callback: (err: unknown, inputs: unknown[], outputs: unknown[]) => void,
        ): void;
        embed(outputs: unknown[], message: string): void;
        saveTempInfoWallet(txId: string, inputs: unknown[], outputs: unknown[]): void;
      };
      /** Address API — only available when running inside Bastyon main app */
      address?: {
        pnet(): { address: string };
      };
      /** Node API — only available when running inside Bastyon main app */
      node?: {
        fee: {
          estimate(callback: (fees: { feerate: number }) => void): void;
        };
        transactions: {
          get: {
            canSpend(address: string, callback: (balance: number) => void): void;
          };
          create: {
            wallet(inputs: unknown[], outputs: unknown[]): { virtualSize(): number };
          };
          send(tx: unknown, callback: (txId: string, err?: unknown) => void): void;
          releaseCS(inputs: unknown[]): void;
          clearUnspents(txIds: string[]): void;
        };
      };
    };
    timeDifference: number;
    whiteList: string[];
  };
  user: {
    address: { value: string | null };
    keys: (() => { privateKey: Buffer; publicKey: Buffer; sign?: (hash: Buffer) => Buffer }) | null;
    getstate?: () => number;
    signature?: (session?: string) => {
      nonce: string;
      signature: string;
      pubkey: string;
      address: string;
      v: number;
    };
  };
}

declare var bitcoin: BitcoinLib;
declare var Api: new (instance: PocketnetInstanceType) => {
  initIf(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc(method: string, params?: unknown[], options?: { fnode?: string; node?: string; ex?: boolean }): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchauth(path: string, data?: unknown, options?: { proxy?: string }): Promise<any>;
  get: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proxywithwallet(): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proxywithwalletls(): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    byid(id: string): any;
  };
  wait: { ready(type: string, timeout: number): Promise<void> };
  ready: { use: boolean };
};
declare var Actions: new (instance: PocketnetInstanceType, api: InstanceType<typeof Api>) => {
  init(): void;
  prepare(): void;
  addAccount(address: string): void;
  addActionAndSendIfCan(info: unknown, arg: null, address: string): Promise<unknown>;
};
declare var pSDK: new (opts: {
  actions: InstanceType<typeof Actions>;
  api: InstanceType<typeof Api>;
  app: PocketnetInstanceType;
}) => {
  userInfo: {
    load(addresses: string[], light?: boolean, reload?: boolean): Promise<void>;
    get(address: string): UserDataSDK;
  };
};
declare var UserInfo: new () => {
  name: { set(v: string): void };
  language: { set(v: string): void };
  about: { set(v: string): void };
  site: { set(v: string): void };
  image: { set(v: string): void };
  addresses: { set(v: string[]): void };
  ref: { set(v: unknown): void };
  keys: { set(v: unknown): void };
};
declare var superXSS: (value: string) => string;

interface UserDataSDK {
  about: string;
  addresses: string[];
  image: string;
  keys: unknown;
  language: string;
  name: string;
  ref: unknown;
  site: string;
  reputation?: number;
  subscribers_count?: number;
}

interface Window {
  POCKETNETINSTANCE: PocketnetInstanceType;
  testpocketnet: boolean;
  storage_tab: number;
}
