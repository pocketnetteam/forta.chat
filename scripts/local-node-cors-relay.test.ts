import { describe, it, expect } from "vitest";
import {
  canonicalizeRpcPath,
  resolveTarget,
} from "./local-node-cors-relay.mjs";

describe("local-node-cors-relay resolveTarget", () => {
  it("canonicalizes /public/<method>", () => {
    expect(canonicalizeRpcPath("/public/getnodeinfo")).toBe("/public/");
    expect(canonicalizeRpcPath("/post/foo")).toBe("/post/");
  });

  it("builds upstream URL from headers", () => {
    const t = resolveTarget(
      {
        "x-node-host": "5.189.141.204",
        "x-node-port": "38081",
        "x-node-tls": "0",
      },
      "/public/getnodeinfo",
    );
    expect(t).toEqual({
      ok: true,
      scheme: "http",
      host: "5.189.141.204",
      port: 38081,
      path: "/public/",
      url: "http://5.189.141.204:38081/public/",
    });
  });

  it("rejects missing host and open-proxy paths", () => {
    expect(resolveTarget({}, "/public/")).toMatchObject({
      ok: false,
      status: 400,
      message: "missing X-Node-Host",
    });
    expect(
      resolveTarget({ "x-node-host": "http://evil" }, "/public/"),
    ).toMatchObject({ ok: false, message: "invalid X-Node-Host" });
  });
});
