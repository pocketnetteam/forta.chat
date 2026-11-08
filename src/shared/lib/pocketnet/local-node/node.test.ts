import { describe, it, expect } from "vitest";
import { LocalNode } from "./node";

describe("LocalNode", () => {
  it("rates zero until inited with height", () => {
    const node = new LocalNode({
      host: "1.2.3.4",
      port: 38081,
      sport: 38881,
      ws: 8087,
      sws: 8887,
      name: "n",
    });
    expect(node.rating()).toBe(0);
    node.markFromNodeInfo({ height: 100, version: "0.23.0", chain: "main" });
    expect(node.canuse).toBe(true);
    expect(node.rating()).toBeGreaterThan(0);
  });

  it("applies penalty on 408", () => {
    let now = 1000;
    const node = new LocalNode(
      {
        host: "1.2.3.4",
        port: 38081,
        sport: 38881,
        ws: 8087,
        sws: 8887,
        name: "n",
      },
      { now: () => now },
    );
    node.markFromNodeInfo({ height: 1000 });
    node.recordRpcResult({ success: true, code: 200, time: 10, method: "getnodeinfo" });
    const before = node.rating();
    expect(before).toBeGreaterThan(0);
    node.recordRpcResult({ success: false, code: 408, time: 10, method: "getnodeinfo" });
    expect(node.rating()).toBeLessThan(before);
    now += 70_000;
    // Penalty cleared; availability still < 1 because of the failed sample.
    expect(node.rating()).toBeGreaterThan(0);
    expect(node.rating()).toBeLessThanOrEqual(before);
  });
});
