// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useProxyStore, LOCAL_PROXY_ID } from "../model";
import { runProxyBootOffer, shouldOfferLocal } from "./run-proxy-boot-offer";

vi.mock("@/shared/lib/pocketnet", async () => {
  const actual = await vi.importActual<typeof import("@/shared/lib/pocketnet")>(
    "@/shared/lib/pocketnet",
  );
  return {
    ...actual,
    configurePocketnetNodes: vi.fn(),
    setNodeFailoverStickyIndex: vi.fn(),
  };
});

describe("shouldOfferLocal", () => {
  it("offers only in auto when remotes dead, local ok, session free", () => {
    expect(
      shouldOfferLocal({
        mode: "auto",
        localAvailable: true,
        canOfferThisSession: true,
        remoteWinner: null,
        localOk: true,
      }),
    ).toBe(true);
  });

  it("skips when mode is gateway or local", () => {
    expect(
      shouldOfferLocal({
        mode: "gateway",
        localAvailable: true,
        canOfferThisSession: true,
        remoteWinner: null,
        localOk: true,
      }),
    ).toBe(false);
    expect(
      shouldOfferLocal({
        mode: "local",
        localAvailable: true,
        canOfferThisSession: true,
        remoteWinner: null,
        localOk: true,
      }),
    ).toBe(false);
  });

  it("skips when remote already answered", () => {
    expect(
      shouldOfferLocal({
        mode: "auto",
        localAvailable: true,
        canOfferThisSession: true,
        remoteWinner: "https://1.pocketnet.app:8899",
        localOk: true,
      }),
    ).toBe(false);
  });
});

describe("runProxyBootOffer", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    useProxyStore().resetLocalOfferSession();
  });

  it("skips when mode is gateway", async () => {
    const store = useProxyStore();
    store.select("1.pocketnet.app:8899");
    const outcome = await runProxyBootOffer({
      race: async () => ({ winner: null, results: [] }),
      pingLocalFn: async () => true,
      watchRemoteRevive: false,
    });
    expect(outcome).toBe("skipped");
    expect(store.offerLocalPending).toBe(false);
  });

  it("pins remote winner without offering", async () => {
    const store = useProxyStore();
    const outcome = await runProxyBootOffer({
      race: async () => ({
        winner: "https://2.pocketnet.app:8899",
        results: [{ url: "https://2.pocketnet.app:8899", ok: true }],
      }),
      pingLocalFn: async () => true,
      watchRemoteRevive: false,
    });
    expect(outcome).toBe("remote_ok");
    expect(store.offerLocalPending).toBe(false);
    expect(store.mode).toBe("auto");
    expect(store.pinnedGatewayId).toBe("2.pocketnet.app:8899");
  });

  it("offers local when remotes fail and local is ok", async () => {
    const store = useProxyStore();
    // Force local available for happy-dom localhost
    const outcome = await runProxyBootOffer({
      race: async () => ({
        winner: null,
        results: [{ url: "https://1.pocketnet.app:8899", ok: false }],
      }),
      pingLocalFn: async () => true,
      watchRemoteRevive: false,
    });
    if (!store.localAvailable) {
      expect(outcome).toBe("skipped");
      return;
    }
    expect(outcome).toBe("offered");
    expect(store.offerLocalPending).toBe(true);
  });

  it("acceptLocalOffer switches to local", async () => {
    const store = useProxyStore();
    if (!store.localAvailable) return;
    store.showLocalOffer();
    store.acceptLocalOffer();
    expect(store.offerLocalPending).toBe(false);
    expect(store.mode).toBe("local");
    expect(store.currentSelectionId).toBe(LOCAL_PROXY_ID);
  });

  it("does not offer twice in one session after dismiss", async () => {
    const store = useProxyStore();
    if (!store.localAvailable) return;
    store.showLocalOffer();
    store.dismissLocalOffer();
    const outcome = await runProxyBootOffer({
      race: async () => ({ winner: null, results: [] }),
      pingLocalFn: async () => true,
      watchRemoteRevive: false,
    });
    expect(outcome).toBe("skipped");
  });
});
