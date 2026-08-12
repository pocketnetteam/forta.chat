/**
 * Matrix client service — adapted from bastyon-chat/src/application/mtrx.js
 *
 * Wraps matrix-js-sdk-bastyon and handles:
 * - Login / registration
 * - IndexedDB store
 * - Sync events (Room.timeline, RoomMember.membership, etc.)
 * - Send/receive messages
 */
import axios, { type AxiosRequestConfig } from "axios";
// @ts-expect-error — no types for qs
import qs from "qs";
import * as sdk from "matrix-js-sdk-bastyon/lib/browser-index.js";

import { MATRIX_SERVER } from "@/shared/config";
import { createChatStorage, type ChatStorageInstance } from "@/shared/lib/matrix/chat-storage";
import { getmatrixid } from "@/shared/lib/matrix/functions";
import { withTimeout } from "@/shared/lib/with-timeout";

import { getStoredDeviceId, storeDeviceId } from "./device-id-storage";
import {
  pickLiveMatrixHost,
  nextMatrixHost,
  hostFromBaseUrl,
  findLiveMatrixHost,
  failoverProbeOrder,
  SyncWatchdog,
  PING_TIMEOUT_MS,
  ERROR_RETRY_BASE_MS,
  ERROR_RETRY_MAX_MS,
  CLIENT_RECOVERY_BASE_MS,
  CLIENT_RECOVERY_MAX_MS,
  MATRIX_SYNC_HOSTS,
} from "./sync-failover";
import type { MatrixCredentials, MatrixClient, MatrixSDK } from "./types";

export type SyncCallback = (state: "PREPARED" | "SYNCING" | "ERROR" | "STOPPED" | "RECONNECTING") => void;
export type TimelineCallback = (event: unknown, room: unknown) => void;
export type MembershipCallback = (event: unknown, member: unknown) => void;
export type TypingCallback = (event: unknown, member: unknown) => void;
export type ReceiptCallback = (event: unknown, room: unknown) => void;
export type RedactionCallback = (event: unknown, room: unknown) => void;
export type MyMembershipCallback = (room: unknown, membership: string, prevMembership: string | undefined) => void;
export type IncomingCallCallback = (call: unknown) => void;
export type RoomAccountDataCallback = (event: unknown, room: unknown) => void;

export class MatrixClientService {
  private baseUrl: string;
  client: MatrixClient | null = null;
  ready = false;
  error: string | false = false;
  private credentials: MatrixCredentials | null = null;
  private chatsReady = false;
  private db: ChatStorageInstance | null = null;
  private sdk = sdk;
  store: Record<string, unknown> | null = null;
  private torProxyUrl: string = '';

  // Runtime sync watchdog + mirror failover (WEE-105). Created lazily on first
  // init, persists across mirror recreates, stopped on destroy/logout.
  private watchdog: SyncWatchdog | null = null;
  // True while a watchdog-driven mirror recreate is in flight, so init() does
  // not ping-and-pick the baseUrl back to the primary mid-failover.
  private failoverActive = false;
  // True while any client (re)creation is in flight (boot init OR mirror
  // recreate). Serializes the two writers of `this.client` so a watchdog
  // failover can't race a concurrent boot-retry init() for ownership.
  private building = false;
  // Exponential backoff state for retrying the SAME host on a sync ERROR,
  // replacing the old tight retryImmediately() loop (WEE-105 H2).
  private errorRetryAttempt = 0;
  private errorRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // Persistent rebuild after client was destroyed and every host was unreachable
  // (full DNS/outage). Without this the tab stays dead until a manual reload.
  private clientRecoveryAttempt = 0;
  private clientRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private clientRecoveryListenersAttached = false;
  private onOnlineRecovery: (() => void) | null = null;
  private onVisibilityRecovery: (() => void) | null = null;

  setTorProxyUrl(url: string) {
    this.torProxyUrl = url;
  }

  // Event callbacks
  private onSync: SyncCallback | null = null;
  private onTimeline: TimelineCallback | null = null;
  private onMembership: MembershipCallback | null = null;
  private onTyping: TypingCallback | null = null;
  private onReceipt: ReceiptCallback | null = null;
  private onRedaction: RedactionCallback | null = null;
  private onMyMembership: MyMembershipCallback | null = null;
  private onIncomingCall: IncomingCallCallback | null = null;
  private onRoom: ((room: unknown) => void) | null = null;
  private onRoomAccountData: RoomAccountDataCallback | null = null;
  private onAccountData: ((event: unknown) => void) | null = null;
  private onEncryptionKeyArrived: ((roomId: string) => void) | null = null;

  constructor(domain?: string) {
    this.baseUrl = `https://${domain ?? MATRIX_SERVER}`;
  }

  setCredentials(credentials: MatrixCredentials) {
    this.credentials = credentials;
  }

  /** Set event handlers before init */
  setHandlers(handlers: {
    onSync?: SyncCallback;
    onTimeline?: TimelineCallback;
    onMembership?: MembershipCallback;
    onTyping?: TypingCallback;
    onReceipt?: ReceiptCallback;
    onRedaction?: RedactionCallback;
    onMyMembership?: MyMembershipCallback;
    onIncomingCall?: IncomingCallCallback;
    onRoom?: (room: unknown) => void;
    onRoomAccountData?: RoomAccountDataCallback;
    onAccountData?: (event: unknown) => void;
    onEncryptionKeyArrived?: (roomId: string) => void;
  }) {
    if (handlers.onSync) this.onSync = handlers.onSync;
    if (handlers.onTimeline) this.onTimeline = handlers.onTimeline;
    if (handlers.onMembership) this.onMembership = handlers.onMembership;
    if (handlers.onTyping) this.onTyping = handlers.onTyping;
    if (handlers.onReceipt) this.onReceipt = handlers.onReceipt;
    if (handlers.onRedaction) this.onRedaction = handlers.onRedaction;
    if (handlers.onMyMembership) this.onMyMembership = handlers.onMyMembership;
    if (handlers.onIncomingCall) this.onIncomingCall = handlers.onIncomingCall;
    if (handlers.onRoom) this.onRoom = handlers.onRoom;
    if (handlers.onRoomAccountData) this.onRoomAccountData = handlers.onRoomAccountData;
    if (handlers.onAccountData) this.onAccountData = handlers.onAccountData;
    if (handlers.onEncryptionKeyArrived) this.onEncryptionKeyArrived = handlers.onEncryptionKeyArrived;
  }

  /** Custom request function using axios (matching bastyon-chat pattern) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private request(opts: any, clbk: (err: any, response: any, body: string) => void) {
    const cancelTokenSource = axios.CancelToken.source();

    const axiosOpts: AxiosRequestConfig = {
      url: opts.uri,
      params: opts.qs,
      data: JSON.parse(opts.body || "{}"),
      timeout: opts.timeout ?? 30000,
      headers: opts.headers,
      method: opts.method,
      withCredentials: opts.withCredentials,
      cancelToken: cancelTokenSource.token,
      paramsSerializer: (params: unknown) => qs.stringify(params as Record<string, unknown>, opts.qsStringifyOptions)
    };

    // When Tor proxy is active, route through local reverse proxy
    if (this.torProxyUrl) {
      axiosOpts.proxy = {
        host: '127.0.0.1',
        port: 8181,
        protocol: 'http'
      };
    }

    const req = axios(axiosOpts)
      .then((response) => response)
      .catch((e) => {
        const response = e.response;
        let error = e;
        try {
          const parsed = JSON.parse(response?.request?.responseText ?? "");
          error = new sdk.MatrixError(parsed);
        } catch { /* ignore */ }
        return { __error: error, ...response };
      })
      .then((response: Record<string, unknown>) => {
        const error = response?.__error as Error | undefined;
        const body = (response?.request as Record<string, unknown>)?.responseText ?? "";
        clbk(error ?? null, response, body as string);
      }) as unknown as { abort: () => void };

    (req as unknown as Record<string, unknown>).abort = () => cancelTokenSource.cancel();
    return req;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createMtrxClient(opts: any): MatrixClient {
    const client = sdk.createClient(opts);
    // Override getProfileInfo to avoid unnecessary calls
    client.getProfileInfo = () => Promise.resolve({ avatar_url: "", displayname: "" });
    return client;
  }

  /** Main login/register + start client flow */
  async getClient(): Promise<MatrixClient | null> {
    if (!this.credentials) throw new Error("No credentials set");

    const opts: Record<string, unknown> = {
      baseUrl: this.baseUrl,
      request: this.request.bind(this)
    };

    const client = this.createMtrxClient(opts);

    // Reuse the persisted device_id if we already have one for this account.
    // This stops Synapse from spawning a fresh device on every login, which
    // otherwise causes device_inbox to grow without bound because undelivered
    // messages pile up for each abandoned device.
    const storedDeviceId = getStoredDeviceId(this.credentials.address);

    let userData;
    try {
      const loginParams: Record<string, unknown> = {
        user: this.credentials.username,
        password: this.credentials.password,
        initial_device_display_name: "Forta Chat",
      };
      if (storedDeviceId) {
        loginParams.device_id = storedDeviceId;
      }
      userData = await client.login("m.login.password", loginParams);
    } catch (e: unknown) {
      const errStr = typeof e === "string" ? e : (e as Error)?.message ?? "";
      if (errStr.indexOf("M_USER_DEACTIVATED") > -1) {
        this.error = "M_USER_DEACTIVATED";
        return null;
      }
      // Try to register
      try {
        if (await client.isUsernameAvailable(this.credentials.username)) {
          userData = await client.register(
            this.credentials.username,
            this.credentials.password,
            null,
            { type: "m.login.dummy" }
          );
        } else {
          throw new Error("Signup error, username is not available: " + errStr);
        }
      } catch (regErr) {
        throw regErr;
      }
    }

    // Persist the device_id so the next login reuses the same device.
    if (userData?.device_id) {
      storeDeviceId(this.credentials.address, userData.device_id);
    }

    localStorage.accessToken = userData.access_token;

    // v6 → v7: bump forces every client to rebuild its local Matrix sync
    // store from scratch instead of reconciling incrementally on top of
    // state cached while member lazy-loading was still on. Without this, an
    // existing install could keep its old partial member state around
    // indefinitely — canBeEncrypt() would still see it as incomplete — since
    // disabling lazy loading only changes what *future* /sync responses
    // contain, it doesn't retroactively backfill an already-populated store.
    const indexedDBStore = new sdk.IndexedDBStore({
      indexedDB: window.indexedDB,
      dbName: "matrix-js-sdk-v7:" + this.credentials.username,
      localStorage: window.localStorage
    });

    const userClientData: Record<string, unknown> = {
      baseUrl: this.baseUrl,
      userId: userData.user_id,
      accessToken: userData.access_token,
      unstableClientRelationAggregation: true,
      timelineSupport: true,
      store: indexedDBStore,
      deviceId: userData.device_id,
      request: this.request.bind(this),
      /*iceCandidatePoolSize: 20,
      // Session 02 — explicit public STUN fallback.
      //
      // The Matrix homeserver's /turnServer endpoint is unreliable in
      // restricted regions (rate-limited, sometimes blocked). Without at
      // least one reachable STUN, ICE gathering produces only host
      // candidates and any NAT-ed peer can't connect, so the call drops
      // within 1-2 seconds. We keep fallbackICEServerAllowed so the SDK
      // still tries turn.matrix.org when the homeserver refuses, but
      // adding these defaults makes ICE robust even when it doesn't.
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
      fallbackICEServerAllowed: true,*/
      disableVoip: false, // ensure WebRTC call handler and Call.incoming are enabled
    };

    const userClient = this.createMtrxClient(userClientData);

    try {
      await withTimeout(indexedDBStore.startup(), 10_000, "Matrix IndexedDB startup");
    } catch (e) {
      console.error("Matrix IndexedDB startup error:", e);
    }

    this.client = userClient;
    this.initEvents();

    // Create a server-side sync filter to reduce /sync payload for large accounts.
    // This dramatically cuts response size (5-10x) by limiting state events,
    // excluding ephemeral data, and restricting account_data to essentials.
    let syncFilter: InstanceType<typeof sdk.Filter> | undefined;
    try {
      const filterDefinition = {
        room: {
          timeline: {
            // Was 1, which was way too aggressive: if multiple events
            // arrived in a room since our last sync token, the server
            // would return only the most recent — so an m.call.invite
            // followed by any other event (typing, read receipt promoted
            // to timeline on some servers, or a retry hangup) would
            // disappear from our /sync, and the Matrix SDK would never
            // fire Call.incoming. #37 raised this to 20 to be safe, but
            // that made every /sync 20x heavier per room across ALL
            // rooms (not just call rooms), which is the dominant cost of
            // initial sync payload size. 4 is a middle ground: still
            // covers a realistic burst (invite + a couple of retries/
            // candidates) without the full 20x cost. If call invites
            // start getting dropped again in bursty rooms, that's the
            // tradeoff to revisit — not a regression to silently "fix"
            // back to 20.
            limit: 4,
            lazy_load_members: false,
          },
          state: {
            // Lazy loading left member state (m.room.member) unresolved for
            // freshly-created 1:1 chats until the peer sent a first message —
            // getusershistory() in matrix-crypto.ts only sees locally-synced
            // member events, so canBeEncrypt() read an incomplete `usersinfo`
            // (just the local user) and reported the peer as missing
            // encryption keys even though they were published. Full member
            // state removes that race at the cost of a heavier initial /sync.
            lazy_load_members: false,
            types: [
              "m.room.name",
              "m.room.avatar",
              "m.room.canonical_alias",
              "m.room.encryption",
              "m.room.member",
              "m.room.create",
              "m.room.topic",
              "m.room.history_visibility",
              "m.room.tombstone",
            ],
          },
          ephemeral: {
            types: ["m.receipt", "m.typing"],
          },
          account_data: {
            types: ["m.fully_read", "m.tag", "m.bastyon.clear_history", "m.bastyon.contact_aliases"],
          },
        },
        presence: {
          types: [],
        },
        account_data: {
          types: ["m.fully_read", "m.tag", "m.bastyon.clear_history"],
        },
      };
      syncFilter = await userClient.createFilter(filterDefinition);
    } catch (e) {
      console.warn("Failed to create sync filter, falling back to unfiltered sync:", e);
    }

    // Sync config.
    // initialSyncLimit applies ONLY to the very first /sync (no saved token) —
    // the SDK clones the filter inline with this timeline limit, while all
    // incremental syncs use the uploaded filter above (limit 4, see above).
    // Was 1, which made the first sync return a single event per room and
    // forced sequential per-room scrollback to fill timelines — skeletons on
    // every first room open after install/re-login (WEE-97 item 4). Kept at 4
    // to match the incremental filter limit; full history is still loaded
    // on-demand (loadAllMessages).
    // lazyLoadMembers is OFF: with it on, a brand-new 1:1 chat had no
    // member state for the peer until they sent a first message, so
    // Pcrypto's canBeEncrypt() saw an incomplete member set and reported
    // "peer hasn't published encryption keys" for peers who had. Full
    // member state costs a heavier /sync but removes that false warning.
    // resolveInvitesToProfiles is ON: makes the SDK resolve an inviter's
    // Matrix profile (name/avatar) via getProfileInfo() for invite events.
    // Was turned off for a perf reason (wasted getProfileInfo() calls per
    // invite on every sync cycle, see git history) — re-enabled deliberately;
    // that per-invite cost is accepted as the tradeoff here.
    await userClient.startClient({
      pollTimeout: 60000,
      resolveInvitesToProfiles: true,
      initialSyncLimit: 4,
      disablePresence: true,
      lazyLoadMembers: false,
      ...(syncFilter ? { filter: syncFilter } : {}),
    });

    // Cold-start-from-push race fix:
    //
    // Matrix SDK only calls `callEventHandler.start()` after the first
    // `/sync` has transitioned to the "Prepared" state. But the very
    // sync batch that triggers Prepared ALSO contains the m.call.invite
    // (room-event or to-device) the caller sent while we were killed —
    // and the handler's Room.timeline / ToDeviceEvent listeners aren't
    // attached yet when those events fire, so Call.incoming is silently
    // dropped. On this homeserver that loses 100% of cold-start answers.
    //
    // Attaching the listeners eagerly, before the first sync batch fires,
    // lets the handler catch the invite in the usual way. CRITICAL: we
    // also have to neutralize the SDK's own startCallEventHandler so it
    // doesn't later call start() a second time. start() re-registers
    // `Room.timeline`/`ToDeviceEvent` listeners on the client's
    // EventEmitter — double-registration makes every call event fire
    // handleCallEvent twice, which Matrix logs as "already has a call
    // but got an invite - clobbering" and destroys the freshly-created
    // call, orphaning our already-created PeerConnection. The second
    // call waits for an answer that goes to the first PC → ICE never
    // reaches connected, user stares at "Connecting..." forever.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const uc = userClient as any;
      const ceh = uc.callEventHandler;
      const gceh = uc.groupCallEventHandler;

      // STEP 1: unregister SDK's built-in lazy starter. It's a Sync-
      // event listener that fires once `isInitialSyncComplete()` is
      // true, and invokes `callEventHandler.start()` again. Re-assigning
      // `uc.startCallEventHandler = ...` does NOT unregister it because
      // EventEmitter stored the original function reference. We must
      // `.off(...)` with that reference before overriding.
      const sdkStartRef = uc.startCallEventHandler;
      if (typeof sdkStartRef === "function" && typeof uc.off === "function") {
        try {
          uc.off("sync", sdkStartRef);
        } catch {
          /* ignore */
        }
      }

      // STEP 2: eagerly start so the handler's Room.timeline and
      // ToDeviceEvent listeners are attached before the very first
      // sync batch begins dispatching events. Without this, the
      // m.call.invite arriving in the initial-sync delivery is never
      // caught and Call.incoming never fires.
      if (ceh && typeof ceh.start === "function") ceh.start();
      if (gceh && typeof gceh.start === "function") gceh.start();

      // STEP 3: replace starter with no-op as a belt-and-braces guard
      // in case the SDK or any extension calls it by reference later.
      uc.startCallEventHandler = () => {};

      console.log("[matrix-client] CallEventHandler started eagerly, SDK auto-start unregistered");
    } catch (e) {
      console.warn("[matrix-client] Failed to eagerly start CallEventHandler:", e);
    }

    return userClient;
  }

  private initEvents() {
    if (!this.client) return;

    const userId = this.client.credentials?.userId;

    this.client.on("RoomMember.membership", (event: unknown, member: unknown) => {
      if (!this.chatsReady) return;
      this.onMembership?.(event, member);
    });

    this.client.on("Room.timeline", (message: unknown, _room: unknown, toStartOfTimeline: unknown) => {
      if (!this.chatsReady) return;
      // Ignore events added to start of timeline (from pagination)
      if (toStartOfTimeline) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = message as any;
      if (!msg?.event?.content) return;

      // Parse file body
      if (msg.event.content.msgtype === "m.file") {
        try { msg.event.content.pbody = JSON.parse(msg.event.content.body); } catch { /* ignore */ }
      }

      // Pass reaction events from anyone (including self) for local update
      if (msg.event.type === "m.reaction") {
        this.onTimeline?.(message, msg.event.room_id);
        return;
      }

      // Pass state events (membership, room name, power levels) from anyone
      const stateTypes = ["m.room.member", "m.room.name", "m.room.power_levels", "m.room.avatar", "m.room.topic", "m.room.pinned_events"];
      if (stateTypes.includes(msg.event.type)) {
        this.onTimeline?.(message, msg.event.room_id);
        return;
      }

      // Pass call hangup events from anyone for system message display
      if (msg.event.type === "m.call.hangup") {
        this.onTimeline?.(message, msg.event.room_id);
        return;
      }

      // Pass all messages (including own) so cross-device sync works.
      // The chat-store's handleTimelineEvent handles dedup for the sending device.
      this.onTimeline?.(message, msg.event.room_id);
    });

    this.client.on("RoomMember.typing", (event: unknown, member: unknown) => {
      this.onTyping?.(event, member);
    });

    this.client.on("Room.receipt", (event: unknown, room: unknown) => {
      if (!this.chatsReady) return;
      this.onReceipt?.(event, room);
    });

    this.client.on("Room.redaction", (event: unknown, room: unknown) => {
      if (!this.chatsReady) return;
      this.onRedaction?.(event, room);
    });

    // Fires when MY membership changes in a room (join→leave = kicked, join→ban, etc.)
    this.client.on("Room.myMembership", (room: unknown, membership: string, prevMembership: string | undefined) => {
      this.onMyMembership?.(room, membership, prevMembership);
    });

    // SDK emits "Call.incoming" when it receives m.call.invite (room or to-device)
    this.client.on("Call.incoming" as string, (call: unknown) => {
      this.onIncomingCall?.(call);
    });

    // Detect new rooms added to the SDK (avoids O(n) scan in incrementalRoomRefresh)
    this.client.on("Room" as string, (room: unknown) => {
      if (!this.chatsReady) return;
      this.onRoom?.(room);
    });

    // Room account_data changes (e.g. clear-history markers from other devices)
    this.client.on("Room.accountData" as string, (event: unknown, room: unknown) => {
      if (!this.chatsReady) return;
      this.onRoomAccountData?.(event, room);
    });

    // Global per-user account_data changes (e.g. contact aliases from other devices).
    // Fires whenever a /sync delivers a new global account_data event.
    this.client.on("accountData" as string, (event: unknown) => {
      if (!this.chatsReady) return;
      this.onAccountData?.(event);
    });

    // Listen for encryption state events — triggers decryption retry for room
    this.client.on("RoomState.events" as string, (event: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = event as any;
      const type = ev?.getType?.();
      const roomId = ev?.getRoomId?.();
      if (type === "m.room.encryption" && roomId) {
        this.onEncryptionKeyArrived?.(roomId);
      }
    });

    this.client.on("sync", (state: string) => {
      if (state === "PREPARED" || state === "SYNCING") {
        if (!this.chatsReady) {
          this.chatsReady = true;
        }
        // Healthy sync — drop any pending backoff retry and reset its attempt
        // counter so the next error episode starts from the base delay again.
        this.clearErrorRetry();
      } else if (state === "ERROR") {
        // Was retryImmediately() on every ERROR — that hammered the SAME dead
        // host with no backoff and span the ERROR↔RECONNECTING loop forever
        // (WEE-105 H2). Now we retry the same host behind exponential backoff
        // while the watchdog (below) escalates to a mirror if it stays stuck.
        this.scheduleErrorRetry();
      } else if (state === "STOPPED") {
        console.warn("[matrix] Sync stopped unexpectedly");
      }
      // Feed every state to the watchdog so it can fail over to a mirror when
      // the sync is wedged while online (WEE-105 H3).
      this.watchdog?.notifySync(state);
      this.onSync?.(state as "PREPARED" | "SYNCING" | "ERROR" | "STOPPED" | "RECONNECTING");
    });
  }

  /** Schedule a single retry of the CURRENT host behind exponential backoff.
   *  No-op when a retry is already pending (one in flight at a time). */
  private scheduleErrorRetry(): void {
    if (this.errorRetryTimer !== null) return;
    const delay = Math.min(ERROR_RETRY_BASE_MS * 2 ** this.errorRetryAttempt, ERROR_RETRY_MAX_MS);
    this.errorRetryAttempt += 1;
    console.warn(`[matrix] Sync error — backoff retry in ${delay}ms (attempt ${this.errorRetryAttempt})`);
    this.errorRetryTimer = setTimeout(() => {
      this.errorRetryTimer = null;
      try {
        this.client?.retryImmediately();
      } catch (e) {
        console.warn("[matrix] retryImmediately failed:", e);
      }
    }, delay);
  }

  /** Cancel any pending backoff retry and reset its attempt counter. */
  private clearErrorRetry(): void {
    if (this.errorRetryTimer !== null) {
      clearTimeout(this.errorRetryTimer);
      this.errorRetryTimer = null;
    }
    this.errorRetryAttempt = 0;
  }

  /** Probe `[primary, ...mirrors]` and return the first live homeserver host.
   *  Used before connecting so a dead/throttled primary doesn't strand /sync
   *  (WEE-105 H1). Honours primary priority so a healthy primary is untouched. */
  async pingServers(): Promise<string> {
    // Under Tor the SDK routes through the local reverse proxy; a bare axios
    // ping would always fail and just burn 2×PING_TIMEOUT_MS of dead boot
    // latency. Tor is out of scope here (it isn't a working transport for us),
    // so keep the current host and skip probing entirely.
    if (this.torProxyUrl) return hostFromBaseUrl(this.baseUrl);
    return pickLiveMatrixHost((host) => this.probeHost(host));
  }

  /** Single-host /versions probe. Tor skips network and treats the current
   *  baseUrl host as live. */
  private async probeHost(host: string): Promise<boolean> {
    if (this.torProxyUrl) return host === hostFromBaseUrl(this.baseUrl);
    try {
      await axios.get(`https://${host}/_matrix/client/versions`, { timeout: PING_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /** First live host in `order`, or null when every probe fails (no primary fallback). */
  private async findLiveHost(order: readonly string[]): Promise<string | null> {
    if (this.torProxyUrl) return hostFromBaseUrl(this.baseUrl);
    return findLiveMatrixHost((host) => this.probeHost(host), order);
  }

  /** Stop the current SDK client without tearing down handlers/credentials/
   *  watchdog — used by the mirror failover recreate so the rebuilt client
   *  keeps the same callbacks and the watchdog keeps monitoring. */
  private stopClientOnly(): void {
    this.clearErrorRetry();
    if (this.client) {
      try { this.client.removeAllListeners(); } catch { /* ignore */ }
      try { this.client.stopClient(); } catch { /* ignore */ }
    }
    this.client = null;
    this.chatsReady = false;
  }

  /** Destroy current client (if any) and rebuild against `host`. Throws on failure. */
  private async swapClientToHost(host: string): Promise<void> {
    this.stopClientOnly();
    this.baseUrl = `https://${host}`;
    const nextClient = await this.getClient();
    if (!nextClient) {
      throw new Error(`[matrix] failover to ${host} returned no client`);
    }
    this.client = nextClient;
    this.store = nextClient.store;
    this.ready = true;
    this.error = false;
  }

  /**
   * After a destructive swap failed, try any host that still answers /versions.
   * Returns true when a client was rebuilt.
   */
  private async tryRebuildOnAnyLiveHost(preferHost: string): Promise<boolean> {
    const order = failoverProbeOrder(preferHost, MATRIX_SYNC_HOSTS);
    for (const host of order) {
      const live = await this.probeHost(host);
      if (!live) continue;
      try {
        this.baseUrl = `https://${host}`;
        const rebuilt = await this.getClient();
        if (rebuilt) {
          this.client = rebuilt;
          this.store = rebuilt.store;
          this.ready = true;
          this.error = false;
          console.warn(`[matrix] failover recovery rebuilt client on ${host}`);
          return true;
        }
      } catch (e) {
        console.warn(`[matrix] failover recovery on ${host} failed:`, e);
      }
    }
    return false;
  }

  /** Watchdog-triggered recovery: rotate baseUrl to the next mirror and rebuild
   *  the client without a page reload (WEE-105 A2).
   *
   *  Probe-before-destroy: never call stopClientOnly until at least one
   *  homeserver answers /versions. A total DNS outage must leave the existing
   *  (ERROR) client in place so scheduleErrorRetry can heal when the network
   *  returns — destroying first left the tab permanently dead (client=null). */
  private async recreateOnNextMirror(): Promise<void> {
    // Yield to any in-flight client (re)creation — a concurrent boot-retry
    // init() or a previous recreate owns `this.client` until it settles.
    if (this.failoverActive || this.building) return;
    this.failoverActive = true;
    this.building = true;
    const current = hostFromBaseUrl(this.baseUrl);
    const next = nextMatrixHost(current);
    console.warn(`[matrix] sync stuck — failing over ${current} → ${next}`);
    let deferred = false;
    try {
      const liveHost = await this.findLiveHost(failoverProbeOrder(next, MATRIX_SYNC_HOSTS));
      if (!liveHost) {
        console.warn("[matrix] failover deferred — no live host");
        deferred = true;
        return;
      }

      try {
        await this.swapClientToHost(liveHost);
        this.clearClientRecovery();
      } catch (e) {
        console.error("[matrix] mirror failover recreate error:", e);
        // Previous client is already stopped — try any other live host before
        // accepting a dead-client state.
        this.ready = false;
        this.client = null;
        this.store = null;
        const recovered = await this.tryRebuildOnAnyLiveHost(current);
        if (!recovered) {
          this.error = String(e);
          console.error("[matrix] failover recovery failed on all hosts:", e);
          this.scheduleClientRecovery();
        }
      }
    } finally {
      this.building = false;
      this.failoverActive = false;
      if (deferred) {
        // Do not burn the failover budget on a no-op outage probe.
        this.watchdog?.deferFailover();
      } else {
        // Re-arm so the new mirror is watched too — if it is also dead the
        // watchdog rotates to the next host on the following episode (up to the
        // failover budget).
        this.watchdog?.reset();
      }
    }
  }

  /** Schedule a rebuild when `client === null` after a failed destructive failover.
   *  Single-flight exponential backoff; also woken by `online` / visibility. */
  private scheduleClientRecovery(): void {
    if (this.client || this.clientRecoveryTimer !== null) return;
    this.attachClientRecoveryListeners();
    const delay = Math.min(
      CLIENT_RECOVERY_BASE_MS * 2 ** this.clientRecoveryAttempt,
      CLIENT_RECOVERY_MAX_MS,
    );
    this.clientRecoveryAttempt += 1;
    console.warn(
      `[matrix] client dead — recovery retry in ${delay}ms (attempt ${this.clientRecoveryAttempt})`,
    );
    this.clientRecoveryTimer = setTimeout(() => {
      this.clientRecoveryTimer = null;
      void this.attemptClientRecovery();
    }, delay);
  }

  private clearClientRecovery(): void {
    if (this.clientRecoveryTimer !== null) {
      clearTimeout(this.clientRecoveryTimer);
      this.clientRecoveryTimer = null;
    }
    this.clientRecoveryAttempt = 0;
    this.detachClientRecoveryListeners();
  }

  private attachClientRecoveryListeners(): void {
    if (this.clientRecoveryListenersAttached || typeof window === "undefined") return;
    this.clientRecoveryListenersAttached = true;
    this.onOnlineRecovery = () => {
      if (this.client) return;
      // Collapse pending backoff and try immediately when the browser reports connectivity.
      if (this.clientRecoveryTimer !== null) {
        clearTimeout(this.clientRecoveryTimer);
        this.clientRecoveryTimer = null;
      }
      void this.attemptClientRecovery();
    };
    this.onVisibilityRecovery = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (this.client) return;
      if (this.clientRecoveryTimer !== null) {
        clearTimeout(this.clientRecoveryTimer);
        this.clientRecoveryTimer = null;
      }
      void this.attemptClientRecovery();
    };
    window.addEventListener("online", this.onOnlineRecovery);
    document.addEventListener("visibilitychange", this.onVisibilityRecovery);
  }

  private detachClientRecoveryListeners(): void {
    if (!this.clientRecoveryListenersAttached) return;
    this.clientRecoveryListenersAttached = false;
    if (typeof window !== "undefined" && this.onOnlineRecovery) {
      window.removeEventListener("online", this.onOnlineRecovery);
    }
    if (typeof document !== "undefined" && this.onVisibilityRecovery) {
      document.removeEventListener("visibilitychange", this.onVisibilityRecovery);
    }
    this.onOnlineRecovery = null;
    this.onVisibilityRecovery = null;
  }

  private async attemptClientRecovery(): Promise<void> {
    if (this.client || this.building || this.failoverActive) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.scheduleClientRecovery();
      return;
    }
    this.building = true;
    try {
      const liveHost = await this.findLiveHost(MATRIX_SYNC_HOSTS);
      if (!liveHost) {
        this.scheduleClientRecovery();
        return;
      }
      this.baseUrl = `https://${liveHost}`;
      const rebuilt = await this.getClient();
      if (rebuilt) {
        this.client = rebuilt;
        this.store = rebuilt.store;
        this.ready = true;
        this.error = false;
        this.clearClientRecovery();
        this.ensureWatchdog();
        this.watchdog?.reset();
        console.warn(`[matrix] dead-client recovery rebuilt on ${liveHost}`);
      } else {
        this.scheduleClientRecovery();
      }
    } catch (e) {
      console.warn("[matrix] dead-client recovery failed:", e);
      this.scheduleClientRecovery();
    } finally {
      this.building = false;
    }
  }

  /** Create the sync watchdog once. Persists across mirror recreates so the
   *  rebuilt client is monitored too; torn down only in destroy(). */
  private ensureWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = new SyncWatchdog({
      onFailover: () => { void this.recreateOnNextMirror(); },
      isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine),
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (h) => clearTimeout(h),
    });
  }

  /** Full init: create client + init db */
  async init(): Promise<void> {
    // Reset transient failure state from any previous attempt. Without this,
    // `isReady()` would stay `false` on a successful retry because it ANDs
    // `ready` with `!error`, and a stale error from attempt N would mask a
    // healthy attempt N+1 — see WEE-46 retry path.
    this.error = false;
    this.ready = false;
    this.building = true;
    try {
      // Ping-and-pick a live homeserver before connecting (WEE-105 H1/A1).
      // Skipped during an in-flight mirror failover, which has already set
      // baseUrl to the mirror it wants and must not be reset back to primary.
      if (!this.failoverActive) {
        try {
          this.baseUrl = `https://${await this.pingServers()}`;
        } catch (e) {
          console.warn("[matrix] pingServers failed, using current baseUrl:", e);
        }
      }
      this.ensureWatchdog();
      this.client = await this.getClient();
      if (this.client) {
        this.store = this.client.store;
        this.ready = true;
      }
    } catch (e) {
      console.error("Matrix init error:", e);
      this.error = String(e);
    } finally {
      this.building = false;
    }

    // Init file storage
    try {
      this.db = await createChatStorage("files", 1);
    } catch { /* ignore */ }
  }

  isReady(): boolean {
    return this.ready && !this.error;
  }

  isChatsReady(): boolean {
    return this.chatsReady;
  }

  /** Send text message. `txnId` is the Matrix transaction ID used for
   *  idempotency — passing a stable ID (e.g. LocalMessage.clientId) lets the
   *  server deduplicate retries / multi-tab races into a single event. */
  async sendText(roomId: string, text: string, txnId?: string): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");
    const content = sdk.ContentHelpers.makeTextMessage(text);
    const res = txnId !== undefined
      // matrix-js-sdk routes sendEvent through the same txnId dedup path that
      // sendMessage uses, so we can go through sendEvent when we have an ID.
      ? await this.client.sendEvent(roomId, "m.room.message", content, txnId)
      : await this.client.sendMessage(roomId, content);
    return (res as { event_id: string }).event_id;
  }

  /** Send encrypted text message. Returns server event_id. */
  async sendEncryptedText(roomId: string, content: Record<string, unknown>, txnId?: string): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");
    const res = await this.client.sendEvent(roomId, "m.room.message", content, txnId);
    return (res as { event_id: string }).event_id;
  }

  /** Matrix media upload endpoint for native TorFile streaming uploads. */
  getMediaUploadEndpoint(fileName?: string): { url: string; authorization: string } {
    if (!this.client) throw new Error("Client not initialized");
    const accessToken = this.client.credentials?.accessToken;
    if (!accessToken) throw new Error("No access token");

    const url = new URL(`${this.baseUrl}/_matrix/media/v3/upload`);
    if (fileName) {
      url.searchParams.set("filename", fileName);
    }

    return {
      url: url.toString(),
      authorization: `Bearer ${accessToken}`,
    };
  }

  /** Upload content to Matrix server.
   *  @param progressHandler — optional callback receiving { loaded, total }
   *  @param signal — optional AbortSignal to cancel the upload */
  async uploadContent(
    file: Blob,
    progressHandler?: (progress: { loaded: number; total: number }) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");

    const { shouldUseNativeTorUpload, uploadMediaViaTorFile } = await import(
      "@/shared/lib/file-transfer/tor-media-transfer"
    );

    if (shouldUseNativeTorUpload(file.size)) {
      const contentUri = await uploadMediaViaTorFile({
        blob: file,
        mimeType: file.type || "application/octet-stream",
        getUploadEndpoint: () => this.getMediaUploadEndpoint(),
        onProgress: progressHandler,
        signal,
      });
      return this.client.mxcUrlToHttp(contentUri) ?? contentUri;
    }

    const opts: Record<string, unknown> = {};
    if (progressHandler) {
      opts.progressHandler = progressHandler;
    }
    if (signal) {
      opts.abortSignal = signal;
    }
    const src = await this.client.uploadContent(file, opts);
    return this.client.mxcUrlToHttp(src.content_uri);
  }

  /** Upload content and return the raw mxc:// URI (for use in state events like room avatar) */
  async uploadContentMxc(file: Blob): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");
    const res = await this.client.uploadContent(file, {});
    return res.content_uri;
  }

  /** Set the user's Matrix display name (m.room.member.displayname).
   *  Peers receive this via room state events on next sync; required so other
   *  users see the nickname instead of a truncated wallet address. */
  async setDisplayName(name: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    await this.client.setDisplayName(name);
  }

  /** Upload an avatar blob and return the raw mxc:// URI for use in setAvatarMxc. */
  async uploadAvatar(blob: Blob): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");
    const res = await this.client.uploadContent(blob, { type: blob.type });
    return res.content_uri;
  }

  /** Set the user's Matrix avatar URL (m.room.member.avatar_url).
   *  Pass an mxc:// URI returned by uploadAvatar. */
  async setAvatarMxc(mxcUrl: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    await this.client.setAvatarUrl(mxcUrl);
  }

  /** Convert an mxc:// URI to an HTTP URL */
  mxcToHttp(mxcUrl: string): string | null {
    if (!this.client) return null;
    return this.client.mxcUrlToHttp(mxcUrl) ?? null;
  }

  /** Convert an mxc:// URI to a server-side thumbnail HTTP URL
   *  (`/_matrix/media/.../thumbnail`). The homeserver downscales and
   *  re-encodes, so the feed can show a light preview almost instantly
   *  instead of pulling the full-size original (WEE-71, H1).
   *
   *  Only valid for UNENCRYPTED media: an E2E attachment is ciphertext on
   *  the server, so a server-side thumbnail would be undecryptable garbage —
   *  those must be downscaled client-side after decrypt. Returns null when
   *  the client is missing or the URI cannot be resolved. */
  mxcToThumbnail(
    mxcUrl: string,
    w: number,
    h: number,
    method: "scale" | "crop" = "scale",
  ): string | null {
    if (!this.client) return null;
    return this.client.mxcUrlToHttp(mxcUrl, w, h, method, true) ?? null;
  }

  /** Fetch URL preview (Open Graph metadata) from Matrix server */
  async getUrlPreview(url: string): Promise<{
    siteName?: string;
    title?: string;
    description?: string;
    imageUrl?: string;
    imageWidth?: number;
    imageHeight?: number;
  } | null> {
    if (!this.client) return null;
    try {
      const data = await this.client.getUrlPreview(url, Date.now());
      const mxcImage = data["og:image"] as string | undefined;
      return {
        siteName: data["og:site_name"] as string | undefined,
        title: data["og:title"] as string | undefined,
        description: data["og:description"] as string | undefined,
        imageUrl: mxcImage ? (this.client.mxcUrlToHttp(mxcImage) ?? undefined) : undefined,
        imageWidth: data["og:image:width"] as number | undefined,
        imageHeight: data["og:image:height"] as number | undefined,
      };
    } catch (e) {
      console.warn("[matrix-client] getUrlPreview error:", e);
      return null;
    }
  }

  /** Get all rooms */
  getRooms(): unknown[] {
    return this.client?.getRooms() ?? [];
  }

  /** Get a specific room */
  getRoom(roomId: string): unknown {
    return this.client?.getRoom(roomId);
  }

  /** Current Matrix /sync state, or null if the client is not initialized.
   *  "SYNCING" means initial sync finished and the client is doing incremental
   *  syncs — at that point all rooms are materialized into SDK memory (WEE-61).
   *  Returns the underlying `SyncState` string enum value ("PREPARED" | "SYNCING"
   *  | "ERROR" | "STOPPED" | "RECONNECTING" | "CATCHUP") widened to string. */
  getSyncState(): string | null {
    return this.client?.getSyncState() ?? null;
  }

  /** Create a room */
  async createRoom(opts: Record<string, unknown>): Promise<{ room_id: string }> {
    if (!this.client) throw new Error("Client not initialized");
    return this.client.createRoom(opts);
  }

  /** Invite a user to a room */
  async invite(roomId: string, userId: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    await this.client.invite(roomId, userId);
  }

  /** Join a room */
  async joinRoom(roomId: string): Promise<unknown> {
    if (!this.client) throw new Error("Client not initialized");
    return this.client.joinRoom(roomId);
  }

  /** Set power level */
  async setPowerLevel(roomId: string, userId: string, level: number, event: unknown): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setPowerLevel(roomId, userId, level, event);
    } catch { /* ignore */ }
  }

  /** Send state event */
  async sendStateEvent(roomId: string, type: string, content: unknown, stateKey: string): Promise<unknown> {
    if (!this.client) throw new Error("Client not initialized");
    return this.client.sendStateEvent(roomId, type, content, stateKey);
  }

  /** Get user ID */
  getUserId(): string | null {
    return this.client?.credentials?.userId ?? null;
  }

  /** Matrix account-data ignore list (`m.ignored_user_list`) */
  getIgnoredMatrixUserIds(): string[] {
    if (!this.client) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this.client as any).getIgnoredUsers() as string[];
    } catch {
      return [];
    }
  }

  /** True if the Matrix user ID is on the ignore list */
  isMatrixUserIgnored(userId: string): boolean {
    if (!this.client) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this.client as any).isUserIgnored(userId) as boolean;
    } catch {
      return false;
    }
  }

  /** Convert address to Matrix user ID */
  matrixId(address: string, domain?: string): string {
    return `@${address}:${domain ?? MATRIX_SERVER}`;
  }

  /** Check if a userId is the current user */
  isMe(userId: string): boolean {
    return getmatrixid(userId) === getmatrixid(this.getUserId() ?? "");
  }

  /** Mark messages as read using /read_markers endpoint (same as old bastyon-chat).
   *  The /receipt/ endpoint returns 500 on this server, but /read_markers works.
   *  Returns true if the server accepted the receipt, false on error. */
  async sendReadReceipt(event: unknown): Promise<boolean> {
    if (!this.client) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = event as any;
      const roomId: string = ev.getRoomId?.() ?? ev.event?.room_id;
      const eventId: string = ev.getId?.() ?? ev.event?.event_id;
      if (!roomId || !eventId) return false;

      // Use setRoomReadMarkers — same approach as old bastyon-chat (list/index.js:666)
      // This uses POST /rooms/{roomId}/read_markers instead of /receipt/
      await this.client.setRoomReadMarkers(roomId, eventId, ev);
      return true;
    } catch (e) {
      console.warn("[matrix-client] sendReadReceipt error:", e);
      return false;
    }
  }

  /** Load older messages for a room (scrollback/pagination) */
  async scrollback(roomId: string, limit = 50): Promise<void> {
    if (!this.client) return;
    const room = this.client.getRoom(roomId);
    if (!room) return;
    try {
      await this.client.scrollback(room, limit);
    } catch (e) {
      console.warn("[matrix-client] scrollback error:", e);
    }
  }

  /** Fetch a single event by ID directly from the server.
   *  Bypasses the sync pipeline — used for push fast-path. */
  async fetchRoomEvent(roomId: string, eventId: string): Promise<Record<string, unknown> | null> {
    if (!this.client) return null;
    try {
      const event = await this.client.fetchRoomEvent(roomId, eventId);
      return event as Record<string, unknown>;
    } catch (e) {
      console.warn("[matrix-client] fetchRoomEvent error:", e);
      return null;
    }
  }

  /** Fetch a specific event and its surrounding context from the server.
   *  Uses the Matrix SDK timeline API. Returns raw timeline events. */
  async fetchEventContext(roomId: string, eventId: string, limit = 50): Promise<unknown[]> {
    if (!this.client) return [];
    try {
      const room = this.client.getRoom(roomId);
      if (!room) return [];

      const timelineSet = room.getUnfilteredTimelineSet();
      const timeline = await this.client.getEventTimeline(timelineSet, eventId);
      if (!timeline) return [];

      try {
        await this.client.paginateEventTimeline(timeline, { backwards: true, limit: Math.floor(limit / 2) });
      } catch { /* may already be at start */ }
      try {
        await this.client.paginateEventTimeline(timeline, { backwards: false, limit: Math.floor(limit / 2) });
      } catch { /* may already be at end */ }

      return timeline.getEvents() ?? [];
    } catch (e) {
      console.warn("[matrix-client] fetchEventContext error:", e);
      return [];
    }
  }

  /** Send a reaction to an event. Returns the server-assigned event ID. */
  async sendReaction(roomId: string, eventId: string, emoji: string): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");
    const res = await this.client.sendEvent(roomId, "m.reaction", {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: eventId,
        key: emoji,
      },
    });
    return (res as { event_id: string }).event_id;
  }

  /** Redact (delete) an event — calls SDK HTTP layer directly with /redact/ endpoint */
  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<unknown> {
    if (!this.client) throw new Error("Client not initialized");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = this.client as any;
    const txnId = `m${Date.now()}.${Math.floor(Math.random() * 100)}`;
    const encodedRoomId = encodeURIComponent(roomId);
    const encodedEventId = encodeURIComponent(eventId);
    const path = `/rooms/${encodedRoomId}/redact/${encodedEventId}/${txnId}`;
    const body = reason ? { reason } : {};
    return client.http.authedRequest("PUT", path, undefined, body);
  }

  /** Set typing indicator via standard Matrix API
   *  (PUT /_matrix/client/v3/rooms/{roomId}/typing/{userId}). */
  async setTyping(roomId: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    try {
      const TYPING_TIMEOUT_MS = 20_000;
      await this.client.sendTyping(roomId, isTyping, isTyping ? TYPING_TIMEOUT_MS : 0);
    } catch (e) {
      console.warn("[matrix-client] setTyping error:", e);
    }
  }

  /** Leave a room (Matrix leave API) */
  async leaveRoom(roomId: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    await this.client.leave(roomId);
  }

  /** Forget a room after leaving (removes from server-side room list) */
  async forgetRoom(roomId: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    await this.client.forget(roomId, true);
  }

  /** Set per-user per-room account data (syncs across devices via /sync) */
  async setRoomAccountData(roomId: string, eventType: string, content: Record<string, unknown>): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    await this.client.setRoomAccountData(roomId, eventType, content);
  }

  /** Get per-user per-room account data */
  getRoomAccountData(roomId: string, eventType: string): Record<string, unknown> | null {
    if (!this.client) return null;
    const room = this.client.getRoom(roomId);
    if (!room) return null;
    const event = room.getAccountData(eventType);
    return event?.getContent() ?? null;
  }

  /** Set per-user GLOBAL account data (syncs across the user's devices via /sync) */
  async setAccountData(eventType: string, content: Record<string, unknown>): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.client as any).setAccountData(eventType, content);
  }

  /** Get per-user GLOBAL account data (cached locally by the SDK) */
  getAccountData(eventType: string): Record<string, unknown> | null {
    if (!this.client) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = (this.client as any).getAccountData?.(eventType);
    return event?.getContent?.() ?? null;
  }

  /** Kick a user from a room (requires admin power level) */
  async kick(roomId: string, userId: string, reason?: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    await this.client.kick(roomId, userId, reason);
  }

  /** Ban a user from a room (requires admin power level) */
  async ban(roomId: string, userId: string, reason?: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    await this.client.ban(roomId, userId, reason);
  }

  /** Unban a user from a room */
  async unban(roomId: string, userId: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    await this.client.unban(roomId, userId);
  }

  /** Set the room topic (m.room.topic state event) */
  async setRoomTopic(roomId: string, topic: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");
    await this.client.setRoomTopic(roomId, topic);
  }

  /** Send a poll start event (MSC3381) */
  async sendPollStart(roomId: string, content: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");
    const res = await this.client.sendEvent(roomId, "org.matrix.msc3381.poll.start", content);
    return (res as { event_id: string }).event_id;
  }

  /** Send a poll response/vote event (MSC3381) */
  async sendPollResponse(roomId: string, content: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");
    const res = await this.client.sendEvent(roomId, "org.matrix.msc3381.poll.response", content);
    return (res as { event_id: string }).event_id;
  }

  /** Send a poll end event (MSC3381) */
  async sendPollEnd(roomId: string, content: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");
    const res = await this.client.sendEvent(roomId, "org.matrix.msc3381.poll.end", content);
    return (res as { event_id: string }).event_id;
  }

  /** Resolve a room alias to a room ID */
  async getRoomIdForAlias(alias: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const result = await this.client.getRoomIdForAlias(alias);
      return (result as { room_id: string }).room_id ?? null;
    } catch {
      return null;
    }
  }

  /** Delete a room alias from the server directory */
  async deleteAlias(alias: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.deleteAlias(alias);
      return true;
    } catch {
      return false;
    }
  }

  /** Search the Matrix user directory (/_matrix/client/v3/user_directory/search).
   *  Used as a fallback when Bastyon RPC searchusers is unavailable (e.g. CORS on web).
   *  Returns an array of { user_id, display_name, avatar_url } entries. */
  async searchUserDirectory(
    term: string,
    limit = 20,
  ): Promise<{ limited: boolean; results: Array<{ user_id: string; display_name?: string; avatar_url?: string }> }> {
    if (!this.client) throw new Error("Client not initialized");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = this.client as any;
    // matrix-js-sdk exposes searchUserDirectory({ term, limit })
    const res = await client.searchUserDirectory({ term, limit });
    return {
      limited: Boolean(res?.limited),
      results: (res?.results ?? []) as Array<{ user_id: string; display_name?: string; avatar_url?: string }>,
    };
  }

  /** Destroy the client */
  destroy() {
    this.watchdog?.stop();
    this.watchdog = null;
    this.failoverActive = false;
    this.building = false;
    this.clearErrorRetry();
    this.clearClientRecovery();
    if (this.client) {
      this.client.removeAllListeners();
      this.client.stopClient();
    }
    this.chatsReady = false;
    this.ready = false;
    this.error = false;
    this.client = null;
    this.store = null;
  }

  getSDK(): MatrixSDK {
    return this.sdk;
  }

  getDB(): ChatStorageInstance | null {
    return this.db;
  }
}

/** Singleton instance */
let instance: MatrixClientService | null = null;

export function getMatrixClientService(): MatrixClientService {
  if (!instance) {
    instance = new MatrixClientService();
  }
  return instance;
}

export function resetMatrixClientService() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
