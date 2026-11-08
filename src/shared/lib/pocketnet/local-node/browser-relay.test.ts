import { describe, it, expect, vi } from "vitest";
import {
  applyBrowserRelay,
  buildBrowserRelay,
  DEFAULT_LOCAL_NODE_CORS_RELAY,
  parseNodeRpcUrl,
  shouldUseBrowserRelay,
} from "./browser-relay";
import { localNodeRequest } from "./transport";

describe("parseNodeRpcUrl", () => {
  it("parses cleartext public URL", () => {
    expect(parseNodeRpcUrl("http://5.189.141.204:38081/public/")).toEqual({
      host: "5.189.141.204",
      port: "38081",
      tls: false,
      rpcPath: "/public/",
    });
  });

  it("parses tls post URL", () => {
    expect(parseNodeRpcUrl("https://node.example:38881/post/")).toEqual({
      host: "node.example",
      port: "38881",
      tls: true,
      rpcPath: "/post/",
    });
  });

  it("rejects non-rpc paths", () => {
    expect(parseNodeRpcUrl("http://1.2.3.4:38081/other/")).toBeNull();
  });
});

describe("shouldUseBrowserRelay", () => {
  it("is false on native", () => {
    expect(shouldUseBrowserRelay({ isNative: true, hostname: "localhost" })).toBe(false);
  });

  it("is true on localhost", () => {
    expect(shouldUseBrowserRelay({ isNative: false, hostname: "localhost" })).toBe(true);
    expect(shouldUseBrowserRelay({ isNative: false, hostname: "127.0.0.1" })).toBe(true);
  });

  it("is false on production hostnames", () => {
    expect(shouldUseBrowserRelay({ isNative: false, hostname: "forta.chat" })).toBe(false);
  });

  it("honours force flag", () => {
    expect(
      shouldUseBrowserRelay({
        isNative: false,
        hostname: "forta.chat",
        forceLocalNodeProxy: true,
      }),
    ).toBe(true);
    expect(
      shouldUseBrowserRelay({
        isNative: false,
        hostname: "localhost",
        forceLocalNodeProxy: false,
      }),
    ).toBe(false);
  });
});

describe("buildBrowserRelay", () => {
  it("rewrites to default relay with X-Node headers", () => {
    const r = buildBrowserRelay("http://10.0.0.1:38081/public/", {
      rpcMethod: "getnodeinfo",
    });
    expect(r).toEqual({
      url: `${DEFAULT_LOCAL_NODE_CORS_RELAY}/public/getnodeinfo`,
      headers: {
        "X-Node-Host": "10.0.0.1",
        "X-Node-Port": "38081",
        "X-Node-TLS": "0",
      },
      parsed: {
        host: "10.0.0.1",
        port: "38081",
        tls: false,
        rpcPath: "/public/",
      },
    });
  });

  it("sets TLS header for https seeds", () => {
    const r = buildBrowserRelay("https://seed.example:38881/post/");
    expect(r?.headers["X-Node-TLS"]).toBe("1");
    expect(r?.url).toBe(`${DEFAULT_LOCAL_NODE_CORS_RELAY}/post/`);
  });
});

describe("applyBrowserRelay / localNodeRequest", () => {
  it("returns relaydisabled when gate is closed", () => {
    const r = applyBrowserRelay(
      { url: "http://1.2.3.4:38081/public/" },
      { isNative: false, hostname: "forta.chat" },
    );
    expect(r).toEqual({ ok: false, code: -1, message: "relaydisabled" });
  });

  it("localNodeRequest fetches via relay URL on localhost", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${DEFAULT_LOCAL_NODE_CORS_RELAY}/public/getnodeinfo`);
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Node-Host"]).toBe("1.2.3.4");
      expect(headers["X-Node-Port"]).toBe("38081");
      expect(headers["X-Node-TLS"]).toBe("0");
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { height: 1 } }),
      } as Response;
    });

    const body = await localNodeRequest(
      {
        url: "http://1.2.3.4:38081/public/",
        body: { jsonrpc: "2.0", method: "getnodeinfo", params: [], id: 1 },
      },
      {
        isNative: false,
        hostname: "localhost",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(body).toEqual({ result: { height: 1 } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("localNodeRequest rejects relaydisabled without hitting IP", async () => {
    const fetchImpl = vi.fn();
    await expect(
      localNodeRequest(
        { url: "http://1.2.3.4:38081/public/" },
        {
          isNative: false,
          hostname: "forta.chat",
          fetchImpl: fetchImpl as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: -1, message: "relaydisabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
