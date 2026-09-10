import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "../chat-store";
import { makeMsg } from "@/test-utils";

describe("chat-store: addMessage batches the messages/rooms reactivity trigger", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("writes message data synchronously even though the reactive trigger is deferred to a frame", () => {
    const raf: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      raf.push(cb);
      return raf.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const msg = makeMsg({ roomId: "!a:s", id: "$1", senderId: "@peer:s" });
      store.addMessage("!a:s", msg);

      // Imperative reads of store.messages must see the new message right away —
      // only the Vue reactivity *notification* is deferred, not the data write.
      expect(store.messages["!a:s"]?.some((m) => m.id === "$1")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("coalesces addMessage calls across many rooms (a reconnect catch-up burst) into a single scheduled trigger", () => {
    const raf: FrameRequestCallback[] = [];
    const rafSpy = vi.fn((cb: FrameRequestCallback) => {
      raf.push(cb);
      return raf.length;
    });
    vi.stubGlobal("requestAnimationFrame", rafSpy);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const roomIds = Array.from({ length: 20 }, (_, i) => `!room${i}:s`);
      for (const roomId of roomIds) {
        store.addMessage(roomId, makeMsg({ roomId, id: `$${roomId}`, senderId: "@peer:s" }));
      }

      // One rAF for the whole burst — not one per background-room event.
      expect(rafSpy).toHaveBeenCalledTimes(1);

      // Flushing the single scheduled frame applies the trigger; all rooms'
      // data was already written synchronously above, so nothing is lost.
      expect(() => raf[0](0)).not.toThrow();
      for (const roomId of roomIds) {
        expect(store.messages[roomId]?.some((m) => m.id === `$${roomId}`)).toBe(true);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a later burst after cleanup() schedules a fresh trigger (scheduler was reset, not left stuck)", () => {
    const raf: FrameRequestCallback[] = [];
    const rafSpy = vi.fn((cb: FrameRequestCallback) => {
      raf.push(cb);
      return raf.length;
    });
    vi.stubGlobal("requestAnimationFrame", rafSpy);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      store.addMessage("!a:s", makeMsg({ roomId: "!a:s", id: "$1", senderId: "@peer:s" }));
      expect(rafSpy).toHaveBeenCalledTimes(1);

      store.cleanup();
      store.addMessage("!b:s", makeMsg({ roomId: "!b:s", id: "$2", senderId: "@peer:s" }));

      // cleanup() cancels the pending scheduler; the post-cleanup addMessage
      // schedules its own fresh frame instead of silently reusing a cancelled one.
      expect(rafSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
