import { AppPages } from "../router";

interface Route<T extends object = object> {
  name: string;
  params: T;
}

export class AppRoutes {
  private constructor() {}

  static getChat() {
    return getRoute(AppPages.chat, {});
  }

  static getLogin() {
    return getRoute(AppPages.login, {});
  }

  static getProfile() {
    return getRoute(AppPages.profile, {});
  }

  static getProfileEdit() {
    return getRoute(AppPages.profileEdit, {});
  }

  static getWelcome() {
    return getRoute(AppPages.welcome, {});
  }

}

function getRoute<T extends object = object>(name: string, params?: T): Route<T> {
  return {
    name,
    params: params ?? ({} as T)
  };
}
