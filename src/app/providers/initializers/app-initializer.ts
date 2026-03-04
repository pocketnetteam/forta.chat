import type { UserData } from "./types";

import { PocketnetInstanceConfigurator } from "../chat-scripts";
import { PocketnetInstance } from "../chat-scripts/config/pocketnetinstance";

export interface BastyonPostData {
  txid: string;
  address: string;
  caption: string;
  message: string;
  images: string[];
  url: string;
  tags: string[];
  settings: { v?: string };
  time: number;
}

type OnLoadUserData = (userData: UserData) => void;

export class AppInitializer {
  private actions: InstanceType<typeof Actions> | null = null;
  private api: InstanceType<typeof Api> | null = null;
  private psdk: InstanceType<typeof pSDK> | null = null;
  private _available = false;
  private postCache = new Map<string, BastyonPostData>();

  constructor(pocketnetInstance: PocketnetInstanceType) {
    // Api / Actions / pSDK are globals injected by Bastyon platform scripts.
    // In standalone (Electron) mode they don't exist — run in degraded mode.
    if (typeof Api === "undefined" || typeof Actions === "undefined" || typeof pSDK === "undefined") {
      console.warn("[AppInitializer] Platform globals not available — running in standalone mode");
      return;
    }
    this.api = new Api(pocketnetInstance);
    this.actions = new Actions(pocketnetInstance, this.api);
    this.actions.init();
    this.psdk = new pSDK({
      actions: this.actions,
      api: this.api,
      app: pocketnetInstance
    });
    this._available = true;
  }

  private syncNodeTime() {
    if (!this.api || !this.actions) return Promise.resolve();
    return this.api.rpc("getnodeinfo").then(getnodeinfoResult => {
      const timeDifference =
        getnodeinfoResult.time - Math.floor(new Date().getTime() / 1000);
      PocketnetInstanceConfigurator.setTimeDifference(timeDifference);
      this.actions!.prepare();
    });
  }

  async editUserData({
    address,
    userData
  }: {
    address: string;
    userData: UserData;
  }) {
    if (!this.actions) return null;
    const userInfo = new UserInfo();
    userInfo.name.set(superXSS(userData.name));
    userInfo.language.set(superXSS(userData.language));
    userInfo.about.set(superXSS(userData.about));
    userInfo.site.set(superXSS(userData.site));
    userInfo.image.set(superXSS(userData.image));
    userInfo.addresses.set(userData.addresses);
    userInfo.ref.set(userData.ref);
    userInfo.keys.set(userData.keys);

    return this.actions.addActionAndSendIfCan(userInfo, null, address);
  }

  initApi() {
    if (!this.api) return Promise.resolve();
    return this.api.initIf();
  }

  initializeAndFetchUserData(address: string, onLoad?: OnLoadUserData) {
    if (!this._available) return Promise.resolve(null);
    return this.initApi().then(() => {
      return this.waitForApiReady().then(canUse => {
        if (canUse) {
          this.syncNodeTime();
          this.actions!.addAccount(address);
          return this.loadUserData([address], onLoad);
        }
        return null;
      });
    });
  }

  loadUserData(
    stateAddresses: string[],
    onLoad?: OnLoadUserData
  ): Promise<UserData | null> {
    if (!this.psdk || !stateAddresses.length) return Promise.resolve(null);
    return this.psdk.userInfo.load(stateAddresses).then(() => {
      const userData = this.psdk!.userInfo.get(stateAddresses[0]) as UserData;
      if (onLoad) {
        onLoad(userData);
      }
      return userData;
    });
  }

  /** Load user info for multiple addresses (for encryption key resolution).
   *  Original bastyon-chat uses light=true: psdk.userInfo.load(addresses, true, reload)
   *  This uses userInfoLight storage, queue-based processing, and maxcount=70. */
  async loadUsersInfo(addresses: string[]): Promise<void> {
    if (!this.psdk || !addresses.length) return;
    // Must pass light=true to match original bastyon-chat behavior
    await this.psdk.userInfo.load(addresses, true);
  }

  /** Get cached user data by raw address */
  getUserData(address: string): UserData | null {
    if (!this.psdk) return null;
    try {
      return this.psdk.userInfo.get(address) as UserData | null;
    } catch {
      return null;
    }
  }

  /** Get RAW user profiles via RPC — preserves all fields including numeric `id`.
   *  Must pass '1' as second param (light mode) to match SDK behavior. */
  async loadUsersInfoRaw(addresses: string[]): Promise<Record<string, unknown>[]> {
    if (!this.api || !addresses.length) return [];
    try {
      // Match SDK: api.rpc('getuserprofile', [addresses, '1'])
      const data = await this.api.rpc("getuserprofile", [addresses, "1"]);
      return (data as Record<string, unknown>[]) || [];
    } catch (e) {
      console.error("[appInit] loadUsersInfoRaw error:", e);
      return [];
    }
  }

  /** Search Pocketnet users by text query — calls "searchusers" RPC */
  async searchUsers(query: string): Promise<Array<{ address: string; name: string; image: string }>> {
    if (!this.api) return [];
    try {
      await this.initApi();
      const data = await this.api.rpc("searchusers", [query, "users"]);
      const results = (data as Array<Record<string, unknown>>) || [];
      return results.map((info) => ({
        address: (info.address as string) ?? "",
        name: info.name ? decodeURI(info.name as string) : "",
        image: (info.i as string) ?? (info.image as string) ?? "",
      })).filter(u => u.address);
    } catch (e) {
      console.error("[appInit] searchUsers error:", e);
      return [];
    }
  }

  async loadPost(txid: string): Promise<BastyonPostData | null> {
    const cached = this.postCache.get(txid);
    if (cached) return cached;
    if (!this.api) {
      console.warn("[appInit] loadPost: api not available");
      return null;
    }
    try {
      const data = await this.api.rpc("getrawtransactionwithmessagebyid", [[txid]]);
      console.log("[appInit] loadPost raw response:", data);

      // Response may be a single object or an array — normalize
      let raw: Record<string, unknown> | undefined;
      if (Array.isArray(data)) {
        raw = data[0] as Record<string, unknown> | undefined;
      } else if (data && typeof data === "object") {
        raw = data as Record<string, unknown>;
      }
      if (!raw) {
        console.warn("[appInit] loadPost: empty response for", txid);
        return null;
      }

      // Post content fields may be at top level or nested in 'msg'/'p'
      const content = (raw.msg ?? raw.p ?? raw) as Record<string, unknown>;

      const tryDecode = (val: unknown): string => {
        if (typeof val !== "string") return "";
        try { return decodeURIComponent(val); } catch { return val; }
      };

      const rawImages = content.i ?? content.images;
      const rawTags = content.t ?? content.tags;

      const post: BastyonPostData = {
        txid,
        address: (raw.address as string) ?? (content.address as string) ?? "",
        caption: tryDecode(content.c ?? content.caption),
        message: tryDecode(content.m ?? content.message),
        images: Array.isArray(rawImages) ? (rawImages as string[]) : [],
        url: tryDecode(content.u ?? content.url),
        tags: Array.isArray(rawTags) ? (rawTags as string[]) : [],
        settings: (content.s as { v?: string }) ?? (content.settings as { v?: string }) ?? {},
        time: (raw.time as number) ?? (content.time as number) ?? 0,
      };
      this.postCache.set(txid, post);
      return post;
    } catch (e) {
      console.error("[appInit] loadPost error:", e);
      return null;
    }
  }

  waitForApiReady() {
    if (!this.api) return Promise.resolve(false);
    return this.api.wait.ready("use", 1000).then(() => {
      return this.api!.ready.use;
    });
  }
}

export const createAppInitializer = (): AppInitializer => {
  return new AppInitializer(PocketnetInstance);
};
