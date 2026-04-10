import type { RouteRecordRaw } from "vue-router";

import { route as chatRoute } from "./chat";
import { route as inviteRoute } from "./invite";
import { route as joinRoute } from "./join";
import { route as loginRoute } from "./login";
import { route as profileRoute } from "./profile";
import { route as profileEditRoute } from "./profile-edit";
import { route as appearanceRoute } from "./appearance";
import { route as registerRoute } from "./register";
import { route as welcomeRoute } from "./welcome";

export const routes: RouteRecordRaw[] = [
  inviteRoute,
  joinRoute,
  loginRoute,
  chatRoute,
  registerRoute,
  welcomeRoute,
  profileRoute,
  profileEditRoute,
  appearanceRoute,
  {
    path: "/:pathMatch(.*)*",
    redirect: "/welcome"
  }
];
