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
    chat.sortedRooms = [dm("!a", "PBobAddress222"), dm("!b", "PCarolAddress333")];
    user.users = { PBobAddress222: { name: "Bob" } };
  });

  // Regression (perf): every mounted chat-list tab resolved all room names itself.
  it("resolves each room once for any number of list instances", () => {
    const scope = effectScope();
    const lists = scope.run(() =>
      [0, 1, 2, 3].map(() => {
        const store = useRoomNamesStore();
        return computed(() => store.roomNameIndex);
      }),
    )!;
    const indexes = lists.map(l => l.value);
    expect(new Set(indexes).size).toBe(1);
    expect(indexes[0].names).toEqual({ "!a": "Bob", "!b": "!b" });
    expect([...indexes[0].unresolved]).toEqual(["!b"]);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it("re-resolves when a profile arrives", () => {
    const store = useRoomNamesStore();
    expect(store.roomNameIndex.names["!b"]).toBe("!b");
    user.users = { ...user.users, PCarolAddress333: { name: "Carol" } };
    expect(store.roomNameIndex.names["!b"]).toBe("Carol");
    expect(store.roomNameIndex.unresolved.size).toBe(0);
  });
});
