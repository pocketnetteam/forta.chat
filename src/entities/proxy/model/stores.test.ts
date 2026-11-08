// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useProxyStore, LOCAL_PROXY_ID } from "./stores";

describe("useProxyStore", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("defaults to auto and lists gateways + local", () => {
    const store = useProxyStore();
    expect(store.mode).toBe("auto");
    expect(store.currentSelectionId).toBe("auto");
    const ids = store.listItems.map((i) => i.id);
    expect(ids).toContain("auto");
    expect(ids).toContain("1.pocketnet.app:8899");
    expect(ids).toContain(LOCAL_PROXY_ID);
  });

  it("pins a gateway and reorders base URLs", () => {
    const store = useProxyStore();
    store.select("2.pocketnet.app:8899");
    expect(store.mode).toBe("gateway");
    expect(store.pinnedGatewayId).toBe("2.pocketnet.app:8899");
    expect(store.gatewayBaseUrls()[0]).toBe("https://2.pocketnet.app:8899");
    expect(store.currentLabel).toBe("2.pocketnet.app");
  });

  it("selects local when available", () => {
    const store = useProxyStore();
    // happy-dom hostname is typically localhost → local available
    if (!store.localAvailable) {
      // Force via select no-op path: still verify gate
      store.select(LOCAL_PROXY_ID);
      expect(store.mode).not.toBe("local");
      return;
    }
    store.select(LOCAL_PROXY_ID);
    expect(store.mode).toBe("local");
    expect(store.shouldUseLocal()).toBe(true);
    expect(store.currentLabel).toBe("Local Node Proxy");
  });

  it("persists mode across store recreation", () => {
    const store = useProxyStore();
    store.select("4.pocketnet.app:8899");
    setActivePinia(createPinia());
    const again = useProxyStore();
    expect(again.mode).toBe("gateway");
    expect(again.pinnedGatewayId).toBe("4.pocketnet.app:8899");
  });
});
