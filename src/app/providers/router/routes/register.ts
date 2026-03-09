export const routeName = "RegisterPage";

export const route = {
  component: () => import("@/pages/register"),
  meta: { requiresGuest: true },
  name: routeName,
  path: "/register"
};
