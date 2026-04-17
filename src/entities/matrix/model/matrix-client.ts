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
  private typingTimers = new Map<string, number>();
  private torProxyUrl: string = '';

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

    const indexedDBStore = new sdk.IndexedDBStore({
      indexedDB: window.indexedDB,
      dbName: "matrix-js-sdk-v6:" + this.credentials.username,
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
      iceCandidatePoolSize: 20,
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
      fallbackICEServerAllowed: true,
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
            // fire Call.incoming. Raise to 20 so a realistic burst of
            // new events still fits without losing the call invite.
            limit: 20,
            lazy_load_members: true,
          },
          state: {
            lazy_load_members: true,
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
            types: ["m.fully_read", "m.tag", "m.bastyon.clear_history"],
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

    // Sync config: lazy loading for speed, members loaded explicitly when needed
    // initialSyncLimit: 1 keeps sync payload small for accounts with many rooms.
    // Only the last timeline event per room is included; full history is loaded
    // on-demand when a room is opened (loadAllMessages).
    await userClient.startClient({
      pollTimeout: 60000,
      resolveInvitesToProfiles: false,
      initialSyncLimit: 1,
      disablePresence: true,
      lazyLoadMembers: true,
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

    // Listen for sendToDevice typing events (workaround for broken /typing endpoint)
    this.client.on("toDeviceEvent", (event: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = event as any;
      if (ev?.getType?.() !== MatrixClientService.TYPING_EVENT_TYPE) return;
      const content = ev.getContent?.() ?? {};
      const roomId = content.room_id as string;
      const isTyping = content.typing as boolean;
      const senderId = ev.getSender?.() as string;
      if (!roomId || !senderId || senderId === userId) return;

      // Build a member-like object matching what onTyping expects
      const member = { roomId, userId: senderId, typing: isTyping };
      this.onTyping?.(event, member);

      // Auto-clear typing after 5s if no "stop typing" received
      if (isTyping) {
        const key = `${roomId}:${senderId}`;
        if (this.typingTimers.has(key)) {
          clearTimeout(this.typingTimers.get(key)!);
        }
        this.typingTimers.set(key, window.setTimeout(() => {
          this.typingTimers.delete(key);
          const fakeMember = { roomId, userId: senderId, typing: false };
          this.onTyping?.(null, fakeMember);
        }, 5000));
      } else {
        const key = `${roomId}:${senderId}`;
        if (this.typingTimers.has(key)) {
          clearTimeout(this.typingTimers.get(key)!);
          this.typingTimers.delete(key);
        }
      }
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
      } else if (state === "ERROR") {
        console.warn("[matrix] Sync error — requesting immediate retry");
        this.client?.retryImmediately();
      } else if (state === "STOPPED") {
        console.warn("[matrix] Sync stopped unexpectedly");
      }
      this.onSync?.(state as "PREPARED" | "SYNCING" | "ERROR" | "STOPPED" | "RECONNECTING");
    });
  }

  /** Full init: create client + init db */
  async init(): Promise<void> {
    try {
      this.client = await this.getClient();
      if (this.client) {
        this.store = this.client.store;
        this.ready = true;
      }
    } catch (e) {
      console.error("Matrix init error:", e);
      this.error = String(e);
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

  /** Send text message. Returns server event_id. */
  async sendText(roomId: string, text: string): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");
    const content = sdk.ContentHelpers.makeTextMessage(text);
    const res = await this.client.sendMessage(roomId, content);
    return (res as { event_id: string }).event_id;
  }

  /** Send encrypted text message. Returns server event_id. */
  async sendEncryptedText(roomId: string, content: Record<string, unknown>, txnId?: string): Promise<string> {
    if (!this.client) throw new Error("Client not initialized");
    const res = await this.client.sendEvent(roomId, "m.room.message", content, txnId);
    return (res as { event_id: string }).event_id;
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

  /** Convert an mxc:// URI to an HTTP URL */
  mxcToHttp(mxcUrl: string): string | null {
    if (!this.client) return null;
    return this.client.mxcUrlToHttp(mxcUrl) ?? null;
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

  /** Custom typing event type for sendToDevice fallback */
  private static TYPING_EVENT_TYPE = "com.bastyon.typing";

  /** Set typing indicator via sendToDevice (bypasses broken /typing endpoint).
   *  Sends typing state directly to other room members' devices. */
  async setTyping(roomId: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    try {
      const myUserId = this.getUserId();
      if (!myUserId) return;

      const room = this.client.getRoom(roomId);
      if (!room) return;

      // Get joined members, exclude self
      const members: unknown[] = room.getJoinedMembers?.() ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const otherMembers = members.filter((m: any) => m.userId !== myUserId);
      if (otherMembers.length === 0) return;

      // Build contentMap: Map<userId, Map<deviceId, content>>
      const contentMap = new Map<string, Map<string, Record<string, unknown>>>();
      for (const member of otherMembers) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userId = (member as any).userId as string;
        const deviceMap = new Map<string, Record<string, unknown>>();
        deviceMap.set("*", { room_id: roomId, typing: isTyping });
        contentMap.set(userId, deviceMap);
      }

      await this.client.sendToDevice(MatrixClientService.TYPING_EVENT_TYPE, contentMap);
    } catch (e) {
      console.warn("[matrix-client] setTyping (toDevice) error:", e);
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

  /** Destroy the client */
  destroy() {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.stopClient();
    }
    // Clear typing timers
    for (const timer of this.typingTimers.values()) {
      clearTimeout(timer);
    }
    this.typingTimers.clear();
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
