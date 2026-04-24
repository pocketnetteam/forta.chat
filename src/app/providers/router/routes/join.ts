import type { RouteRecordRaw } from "vue-router";
import { validateRoomId } from "@/entities/chat/lib/join-error";

export const routeName = "JoinRoomPage";

export const route: RouteRecordRaw = {
  path: "/join",
  name: routeName,
  component: () => import("@/pages/welcome"),
  beforeEnter: (to, _from, next) => {
    const raw = to.query.room;
    const roomId = typeof raw === "string" ? raw : undefined;
    // Only persist the pending join when the id survives our grammar check.
    // A malformed id would otherwise trip joinRoomById's invalid_id branch
    // and surface a confusing toast on entry — better to drop it here.
    if (roomId && validateRoomId(roomId)) {
      localStorage.setItem("bastyon-chat-join-room", roomId);
    }
    next({ name: "WelcomePage", replace: true });
  },
};
