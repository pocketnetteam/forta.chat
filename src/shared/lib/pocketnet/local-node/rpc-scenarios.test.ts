import { describe, it, expect, vi } from "vitest";
import { hasRpcScenario, runFeedScenario } from "./rpc-scenarios";

describe("rpc-scenarios", () => {
  it("recognises Forta feed methods", () => {
    expect(hasRpcScenario("getprofilefeed")).toBe(true);
    expect(hasRpcScenario("getsubscribesfeed")).toBe(true);
    expect(hasRpcScenario("getnodeinfo")).toBe(false);
  });

  it("enriches getprofilefeed with users", async () => {
    const rpc = vi.fn(async (method: string, parameters: unknown[]) => {
      if (method === "getprofilefeed") {
        return [{ address: "PAuthor", txid: "1", lastComment: { address: "PCommenter" } }];
      }
      if (method === "getuserprofile") {
        expect(parameters[0]).toEqual(["PAuthor", "PCommenter"]);
        return [{ address: "PAuthor", name: "A" }];
      }
      throw new Error(`unexpected ${method}`);
    });

    const out = await runFeedScenario("getprofilefeed", {
      parameters: ["PAuthor"],
      rpc,
    });

    expect(out.contents).toHaveLength(1);
    expect(out.users).toEqual([{ address: "PAuthor", name: "A" }]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
