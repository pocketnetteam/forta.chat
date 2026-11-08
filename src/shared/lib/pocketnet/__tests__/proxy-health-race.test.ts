import { describe, it, expect, vi, beforeEach } from "vitest";
import { pingGateway, raceGateways, pingLocal } from "../proxy-health-race";

function okResponse(json: unknown = { data: { height: 1 } }): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response;
}

describe("pingGateway", () => {
  it("returns ok on HTTP 200", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => okResponse());
    const r = await pingGateway("https://1.pocketnet.app:8899", {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://1.pocketnet.app:8899/rpc/getnodeinfo",
    );
  });

  it("returns not ok on network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    const r = await pingGateway("https://1.pocketnet.app:8899", {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("down");
  });
});

describe("raceGateways", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("picks the first successful responder as winner", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("2.pocketnet")) {
        await new Promise((r) => setTimeout(r, 20));
        return okResponse();
      }
      await new Promise((r) => setTimeout(r, 5));
      return okResponse();
    });
    const { winner } = await raceGateways(
      ["https://2.pocketnet.app:8899", "https://1.pocketnet.app:8899"],
      5_000,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expect(winner).toBe("https://1.pocketnet.app:8899");
  });

  it("returns null winner when all fail within budget", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fail");
    });
    const { winner, results } = await raceGateways(
      ["https://1.pocketnet.app:8899", "https://2.pocketnet.app:8899"],
      1_000,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expect(winner).toBeNull();
    expect(results.every((r) => !r.ok)).toBe(true);
  });

  it("returns null for empty list", async () => {
    await expect(raceGateways([])).resolves.toEqual({ winner: null, results: [] });
  });

  it("decision window does not abort slow pings; late winner callback fires", async () => {
    const onLateWinner = vi.fn();
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return okResponse();
    });
    const { winner } = await raceGateways(["https://1.pocketnet.app:8899"], 30, {
      fetchImpl: fetchImpl as typeof fetch,
      timeoutMs: 5_000,
      onLateWinner,
    });
    expect(winner).toBeNull();
    await new Promise((r) => setTimeout(r, 120));
    expect(onLateWinner).toHaveBeenCalledWith("https://1.pocketnet.app:8899");
  });
});

describe("pingLocal", () => {
  it("returns true when ping resolves true", async () => {
    await expect(pingLocal({ ping: async () => true, timeoutMs: 100 })).resolves.toBe(true);
  });

  it("returns false on timeout", async () => {
    await expect(
      pingLocal({
        ping: () => new Promise(() => undefined),
        timeoutMs: 30,
      }),
    ).resolves.toBe(false);
  });

  it("returns false when ping throws", async () => {
    await expect(
      pingLocal({
        ping: async () => {
          throw new Error("x");
        },
        timeoutMs: 100,
      }),
    ).resolves.toBe(false);
  });
});
