import { describe, it, expect, vi } from "vitest";
import { nextTick, ref } from "vue";
import { syncMatrixTorProxy } from "./tor-matrix-proxy";

describe("syncMatrixTorProxy", () => {
  it("applies the proxy when Tor comes up after start and clears it when Tor goes off", async () => {
    const url = ref("");
    const setUrl = vi.fn();
    const stop = syncMatrixTorProxy(() => url.value, setUrl);

    expect(setUrl).toHaveBeenLastCalledWith("");

    url.value = "http://127.0.0.1:8181";
    await nextTick();
    expect(setUrl).toHaveBeenLastCalledWith("http://127.0.0.1:8181");

    url.value = "";
    await nextTick();
    expect(setUrl).toHaveBeenLastCalledWith("");
    expect(setUrl).toHaveBeenCalledTimes(3);
    stop();
  });
});
