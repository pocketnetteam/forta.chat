import type { RouteRecordRaw } from "vue-router";

export const routeName = "InvitePage";

export const route: RouteRecordRaw = {
  path: "/invite",
  name: routeName,
  component: () => import("@/pages/welcome"),
  beforeEnter: (to, _from, next) => {
    const ref = to.query.ref as string | undefined;
    if (ref) {
      localStorage.setItem("bastyon-chat-referral", ref);
    }
    next({ name: "WelcomePage", replace: true });
  },
};
