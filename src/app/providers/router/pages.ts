import { routeName as chat } from "./routes/chat";
import { routeName as invite } from "./routes/invite";
import { routeName as joinRoom } from "./routes/join";
import { routeName as login } from "./routes/login";
import { routeName as profile } from "./routes/profile";
import { routeName as profileEdit } from "./routes/profile-edit";
import { routeName as settings } from "./routes/settings";
import { routeName as appearance } from "./routes/appearance";
import { routeName as welcome } from "./routes/welcome";

export const pages = {
  appearance,
  chat,
  invite,
  joinRoom,
  login,
  profile,
  profileEdit,
  settings,
  welcome
} as const;
