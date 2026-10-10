// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent, h, ref, type Ref } from "vue";
import { mount } from "@vue/test-utils";
import {
  useTransactionLoader,
  FIRST_ATTEMPT_DELAY_MS,
  POLL_INTERVAL_MS,
  POLL_WINDOW_MS,
  clearTransactionLoaderCache,
} from "./use-transaction-loader";

const MINED = { txid: "t1", height: 100, blockHash: "b100", vin: [], vout: [{ value: 1, scriptPubKey: { addresses: ["PA"] } }] };
const MEMPOOL = { ...MINED, height: undefined, blockHash: undefined };

function setup(loadRaw: (txid: string) => Promise<unknown>, txid: Ref<string> = ref("t1")) {
  let api!: ReturnType<typeof useTransactionLoader>;
  const w = mount(defineComponent({
    setup() {
      api = useTransactionLoader(txid, loadRaw);
      return () => h("div");
    },
  }));
  return { api, w, txid };
}

describe("useTransactionLoader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearTransactionLoaderCache();
  });
  afterEach(() => vi.useRealTimers());

  it("waits 3s before the first call", async () => {
    const load = vi.fn().mockResolvedValue(MINED);
    const { api } = setup(load);
    api.start();

    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_DELAY_MS - 1);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(api.summary.value?.height).toBe(100);
    expect(api.loading.value).toBe(false);
  });

  it("polls every 15s until our node knows the transaction", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("No such transaction"))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(MINED);
    const { api } = setup(load);
    api.start();

    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_DELAY_MS);
    expect(api.summary.value).toBeNull();
    expect(api.loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(load).toHaveBeenCalledTimes(3);
    expect(api.summary.value?.height).toBe(100);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("the first call may use the cache, every re-poll and a manual recheck bypass it", async () => {
    const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(MEMPOOL);
    const { api } = setup(load);
    api.start();
    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_DELAY_MS + POLL_INTERVAL_MS);
    expect(load.mock.calls.map((c) => c[1])).toEqual([false, true]);

    api.start(0, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenLastCalledWith("t1", true);
  });

  it("gives up after 5 minutes", async () => {
    const load = vi.fn().mockResolvedValue(null);
    const { api } = setup(load);
    api.start();

    await vi.advanceTimersByTimeAsync(POLL_WINDOW_MS + POLL_INTERVAL_MS * 2);
    const calls = load.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(1 + Math.floor(POLL_WINDOW_MS / POLL_INTERVAL_MS));
    expect(calls).toBeGreaterThan(15);
    expect(api.loading.value).toBe(false);
    expect(api.summary.value).toBeNull();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
    expect(load.mock.calls.length).toBe(calls);
  });

  it("a mempool hit is shown at once and keeps polling until it is mined", async () => {
    const load = vi.fn().mockResolvedValueOnce(MEMPOOL).mockResolvedValue(MINED);
    const { api } = setup(load);
    api.start();

    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_DELAY_MS);
    expect(api.summary.value?.txid).toBe("t1");
    expect(api.summary.value?.height).toBeUndefined();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(api.summary.value?.height).toBe(100);
    expect(api.loading.value).toBe(false);
  });

  it("a re-mounted card shows an already mined transaction at once, without asking the node", async () => {
    const load = vi.fn().mockResolvedValue(MINED);
    const first = setup(load);
    first.api.start();
    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_DELAY_MS);
    first.w.unmount();

    const again = setup(load);
    again.api.start();
    expect(again.api.summary.value?.height).toBe(100);
    expect(again.api.loading.value).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("rechecking keeps a shown mempool transaction even if the node now fails", async () => {
    const load = vi.fn().mockResolvedValueOnce(MEMPOOL).mockRejectedValue(new Error("timeout"));
    const { api } = setup(load);
    api.start();
    await vi.advanceTimersByTimeAsync(POLL_WINDOW_MS + POLL_INTERVAL_MS);
    expect(api.loading.value).toBe(false);

    api.start(0);
    expect(api.summary.value?.txid).toBe("t1");
    await vi.advanceTimersByTimeAsync(POLL_WINDOW_MS + POLL_INTERVAL_MS);
    expect(api.summary.value?.txid).toBe("t1");
  });

  it("stops polling on unmount and restarts for a new txid", async () => {
    const load = vi.fn().mockResolvedValue(null);
    const { api, w, txid } = setup(load);
    api.start();
    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_DELAY_MS);
    expect(load).toHaveBeenLastCalledWith("t1", false);

    txid.value = "t2";
    await vi.advanceTimersByTimeAsync(FIRST_ATTEMPT_DELAY_MS);
    expect(load).toHaveBeenLastCalledWith("t2", false);

    w.unmount();
    const calls = load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(load.mock.calls.length).toBe(calls);
  });
});
