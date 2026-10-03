import { describe, it, expect, vi, beforeEach } from "vitest";
import { reactive, effectScope, computed } from "vue";
import { createPinia, setActivePinia } from "pinia";
import type { ChatRoom } from "@/entities/chat";
import { hexEncode } from "@/shared/lib/matrix/functions";

const resolveSpy = vi.hoisted(() => vi.fn());

const chat = reactive({
  sortedRooms: [] as ChatRoom[],
  userDisplayNames: {} as Record<string, string>,
  localAliases: {} as Record<string, string>,
  getDisplayName: (a: string) => a,
});
const user = reactive({ users: {} as Record<string, { name: string }> });

vi.mock("@/entities/chat", () => ({ useChatStore: () => chat }));
vi.mock("@/entities/auth", () => ({ useAuthStore: () => ({ address: "PMeAddress111" }) }));
vi.mock("@/entities/user/model", () => ({ useUserStore: () => user }));
vi.mock("../lib/resolve-room-name", async (orig) => {
  const mod = await orig<typeof import("../lib/resolve-room-name")>();
  return {
    ...mod,
    resolveRoomNameInfo: (...args: Parameters<typeof mod.resolveRoomNameInfo>) => {
      resolveSpy(args[0].id);
      return mod.resolveRoomNameInfo(...args);
    },
  };
});

import { useRoomNamesStore } from "./room-names-store";

const dm = (id: string, peer: string): ChatRoom =>
  ({ id, name: id, isGroup: false, members: [hexEncode("PMeAddress111"), hexEncode(peer)] }) as ChatRoom;

describe("useRoomNamesStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resolveSpy.mockClear();
    user.users = { PBobAddress222: { name: "Bob" } };
  });

  // Regression (perf): every mounted chat-list tab resolved all room names itself.
  it("resolves a room once for any number of list instances", () => {
    const a = dm("!a", "PBobAddress222");
    const b = dm("!b", "PCarolAddress333");
    const scope = effectScope();
    const lists = scope.run(() =>
      [0, 1, 2, 3].map(() => {
        const store = useRoomNamesStore();
        return computed(() => [a, b].map(r => store.resolveInfo(r)));
      }),
    )!;
    const results = lists.map(l => l.value);
    expect(results[0]).toEqual([
      { name: "Bob", hasMemberNames: true },
      { name: "!b", hasMemberNames: false },
    ]);
    for (const r of results) expect(r[0]).toBe(results[0][0]);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it("re-runs the caller and re-resolves its room when a profile arrives", () => {
    const store = useRoomNamesStore();
    const b = dm("!b", "PCarolAddress333");
    const name = computed(() => store.resolveInfo(b).name);
    expect(name.value).toBe("!b");
    user.users = { ...user.users, PCarolAddress333: { name: "Carol" } };
    expect(name.value).toBe("Carol");
  });

  it("does not resolve rooms nobody asked for", () => {
    const store = useRoomNamesStore();
    chat.sortedRooms = Array.from({ length: 500 }, (_, i) => dm(`!r${i}`, "PBobAddress222"));
    store.resolveInfo(chat.sortedRooms[0]);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });
});
