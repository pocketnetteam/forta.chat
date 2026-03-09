/**
 * Global test setup for Vitest.
 * - Clears localStorage between tests
 * - Mocks `bitcoin` global (bip39, bip32, ECPair, crypto, payments)
 * - Mocks `getMatrixClientService()` with spy functions
 * - Mocks `getPocketnetInstance()` with spy functions
 */
import { afterEach, vi } from "vitest";

// ── Clear localStorage between tests ──────────────────────────────
afterEach(() => {
  localStorage.clear();
});

// ── Mock `bitcoin` global ─────────────────────────────────────────
const mockBitcoin = {
  bip39: {
    generateMnemonic: vi.fn(() => "mock mnemonic phrase"),
    mnemonicToSeed: vi.fn(() => Buffer.alloc(64)),
  },
  bip32: {
    fromSeed: vi.fn(() => ({
      derivePath: vi.fn(() => ({
        publicKey: Buffer.alloc(33),
        privateKey: Buffer.alloc(32),
      })),
    })),
  },
  ECPair: {
    fromPrivateKey: vi.fn(() => ({
      publicKey: Buffer.alloc(33),
      sign: vi.fn(() => Buffer.alloc(64)),
    })),
  },
  crypto: {
    sha256: vi.fn((buf: Buffer) => buf),
  },
  payments: {
    p2pkh: vi.fn(() => ({ address: "PMockAddress1234567890123456789012" })),
  },
  TransactionBuilder: vi.fn(() => ({
    addInput: vi.fn(),
    addOutput: vi.fn(),
    sign: vi.fn(),
    build: vi.fn(() => ({
      toHex: vi.fn(() => "mockhex"),
      virtualSize: vi.fn(() => 250),
      getId: vi.fn(() => "mocktxid"),
    })),
  })),
};

(globalThis as any).bitcoin = mockBitcoin;

// ── Mock getMatrixClientService ───────────────────────────────────
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    kit: {
      client: {
        sendEvent: vi.fn(),
        redactEvent: vi.fn(),
        scrollback: vi.fn(),
        setRoomTopic: vi.fn(),
        sendStateEvent: vi.fn(),
        getUserId: vi.fn(() => "@mockuser:server"),
      },
      isTetatetChat: vi.fn(() => true),
      getRoomMembers: vi.fn(() => []),
    },
    sendText: vi.fn(),
    sendEncryptedText: vi.fn(),
    sendFile: vi.fn(),
    redactEvent: vi.fn(),
    scrollback: vi.fn(),
    joinRoom: vi.fn(),
    createRoom: vi.fn(),
  })),
  resetMatrixClientService: vi.fn(),
  MatrixClientService: vi.fn(),
}));

// ── Mock getPocketnetInstance ──────────────────────────────────────
vi.mock("@/shared/api/sdk-bridge", () => ({
  getPocketnetInstance: vi.fn(() => ({
    user: {
      address: { value: "PMockAddress1234567890123456789012" },
      keys: vi.fn(() => ({
        publicKey: Buffer.alloc(33),
        sign: vi.fn(() => Buffer.alloc(64)),
      })),
    },
    api: {
      rpc: vi.fn(),
    },
  })),
  getBitcoinLib: vi.fn(() => (globalThis as any).bitcoin),
}));
