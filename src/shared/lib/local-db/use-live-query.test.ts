/**
 * Tests for useLiveQuery composable.
 *
 * We mock Dexie's liveQuery to control the Observable behavior,
 * and use Vue's effectScope to provide onScopeDispose context.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { useLiveQuery } from "./use-live-query";

// ─── Mock Dexie's liveQuery ──────────────────────────────────────────

type Subscriber = {
  next: (value: unknown) => void;
  error: (err: unknown) => void;
};

let lastSubscriber: Subscriber | null = null;
const mockUnsubscribe = vi.fn();

vi.mock("dexie", () => ({
  liveQuery: (_querier: () => unknown) => ({
    subscribe: (subscriber: Subscriber) => {
      lastSubscriber = subscriber;
      return { unsubscribe: mockUnsubscribe };
    },
  }),
}));

// ─── Tests ───────────────────────────────────────────────────────────

describe("useLiveQuery", () => {
  beforeEach(() => {
    lastSubscriber = null;
    mockUnsubscribe.mockClear();
  });

  it("data starts with initial value and isReady is false", () => {
    const scope = effectScope();
    scope.run(() => {
      const { data, isReady } = useLiveQuery(() => [], undefined, []);
      expect(data.value).toEqual([]);
      expect(isReady.value).toBe(false);
    });
    scope.stop();
  });

  it("data updates and isReady becomes true after emission", async () => {
    const scope = effectScope();
    scope.run(() => {
      const { data, isReady } = useLiveQuery(() => "initial", undefined, "initial");

      // Simulate Dexie emitting a value
      lastSubscriber?.next("updated");
      expect(data.value).toBe("updated");
      expect(isReady.value).toBe(true);
    });
    scope.stop();
  });

  it("error does not crash and data retains last good value", () => {
    const scope = effectScope();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    scope.run(() => {
      const { data, isReady } = useLiveQuery(() => "val", undefined, "default");

      // Emit a good value first
      lastSubscriber?.next("good");
      expect(data.value).toBe("good");
      expect(isReady.value).toBe(true);

      // Emit an error — data should retain previous value
      lastSubscriber?.error(new Error("DB failure"));
      expect(data.value).toBe("good");
      expect(isReady.value).toBe(true);
    });

    consoleSpy.mockRestore();
    scope.stop();
  });

  it("unsubscribes on scope dispose", () => {
    const scope = effectScope();
    scope.run(() => {
      useLiveQuery(() => null, undefined, null);
    });

    expect(mockUnsubscribe).not.toHaveBeenCalled();
    scope.stop();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it("re-subscribes when deps change", async () => {
    const scope = effectScope();

    scope.run(() => {
      const dep = ref("room-1");
      useLiveQuery(() => dep.value, () => dep.value, "init");

      // First subscription happened via immediate: true
      const firstSubscriber = lastSubscriber;
      expect(firstSubscriber).not.toBeNull();

      // Change dep — should trigger re-subscription
      dep.value = "room-2";
    });

    // Allow watcher to fire
    await nextTick();

    // After dep change: old subscription unsubscribed, new one created
    expect(mockUnsubscribe).toHaveBeenCalled();

    scope.stop();
  });

  it("isReady stays true across re-subscriptions (no skeleton flash)", async () => {
    const scope = effectScope();

    scope.run(async () => {
      const dep = ref("a");
      const { isReady } = useLiveQuery(() => dep.value, () => dep.value, "init");

      // First emission makes isReady true
      lastSubscriber?.next("data-a");
      expect(isReady.value).toBe(true);

      // Switch deps
      dep.value = "b";
      await nextTick();

      // isReady should still be true (not reset)
      expect(isReady.value).toBe(true);
    });

    scope.stop();
  });
});
