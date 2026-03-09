import type { RouteRecordRaw } from "vue-router";

export const routeName = "JoinRoomPage";

export const route: RouteRecordRaw = {
  path: "/join",
  name: routeName,
  component: () => import("@/pages/welcome"),
  beforeEnter: (to, _from, next) => {
    const roomId = to.query.room as string | undefined;
    if (roomId) {
      localStorage.setItem("bastyon-chat-join-room", roomId);
    }
    next({ name: "WelcomePage", replace: true });
  },
};
