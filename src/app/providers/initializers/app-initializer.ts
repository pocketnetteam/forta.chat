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
  scoreSum?: number;
  scoreCnt?: number;
  myVal?: number;
  repost?: BastyonPostData;
}

export interface PostScore {
  address: string;
  value: number;
  posttxid: string;
}

export interface PostComment {
  id: string;
  postid: string;
  parentid: string;
  answerid: string;
  address: string;
  message: string;
  time: number;
  scoreUp: number;
  scoreDown: number;
  myScore?: number;
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

  syncNodeTime() {
    if (!this.api || !this.actions) return Promise.resolve();
    return this.api.rpc("getnodeinfo").then(getnodeinfoResult => {
      const timeDifference =
        getnodeinfoResult.time - Math.floor(new Date().getTime() / 1000);
      PocketnetInstanceConfigurator.setTimeDifference(timeDifference);
      this.actions!.prepare();
    });
  }

  /** Fetch current blockchain block height via getnodeinfo RPC */
  async getBlockHeight(): Promise<number> {
    if (!this.api) return 0;
    try {
      const info = await this.api.rpc("getnodeinfo");
      return info?.height ?? 0;
    } catch (e) {
      console.error("[appInit] getBlockHeight error:", e);
      return 0;
    }
  }

  /** Find a proxy node that has a registration wallet.
   *  Ensures the API is initialized and ready before querying. */
  async getRegistrationProxy(): Promise<{ id: string } | null> {
    if (!this.api) return null;
    try {
      await this.initApi();
      await this.waitForApiReady();
      // Use proxywithwallet() instead of proxywithwalletls() to avoid
      // globalpreloader() which depends on jQuery ($) not available in chat app
      const proxy = await this.api.get.proxywithwallet();
      return proxy ? { id: proxy.id ?? proxy } : null;
    } catch (e) {
      console.error("[appInit] getRegistrationProxy error:", e);
      return null;
    }
  }

  /** Fetch a captcha image from the proxy node.
   *  Response shape: { id, img (SVG string), done } — possibly wrapped in `data`. */
  async getCaptcha(proxyId: string, currentCaptchaId?: string) {
    if (!this.api) return null;
    try {
      const payload: Record<string, unknown> = { captcha: currentCaptchaId || null };
      const raw = await this.api.fetchauth("captcha", payload, { proxy: proxyId });
      // fetchauth may return { data: { id, img, done } } or { id, img, done } directly
      const result = raw?.data ?? raw;
      return result;
    } catch (e) {
      console.error("[appInit] getCaptcha error:", e);
      return null;
    }
  }

  /** Submit captcha solution to the proxy node.
   *  Response shape: { id, done: true } on success. */
  async solveCaptcha(proxyId: string, captchaId: string, text: string) {
    if (!this.api) return null;
    try {
      const raw = await this.api.fetchauth(
        "makecaptcha",
        { captcha: captchaId, text, angles: null },
        { proxy: proxyId }
      );
      const result = raw?.data ?? raw;
      return result;
    } catch (e) {
      console.error("[appInit] solveCaptcha error:", e);
      return null;
    }
  }

  /** Request free registration PKOIN from the proxy node.
   *  Uses the same endpoint as Bastyon: free/balance with key='registration'. */
  async requestFreeRegistration(address: string, captchaId: string, proxyId: string) {
    if (!this.api) return null;
    try {
      const raw = await this.api.fetchauth(
        "free/balance",
        { address, captcha: captchaId, key: "registration" },
        { proxy: proxyId }
      );
      const result = raw?.data ?? raw;
      return result;
    } catch (e) {
      console.error("[appInit] requestFreeRegistration error:", e);
      throw e;
    }
  }

  /** Broadcast a UserInfo transaction for a newly registered account.
   *  Includes encryption public keys so other users can encrypt messages for this account.
   *  Returns { action, registrationNode } where registrationNode is the node that processed
   *  the sendrawtransaction — use it as fnode for subsequent getuserstate calls. */
  async registerUserProfile(
    address: string,
    profile: { name: string; language: string; about: string },
    encryptionPublicKeys?: string[],
    image?: string
  ): Promise<{ action: unknown; registrationNode: string | null }> {
    if (!this.actions) return { action: null, registrationNode: null };
    const userInfo = new UserInfo();
    userInfo.name.set(superXSS(profile.name));
    userInfo.language.set(superXSS(profile.language));
    userInfo.about.set(superXSS(profile.about));
    userInfo.image.set(superXSS(image || ""));
    userInfo.site.set("");
    userInfo.addresses.set([]);
    userInfo.ref.set(null);
    userInfo.keys.set(encryptionPublicKeys ?? null);
    const action = await this.actions.addActionAndSendIfCan(userInfo, null, address);

    // Extract the node that processed the transaction from the global txidnodestorage
    const registrationNode = this.extractNodeFromAction(action);
    console.log("[appInit] registerUserProfile: registrationNode =", registrationNode);
    return { action, registrationNode };
  }

  /** Extract the node address from a completed action's transaction via global txidnodestorage.
   *  txidnodestorage is populated by api.js after every sendrawtransaction. */
  private extractNodeFromAction(action: unknown): string | null {
    try {
      const txid = (action as Record<string, unknown>)?.transaction as string | undefined;
      if (!txid) return null;
      const storage = (window as unknown as Record<string, unknown>).txidnodestorage as Record<string, string> | undefined;
      return storage?.[txid] ?? null;
    } catch {
      return null;
    }
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

  /** Load user info for multiple addresses into full (non-light) cache.
   *  After this call, getUserData(address) will return the profile data. */
  async loadUsersBatch(addresses: string[]): Promise<void> {
    if (!this.psdk || !addresses.length) return;
    await this.psdk.userInfo.load(addresses);
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

      // Parse repost data
      const repostRaw = raw.repost ?? raw.relayedBy ?? raw.share ?? content.repost ?? content.relayedBy;
      if (repostRaw && typeof repostRaw === "object" && (repostRaw as any).txid) {
        const r = repostRaw as Record<string, unknown>;
        const rc = (r.msg ?? r.p ?? r) as Record<string, unknown>;
        const rImages = rc.i ?? rc.images;
        const rTags = rc.t ?? rc.tags;
        post.repost = {
          txid: (r.txid as string) ?? "",
          address: (r.address as string) ?? (rc.address as string) ?? "",
          caption: tryDecode(rc.c ?? rc.caption),
          message: tryDecode(rc.m ?? rc.message),
          images: Array.isArray(rImages) ? (rImages as string[]) : [],
          url: tryDecode(rc.u ?? rc.url),
          tags: Array.isArray(rTags) ? (rTags as string[]) : [],
          settings: (rc.s as { v?: string }) ?? (rc.settings as { v?: string }) ?? {},
          time: (r.time as number) ?? (rc.time as number) ?? 0,
        };
        // Cache repost separately so nested PostCard can find it
        if (post.repost.txid && !this.postCache.has(post.repost.txid)) {
          this.postCache.set(post.repost.txid, post.repost);
        }
      }

      this.postCache.set(txid, post);
      return post;
    } catch (e) {
      console.error("[appInit] loadPost error:", e);
      return null;
    }
  }

  /** Synchronous cache lookup — returns immediately or null */
  getCachedPost(txid: string): BastyonPostData | null {
    return this.postCache.get(txid) ?? null;
  }

  /** Cache a post from external source (e.g. channel feed) so PostCard finds it */
  cachePost(raw: Record<string, unknown>): void {
    const tryDecode = (val: unknown): string => {
      if (typeof val !== "string") return "";
      try { return decodeURIComponent(val); } catch { return val; }
    };
    const txid = (raw.txid as string) ?? "";
    if (!txid || this.postCache.has(txid)) return;

    const rawImages = raw.i ?? raw.images;
    const rawTags = raw.t ?? raw.tags;

    const post: BastyonPostData = {
      txid,
      address: (raw.address as string) ?? "",
      caption: tryDecode(raw.c ?? raw.caption),
      message: tryDecode(raw.m ?? raw.message),
      images: Array.isArray(rawImages) ? (rawImages as string[]) : [],
      url: tryDecode(raw.u ?? raw.url),
      tags: Array.isArray(rawTags) ? (rawTags as string[]) : [],
      settings: (raw.s as { v?: string }) ?? (raw.settings as { v?: string }) ?? {},
      time: Number(raw.time ?? 0),
    };

    // Parse repost (shared post) data
    const repostRaw = raw.repost ?? raw.relayedBy ?? raw.share;
    if (repostRaw && typeof repostRaw === "object" && (repostRaw as any).txid) {
      const r = repostRaw as Record<string, unknown>;
      const rImages = r.i ?? r.images;
      const rTags = r.t ?? r.tags;
      post.repost = {
        txid: (r.txid as string) ?? "",
        address: (r.address as string) ?? "",
        caption: tryDecode(r.c ?? r.caption),
        message: tryDecode(r.m ?? r.message),
        images: Array.isArray(rImages) ? (rImages as string[]) : [],
        url: tryDecode(r.u ?? r.url),
        tags: Array.isArray(rTags) ? (rTags as string[]) : [],
        settings: (r.s as { v?: string }) ?? (r.settings as { v?: string }) ?? {},
        time: Number(r.time ?? 0),
      };
      // Cache repost separately so nested PostCard can find it
      if (post.repost.txid && !this.postCache.has(post.repost.txid)) {
        this.postCache.set(post.repost.txid, post.repost);
      }
    }

    this.postCache.set(txid, post);
  }

  async loadPostScores(txid: string): Promise<PostScore[]> {
    if (!this.api) return [];
    try {
      const data = await this.api.rpc("getpostscores", [txid]);
      console.log("[appInit] loadPostScores raw response:", data);
      if (!Array.isArray(data)) return [];
      return data.map((s: any) => ({
        address: s.address ?? "",
        value: Number(s.value ?? 0),
        posttxid: s.posttxid ?? txid,
      }));
    } catch (e) {
      console.error("[appInit] loadPostScores error:", e);
      return [];
    }
  }

  async loadPostComments(txid: string, userAddress?: string): Promise<PostComment[]> {
    if (!this.api) return [];

    const extractMessage = (raw: unknown): string => {
      if (typeof raw !== "string") return "";
      // msg may be a JSON string like {"message":"text","url":"","images":[],"info":""}
      const trimmed = raw.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed.message === "string") return parsed.message;
        } catch { /* not JSON, fall through */ }
      }
      // Otherwise try URL-decoding
      try { return decodeURIComponent(raw); } catch { return raw; }
    };

    const parseComments = (data: unknown): PostComment[] => {
      if (!data) return [];
      // Response may be an object with nested data or a flat array
      const items = Array.isArray(data) ? data : (data as any)?.data ?? (data as any)?.result ?? [];
      if (!Array.isArray(items)) return [];
      return items.map((c: any) => ({
        id: c.id ?? c.txid ?? "",
        postid: c.postid ?? txid,
        parentid: c.parentid ?? "",
        answerid: c.answerid ?? "",
        address: c.address ?? "",
        message: typeof c.msg === "string" ? extractMessage(c.msg) : (c.message ?? ""),
        time: Number(c.time ?? 0),
        scoreUp: Number(c.scoreUp ?? 0),
        scoreDown: Number(c.scoreDown ?? 0),
        myScore: c.myScore != null ? Number(c.myScore) : undefined,
      }));
    };

    try {
      const addr = userAddress || "";
      console.log("[appInit] loadPostComments: txid=", txid, "addr=", addr, "api available=", !!this.api);

      // SDK bulk format: getcomments(['', '', userAddress, [txids]])
      const data = await this.api.rpc("getcomments", ["", "", addr, [txid]]);
      console.log("[appInit] loadPostComments bulk response:", JSON.stringify(data)?.slice(0, 500));
      const comments = parseComments(data);
      if (comments.length > 0) return comments;

      // Fallback: satolist single-post format: getcomments([txid, '', userAddress])
      const data2 = await this.api.rpc("getcomments", [txid, "", addr]);
      console.log("[appInit] loadPostComments fallback response:", JSON.stringify(data2)?.slice(0, 500));
      return parseComments(data2);
    } catch (e) {
      console.error("[appInit] loadPostComments error:", e);
      return [];
    }
  }

  async loadMyPostScore(txid: string, address: string): Promise<number | null> {
    if (!this.api) return null;
    try {
      const data = await this.api.rpc("getpagescores", [[txid], address, []]);
      if (Array.isArray(data) && data.length > 0) {
        return Number(data[0]?.value ?? 0);
      }
      return null;
    } catch {
      return null;
    }
  }

  async submitUpvote(txid: string, value: number, _address: string): Promise<boolean> {
    if (!this.actions || !this.psdk) return false;
    try {
      // psdk exposes node.shares / share via SDK globals — use any to bypass missing types
      const sdk = this.psdk as any;
      const shareData = await new Promise<any>((resolve) => {
        sdk.node.shares.getbyid([txid], () => {
          resolve(sdk.share.get(txid));
        });
      });
      if (!shareData) return false;
      const upvoteShare = shareData.upvote(value);
      if (!upvoteShare) return false;
      await (this.actions as any).addActionAndSendIfCan(upvoteShare);
      return true;
    } catch (e) {
      console.error("[appInit] submitUpvote error:", e);
      return false;
    }
  }

  async submitComment(txid: string, message: string, parentId?: string, userAddress?: string): Promise<boolean> {
    if (!this.actions || !this.api) {
      console.error("[appInit] submitComment: actions/api not available");
      return false;
    }
    try {
      // Ensure node time is synced and actions are prepared before sending
      await this.syncNodeTime();

      // Comment is a global Pocketnet SDK class from kit.js
      const PocketComment = (window as any).Comment;
      if (!PocketComment || typeof PocketComment !== "function") {
        console.error("[appInit] submitComment: Comment class not found on window");
        return false;
      }

      const comment = new PocketComment(txid);

      // Set message content
      if (typeof comment.message?.set === "function") {
        comment.message.set(message);
      } else {
        comment.msg = message;
      }

      // Set parent for reply threads
      if (parentId) comment.parentid = parentId;

      // Ensure account is registered in actions system
      const addr = userAddress || undefined;
      if (addr) {
        (this.actions as any).addAccount(addr);
      }

      // Submit with priority=2 (normal), matching pocketnet's comments.send()
      const result = await (this.actions as any).addActionAndSendIfCan(
        comment,
        2,        // priority — same as pocketnet
        addr,     // user address for tx signing
        { rejectIfError: ["actions_noinputs_wait"] }
      );
      console.log("[appInit] submitComment: action result:", !!result);
      return !!result;
    } catch (e) {
      console.error("[appInit] submitComment error:", e);
      return false;
    }
  }

  /** Check if a username is already taken via getuseraddress RPC.
   *  Returns the address that owns the name, or null if the name is free. */
  async checkUsernameExists(name: string): Promise<string | null> {
    if (!this.api) return null;
    try {
      await this.initApi();
      await this.waitForApiReady();
      const result = await this.api.rpc("getuseraddress", [name]);
      if (result && Array.isArray(result) && result.length > 0 && result[0]?.address) {
        return result[0].address as string;
      }
      return null;
    } catch {
      // RPC error (e.g. name not found) means the name is available
      return null;
    }
  }

  /** Check if address has unspent outputs (PKOIN balance) via txunspent RPC.
   *  Used to verify that free registration PKOIN has arrived before broadcasting UserInfo. */
  async checkUnspents(address: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.initApi();
      await this.waitForApiReady();
      const data = await this.api.rpc("txunspent", [[address], 1, 9999999]);
      return Array.isArray(data) && data.length > 0;
    } catch {
      return false;
    }
  }

  /** Check the Actions system's account registration status.
   *  Uses Account.getStatus() — same as pocketnet's user.userRegistrationStatus().
   *  Returns: 'registered', 'in_progress_transaction', 'in_progress_hasUnspents',
   *  'in_progress_wait_unspents', 'not_in_progress', 'not_in_progress_no_processing' */
  getAccountRegistrationStatus(): string {
    if (!this.actions) return 'not_available';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const account = (this.actions as any).getCurrentAccount?.();
      if (account?.getStatus) return account.getStatus();
      return 'not_available';
    } catch {
      return 'not_available';
    }
  }

  /** Check if user account exists on the blockchain via getuserstate RPC.
   *  Fallback check — works regardless of Actions system state.
   *  When fnode is provided, the request is pinned to that specific node —
   *  this avoids stale cache on a different node after registration broadcast.
   *  Returns true if the account is confirmed, false if still pending. */
  async checkUserRegistered(address: string, fnode?: string | null): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.initApi();
      const rpcOptions = fnode ? { fnode } : undefined;
      if (fnode) {
        console.log("[appInit] checkUserRegistered: pinning getuserstate to fnode =", fnode);
      }
      const result = await this.api.rpc("getuserstate", [address], rpcOptions);
      if (!result) return false;
      // getuserstate may return an object {address: ...} or an array [{address: ...}]
      if (Array.isArray(result)) {
        return result.length > 0 && !!(result[0] as Record<string, unknown>)?.address;
      }
      return !!(result as Record<string, unknown>).address;
    } catch {
      // error code -5 means user not found yet
      return false;
    }
  }

  private static readonly PROXY_URL = "https://1.pocketnet.app:8899";
  private static readonly NODE_ID = "94.156.128.149:38081";

  async getSubscribesChannels(
    address: string,
    blockNumber = 0,
    page = 0,
    pageSize = 20
  ): Promise<{ channels: any[]; height: number } | undefined> {
    try {
      const response = await fetch(
        `${AppInitializer.PROXY_URL}/rpc/getsubscribeschannels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "getsubscribeschannels",
            parameters: [address, blockNumber, page, pageSize],
            options: { node: AppInitializer.NODE_ID },
          }),
        }
      );
      if (!response.ok) {
        console.error("[appInit] getSubscribesChannels HTTP error:", response.status);
        return undefined;
      }
      const json = await response.json();
      if (json.error) {
        console.error("[appInit] getSubscribesChannels RPC error:", json.error);
        return undefined;
      }
      const result = json.data ?? json.result ?? json;
      return {
        height: result.height ?? 0,
        channels: result.channels ?? [],
      };
    } catch (e) {
      console.error("[appInit] getSubscribesChannels error:", e);
      return undefined;
    }
  }

  async getProfileFeed(
    authorAddress: string,
    options?: { height?: number; startTxid?: string; count?: number }
  ): Promise<any[]> {
    try {
      const opts = options ?? {};
      const response = await fetch(
        `${AppInitializer.PROXY_URL}/rpc/getprofilefeed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "getprofilefeed",
            parameters: [
              Number(opts.height ?? 0),
              opts.startTxid ?? "",
              opts.count ?? 10,
              "",   // lang
              [],   // tagsfilter
              [],   // type
              [],   // reserved
              [],   // reserved
              [],   // tagsexcluded
              "",   // keyword
              authorAddress,
            ],
            options: { node: AppInitializer.NODE_ID },
          }),
        }
      );
      if (!response.ok) {
        console.error("[appInit] getProfileFeed HTTP error:", response.status);
        return [];
      }
      const json = await response.json();
      if (json.error) {
        console.error("[appInit] getProfileFeed RPC error:", json.error);
        return [];
      }
      const result = json.data ?? json.result ?? json;
      return Array.isArray(result) ? result : result?.contents ?? [];
    } catch (e) {
      console.error("[appInit] getProfileFeed error:", e);
      return [];
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
