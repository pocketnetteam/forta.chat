import { describe, it, expect } from "vitest";
import { classifyRpcMethod, isRpcAllowed, pathForRpcMethod } from "./allowlist";

describe("local-node allowlist", () => {
  it("classifies public / post / private", () => {
    expect(classifyRpcMethod("getnodeinfo")).toBe("public");
    expect(classifyRpcMethod("getuserprofile")).toBe("public");
    expect(classifyRpcMethod("sendrawtransaction")).toBe("post");
    expect(classifyRpcMethod("getbalance")).toBe("private");
    expect(classifyRpcMethod("notamethod")).toBe(null);
  });

  it("allows public and post; fails closed on private without creds", () => {
    expect(isRpcAllowed("getnodeinfo")).toBe(true);
    expect(isRpcAllowed("sendrawtransaction")).toBe(true);
    expect(isRpcAllowed("getbalance")).toBe(false);
    expect(isRpcAllowed("getbalance", { rpcuser: "u", rpcpass: "p" })).toBe(true);
  });

  it("returns /public/ or /post/ paths", () => {
    expect(pathForRpcMethod("getnodeinfo")).toBe("/public/");
    expect(pathForRpcMethod("sendrawtransaction")).toBe("/post/");
    expect(pathForRpcMethod("getbalance")).toBe(null);
  });
});
