import {
  createAppInitializer,
  PocketnetInstanceConfigurator
} from "@/app/providers";
import { useChatStore } from "@/entities/chat";
import { useUserStore } from "@/entities/user/model";
import { useCallStore } from "@/entities/call/model/call-store";
import { useChannelStore } from "@/entities/channel/model/channel-store";
import {
  getMatrixClientService,
  resetMatrixClientService,
  MatrixKit,
  Pcrypto,
} from "@/entities/matrix";
import type { UserWithPrivateKeys } from "@/entities/matrix/model/matrix-crypto";
import { useCallService } from "@/features/video-calls/model/call-service";
import { getmatrixid } from "@/shared/lib/matrix/functions";
import { initChatDb, deleteChatDb, closeChatDb } from "@/shared/lib/local-db";
import { clearAllDrafts } from "@/shared/lib/drafts";
import { clearQueue } from "@/shared/lib/offline-queue";
import { deleteLegacyCache } from "@/shared/lib/cache/chat-cache";
import { clearAccountLocalStorage } from "@/shared/lib/clear-account-storage";
import { isNative } from "@/shared/lib/platform";
import { useLocalStorage } from "@/shared/lib/browser";
import { convertToHexString } from "@/shared/lib/convert-to-hex-string";
import { mergeObjects } from "@/shared/lib/merge-objects";

import { useAsyncOperation } from "@/shared/use";
import { bootStatus } from "@/app/model/boot-status";
import { withTimeout } from "@/shared/lib/with-timeout";
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";

import type { AuthData, UserData } from "./types";
import { SessionManager, type StoredSession } from "./session-manager";
import { BackgroundSyncManager } from "./background-sync";

import { getAddressFromPubKey } from "../lib";
import { createKeyPair } from "./key-pair";

const NAMESPACE = "auth";

/** Hex-encode a string: each char → 2-digit hex of its char code.
 *  Matches bastyon-chat/src/application/functions.js hexEncode() */
function hexEncode(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    let ch = text.charCodeAt(i);
    if (ch > 0xff) ch -= 0x350;
    let hex = ch.toString(16);
    while (hex.length < 2) hex = "0" + hex;
    result += hex;
  }
  return result;
}

/** Derive Matrix credentials matching original bastyon-chat:
 *  - username = hexEncode(address).toLowerCase()  (address stored hex-encoded in original)
 *  - password = SHA256(SHA256(Buffer.from(privateKey)))  (UTF-8 encoding, NOT "hex") */
function deriveMatrixCredentials(address: string, privateKey: string) {
  const passwordHash = bitcoin.crypto
    .sha256(bitcoin.crypto.sha256(Buffer.from(privateKey)))
    .toString("hex");
  return {
    username: hexEncode(address).toLowerCase(),
    password: passwordHash,
    address,
  };
}

/** Hex-decode a string: reverse of hexEncode.
 *  Matches bastyon-chat/src/application/functions.js hexDecode() */
function hexDecode(hex: string): string {
  let result = "";
  for (let i = 2; i <= hex.length; i += 2) {
    let ch = parseInt(hex.substring(i - 2, i), 16);
    if (ch >= 128) ch += 0x350;
    result += String.fromCharCode(ch);
  }
  return result;
}

/** Generate 12 BIP32 key pairs at m/33'/0'/0'/{1-12}' for Pcrypto encryption.
 *  Matches original: bitcoin.bip32.fromSeed(Buffer.from(privateKey, "hex")) */
function generateEncryptionKeys(privateKeyHex: string) {
  const key = Buffer.from(privateKeyHex, "hex");
  const root = bitcoin.bip32.fromSeed(key);

  const keys: Array<{ pair: unknown; public: string; private: Buffer }> = [];
  for (let i = 1; i <= 12; i++) {
    const child = root.derivePath(`m/33'/0'/0'/${i}'`);
    keys.push({
      pair: bitcoin.ECPair.fromPrivateKey(child.privateKey),
      public: child.publicKey.toString("hex"),
      private: child.privateKey,
    });
  }
  return keys;
}

let _onSyncStatusCallback: ((state: string) => void) | null = null;

/** Extract a numeric error code from various error shapes returned by the SDK/RPC layer.
 *  The Actions system wraps errors differently — this covers common patterns:
 *  - Direct code property: { code: 18 }
 *  - Nested: { error: { code: 18 } }
 *  - String error code: "18" */
function extractErrorCode(err: unknown): number | null {
  if (err == null) return null;
  if (typeof err === "number") return err;
  if (typeof err === "string") { const n = parseInt(err, 10); return isNaN(n) ? null : n; }
  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.code === "number") return e.code;
    if (typeof e.code === "string") { const n = parseInt(e.code, 10); return isNaN(n) ? null : n; }
    if (e.error && typeof e.error === "object") return extractErrorCode(e.error);
  }
  return null;
}

export type RegistrationPhase = 'init' | 'broadcasting' | 'confirming' | 'done' | 'error';

// Store-level references for cleanup on logout
let _onlineHandler: (() => void) | null = null;
let _offlineHandler: (() => void) | null = null;
let _appStateHandle: { remove: () => Promise<void> } | null = null;
let _blockHeightInterval: ReturnType<typeof setInterval> | null = null;

export const useAuthStore = defineStore(NAMESPACE, () => {
  const sessionManager = new SessionManager();
  const backgroundSyncManager = new BackgroundSyncManager();

  // Reactive session list + active account
  const sessions = ref<StoredSession[]>(sessionManager.getSessions());
  const activeAddress = ref<string | null>(sessionManager.getActiveAddress());

  // Current account credentials (derived from active session)
  const address = computed(() => {
    const s = activeAddress.value ? sessionManager.getSession(activeAddress.value) : null;
    return s?.address ?? null;
  });
  const privateKey = computed(() => {
    const s = activeAddress.value ? sessionManager.getSession(activeAddress.value) : null;
    return s?.privateKey ?? null;
  });

  // Multi-account computed helpers
  const isMultiAccount = computed(() => sessions.value.length > 1);
  const inactiveAccounts = computed(() =>
    sessions.value.filter(s => s.address !== activeAddress.value)
  );

  const appInitializer = createAppInitializer();
  const userInfo = ref<UserData>();

  // Registration state
  const regMnemonic = ref<string | null>(null);
  const regAddress = ref<string | null>(null);
  const regPrivateKeyHex = ref<string | null>(null);
  const regProxyId = ref<string | null>(null);
  const regCaptchaId = ref<string | null>(null);
  const regCaptchaDone = ref(false);

  // Post-registration: account pending blockchain confirmation (persisted in LS)
  const { setLSValue: setLSRegPending, value: LSRegPending } =
    useLocalStorage<boolean>("registration_pending", false);
  const registrationPending = ref(LSRegPending);
  let registrationPollTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending registration profile: stored until PKOIN arrives and UserInfo is broadcast
  type PendingRegProfile = { name: string; language: string; about: string; image?: string; encPublicKeys: string[] };
  const { setLSValue: setLSRegProfile, value: LSRegProfile } =
    useLocalStorage<PendingRegProfile | null>("registration_profile", null);
  const pendingRegProfile = ref(LSRegProfile);

  // Registration error: when UserInfo broadcast fails with code 18 (username taken/invalid)
  const registrationUsernameError = ref(false);

  // Generic registration error message: 'timeout' | 'network' | null
  const registrationErrorMessage = ref<string | null>(null);

  // Safety bounds for registration polling
  const REGISTRATION_POLL_TIMEOUT = 30 * 60 * 1000;  // 30 minutes total
  const RPC_CALL_TIMEOUT = 15_000;                    // 15s per RPC call
  const MAX_CONSECUTIVE_ERRORS = 5;                   // show error after 5 failures in a row

  // Node that processed the sendrawtransaction during registration —
  // used as fnode for getuserstate to avoid stale cache on a different node
  let registrationFnode: string | null = null;

  // Registration phase for stepper UI (persisted in LS for reload resilience)
  const { setLSValue: setLSRegPhase, value: LSRegPhase } =
    useLocalStorage<RegistrationPhase>('registration_phase', 'init');
  const registrationPhase = ref<RegistrationPhase>(LSRegPhase);

  const setRegistrationPhase = (phase: RegistrationPhase) => {
    registrationPhase.value = phase;
    setLSRegPhase(phase);
  };

  const setPendingRegProfile = (val: PendingRegProfile | null) => {
    pendingRegProfile.value = val;
    setLSRegProfile(val);
  };

  // Matrix-related state
  const matrixReady = ref(false);
  const matrixError = ref<string | null>(null);
  const matrixKit = shallowRef<MatrixKit | null>(null);
  const pcrypto = shallowRef<Pcrypto | null>(null);

  const isAuthenticated = computed(() => !!(address.value && privateKey.value));

  /** Sync reactive state from SessionManager (after any mutation) */
  const syncSessionsFromStorage = () => {
    sessions.value = sessionManager.getSessions();
    activeAddress.value = sessionManager.getActiveAddress();
  };

  /** Legacy compat setter — uses SessionManager internally */
  const setAuthData = (authData: AuthData) => {
    if (authData.address && authData.privateKey) {
      if (!sessionManager.getSession(authData.address)) {
        sessionManager.addSession(authData.address, authData.privateKey);
      }
      sessionManager.setActive(authData.address);
    }
    syncSessionsFromStorage();
  };

  const setUserInfo = (info: UserData) => {
    userInfo.value = info;
  };

  const { execute: editUserData, isLoading: isEditingUserData } =
    useAsyncOperation((userData: UserData) => {
      return appInitializer.editUserData({
        address: address.value!,
        userData: mergeObjects(userInfo.value!, userData)
      });
    });

  /** Initialize Matrix client, kit and crypto after login */
  const initMatrix = async () => {
    if (!address.value || !privateKey.value) {
      console.warn("[auth] initMatrix skipped: no credentials");
      matrixError.value = "No credentials";
      return;
    }

    matrixReady.value = false;
    matrixError.value = "Initializing...";

    try {
      if (typeof bitcoin === "undefined") {
        throw new Error("bitcoin global not found — SDK scripts may not have loaded");
      }

      const matrixService = getMatrixClientService();
      matrixError.value = "Deriving credentials...";

      // Step 3: Derive credentials
      const credentials = deriveMatrixCredentials(address.value, privateKey.value);
      matrixService.setCredentials(credentials);

      matrixError.value = "Creating MatrixKit...";
      matrixKit.value = new MatrixKit(matrixService);

      matrixError.value = "Generating encryption keys...";
      const encKeys = generateEncryptionKeys(privateKey.value);

      // Step 6: Init Pcrypto
      matrixError.value = "Initializing Pcrypto...";
      const cryptoInstance = new Pcrypto();
      const hexAddr = hexEncode(address.value);
      const cryptoUser: UserWithPrivateKeys = {
        userinfo: {
          id: hexAddr,
          keys: encKeys.map((k) => k.public),
        },
        private: encKeys,
      };
      cryptoInstance.init(cryptoUser);
      cryptoInstance.setHelpers({
        getUsersInfo: async (ids: string[]) => {
          // ids are hex-encoded addresses; decode to raw for Pocketnet API
          try {
            const rawAddresses = ids.map((id) => hexDecode(id));

            // Single SDK load (getuserprofile once per batch); raw rows stored pre-cleanData in SDK
            await appInitializer
              .loadUsersInfo(rawAddresses, { update: false })
              .catch((e) => {
                console.warn("[pcrypto] loadUsersInfo failed:", e);
              });

            const rawProfileMap = new Map<string, Record<string, unknown>>();
            for (const rawAddr of rawAddresses) {
              var p = appInitializer.getUserData(rawAddr);

              if (p && (p as any).address) {

                p = p.export(true)

                rawProfileMap.set((p as any).address, p);
              }
            }

            return ids.map((hexId, idx) => {
              const rawAddr = rawAddresses[idx];
              const sdkUser = appInitializer.getUserData(rawAddr);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let keys: string[] = (sdkUser as any)?.keys ?? [];
              const rawProfile = rawProfileMap.get(rawAddr);
              const sdkPath = keys.length > 0;

              // Fallback: if SDK keys empty (e.g. filterXSS error in cleanData),
              // extract keys directly from raw RPC response (k or keys field)
              if (keys.length === 0 && rawProfile) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const rawKeys = (rawProfile as any).k ?? (rawProfile as any).keys ?? "";
                if (Array.isArray(rawKeys)) {
                  keys = rawKeys.filter((k: string) => k);
                } else if (typeof rawKeys === "string" && rawKeys) {
                  keys = rawKeys.split(",").filter((k: string) => k);
                }
              }

              // Ensure source always has a numeric `id` field for deterministic
              // sort order in preparedUsers (must match lodash _.sortBy(u => u.source.id)
              // used by the old bastyon-chat client).
              // Priority: rawProfile (has Pocketnet numeric id) > sdkUser > empty.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const rawSource: Record<string, unknown> = rawProfile
                ? rawProfile
                : (sdkUser ? { ...(sdkUser as any), address: rawAddr } : { address: rawAddr });

              // If source still has no `id`, try to extract from SDK user data.
              // Without a numeric id the sort order diverges from the old client
              // (lodash _.sortBy places undefined at end; missing id would break ECDH).
              const source: Record<string, unknown> = rawSource;
              if (source.id == null && sdkUser && (sdkUser as any).id != null) {
                source.id = (sdkUser as any).id;
              }

              return { id: hexId, keys, source };
            });
          } catch (e) {
            console.error("[pcrypto] getUsersInfo error:", e);
            return ids.map((id) => ({ id, keys: [] as string[] }));
          }
        },
        isTetatetChat: (room: unknown) =>
          matrixKit.value?.isTetatetChat(room as Record<string, unknown>) ?? false,
        isChatPublic: (room: unknown) =>
          matrixKit.value?.chatIsPublic(room as Record<string, unknown>) ?? false,
        matrixId: (id: string) => matrixService.matrixId(id),
      });
      await withTimeout(cryptoInstance.prepare(address.value ?? undefined), 10_000, "Pcrypto storage init");
      pcrypto.value = cryptoInstance;

      // Step 7: Wire Matrix events → chat store
      matrixError.value = "Wiring events...";
      const chatStore = useChatStore();

      // Step 6.5: Initialize local-first database
      const chatDbKit = initChatDb(
        address.value!,
        async (roomId: string) => pcrypto.value?.rooms[roomId],
        undefined,
        async (url: string) => {
          const { fetchPreview } = await import("@/features/messaging/model/use-link-preview");
          return fetchPreview(url);
        },
      );
      chatStore.setChatDbKit(chatDbKit);

      // Wire SyncEngine connectivity (store refs for cleanup on logout)
      if (typeof window !== "undefined") {
        // Remove previous listeners if any (re-login without full page reload)
        if (_onlineHandler) window.removeEventListener("online", _onlineHandler);
        if (_offlineHandler) window.removeEventListener("offline", _offlineHandler);
        _onlineHandler = () => chatDbKit.syncEngine.setOnline(true);
        _offlineHandler = () => chatDbKit.syncEngine.setOnline(false);
        window.addEventListener("online", _onlineHandler);
        window.addEventListener("offline", _offlineHandler);
      }
      chatStore.setHelpers(matrixKit.value!, cryptoInstance);

      // Wire Pcrypto key-load → decryption retry
      if (cryptoInstance) {
        cryptoInstance.onKeysLoaded = (roomId: string) => {
          chatDbKit.retryRoomDecryption?.(roomId);
        };
      }

      let _lastSyncState: string | null = null;
      matrixService.setHandlers({
        onSync: (state) => {
          const wasDisconnected = _lastSyncState === "ERROR" || _lastSyncState === "RECONNECTING";
          _lastSyncState = state;

          if (state === "PREPARED" || state === "SYNCING") {
            chatStore.refreshRooms(state);
            // Save sync token for background polling
            if (address.value) {
              const token = matrixService.client?.getSyncToken?.() ?? "";
              if (token) sessionManager.updateSyncToken(address.value, token);
            }
            // Sync room names to native for push notification display
            if (isNative && state === "PREPARED") {
              import('@/shared/lib/push').then(({ pushService }) => {
                pushService.syncRoomNamesToNative();
                pushService.syncSenderNamesToNative();
              }).catch(() => {});
            }
            // After recovering from sync error — force full room refresh to catch missed events
            if (wasDisconnected && state === "SYNCING") {
              console.log("[auth] Sync recovered from disconnect — forcing full refresh");
              chatStore.refreshRooms("PREPARED");
            }
          } else if (state === "ERROR" || state === "RECONNECTING") {
            console.warn(`[auth] Sync state: ${state}`);
            chatStore.setSyncState(state);
          } else if (state === "STOPPED") {
            chatStore.setSyncState(state);
          }
          _onSyncStatusCallback?.(state);
        },
        onTimeline: (event: unknown, room: unknown) => {
          const roomId = typeof room === "string" ? room : (room as any)?.roomId;
          if (roomId) chatStore.markRoomChanged(roomId);
          // Skip event processing before initial sync completes — events will be
          // picked up by fullRoomRefresh reconciliation. Processing them early causes
          // Dexie writes → liveQuery notifications against an incomplete room list.
          if (roomId && chatStore.roomsInitialized) {
            chatStore.handleTimelineEvent(event, roomId);
          }
        },
        onMembership: (_event: unknown, member: unknown) => {
          const roomId = (member as any)?.roomId as string;
          if (roomId) chatStore.markRoomChanged(roomId);
          chatStore.refreshRooms();
        },
        onMyMembership: (_room: unknown, membership: string, prevMembership: string | undefined) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const roomId = (_room as any)?.roomId as string;
          if (roomId) chatStore.markRoomChanged(roomId);
          // Guard: skip tombstoning during initial sync — the SDK may emit
          // spurious join→leave transitions while loading rooms from its IndexedDB store.
          // Once roomsInitialized is true, we know the first fullRoomRefresh has completed.
          if (prevMembership === "join" && (membership === "leave" || membership === "ban")) {
            if (roomId && chatStore.roomsInitialized) {
              chatStore.handleKicked(roomId, membership === "ban" ? "banned" : "kicked");
            }
          }
          chatStore.refreshRooms();
        },
        onReceipt: (event: unknown, room: unknown) => {
          chatStore.handleReceiptEvent(event, room);
        },
        onRedaction: (event: unknown, room: unknown) => {
          chatStore.handleRedactionEvent(event, room);
        },
        onTyping: (_event: unknown, member: unknown) => {
          const m = member as Record<string, unknown>;
          const roomId = (m.roomId as string) ?? "";
          const userId = hexDecode(getmatrixid((m.userId as string) ?? ""));
          const isTyping = m.typing as boolean;
          if (!roomId) return;
          const current = chatStore.getTypingUsers(roomId);
          if (isTyping && !current.includes(userId)) {
            chatStore.setTypingUsers(roomId, [...current, userId]);
          } else if (!isTyping) {
            chatStore.setTypingUsers(roomId, current.filter((u) => u !== userId));
          }
        },
        onRoom: (room: unknown) => {
          const roomId = (room as any)?.roomId as string;
          if (roomId) chatStore.markRoomChanged(roomId);
        },
        onRoomAccountData: (event: unknown, room: unknown) => {
          chatStore.handleRoomAccountData(event, room);
        },
        onIncomingCall: (call: unknown) => {
          try {
            const callService = useCallService();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callService.handleIncomingCall(call as any);
          } catch (err) {
            console.error("[auth] Failed to handle incoming call:", err);
            try { (call as any).reject?.(); } catch { /* ignore */ }
          }
        },
        onEncryptionKeyArrived: (roomId: string) => {
          chatDbKit.retryRoomDecryption?.(roomId);
        },
      });
      // Route Matrix traffic through Tor reverse proxy on native platforms
      if (isNative) {
        const { torService } = await import('@/shared/lib/tor');
        if (torService.matrixBaseUrl) {
          matrixService.setTorProxyUrl(torService.matrixBaseUrl);
        }
      }

      matrixError.value = "Connecting to Matrix server...";
      bootStatus.setStep("matrix");
      await withTimeout(matrixService.init(), 45_000, "Matrix server connection");

      if (matrixService.isReady()) {
        bootStatus.setStep("sync");
        matrixReady.value = true;
        matrixError.value = null;

        // Cache connection info for background sync
        const client = matrixService.client;
        if (client && address.value) {
          const accessToken = client.getAccessToken?.() ?? "";
          const homeserverUrl = client.getHomeserverUrl?.() ?? "";
          if (accessToken && homeserverUrl) {
            sessionManager.updateConnectionInfo(address.value, accessToken, homeserverUrl);
          }
        }

        // Start background pollers for all inactive accounts
        for (const s of sessionManager.getSessions()) {
          if (s.address === activeAddress.value) continue;
          if (s.accessToken && s.homeserverUrl && s.syncToken) {
            backgroundSyncManager.demote({
              address: s.address,
              accessToken: s.accessToken,
              homeserverUrl: s.homeserverUrl,
              syncToken: s.syncToken,
            });
          }
        }

        // Fetch blockchain block height and update Pcrypto (critical for encryption key derivation).
        // In legacy code this was provided by the parent app via pcrypto.set.block().
        appInitializer.getBlockHeight().then((height) => {
          if (height > 0 && cryptoInstance) {
            cryptoInstance.setBlock({ height });
            console.log("[auth] Pcrypto block height set to", height);
          }
        }).catch((e) => console.warn("[auth] Failed to fetch block height:", e));

        // Periodically update block height (every 60s) — store ref for cleanup on logout
        if (_blockHeightInterval) clearInterval(_blockHeightInterval);
        _blockHeightInterval = setInterval(() => {
          if (!pcrypto.value) { clearInterval(_blockHeightInterval!); _blockHeightInterval = null; return; }
          appInitializer.getBlockHeight().then((height) => {
            if (height > 0) pcrypto.value!.setBlock({ height });
          }).catch(() => {});
        }, 60_000);

        import("@/features/video-calls/model/call-tab-lock").then(({ initCallTabLock }) => {
          initCallTabLock();
        }).catch((err) => {
          console.warn("[auth] Failed to init call tab lock:", err);
        });

        // Init push notifications FIRST (before call bridge which steals focus for audio permission)
        if (isNative && matrixService.client) {
          try {
            const { pushService } = await import('@/shared/lib/push');

            pushService.setActiveRoomGetter(() => chatStore.activeRoomId);

            // Wire optimistic room preview update from push notifications.
            // Uses chatDbKit.rooms (RoomRepository) which is already initialized above.
            // The monotonic guard inside optimisticUpdateFromPush prevents stale
            // push data from overwriting newer /sync data.
            pushService.setOptimisticRoomUpdater((roomId, preview, timestamp, senderId) =>
              chatDbKit.rooms.optimisticUpdateFromPush(roomId, preview, timestamp, senderId),
            );

            pushService.setRoomInfoGetter((roomId) => {
              // Use Dexie-backed store (has resolved names) instead of Matrix SDK (may return hash)
              const chatRoom = chatStore.rooms.find(r => r.id === roomId);
              if (chatRoom?.name) return { roomName: chatRoom.name };
              // Fallback to Matrix SDK
              const room = matrixService.client?.getRoom(roomId);
              if (!room) return null;
              return { roomName: room.name || 'Forta Chat' };
            });

            pushService.setAllRoomNamesGetter(() => {
              const map: Record<string, string> = {};
              for (const room of chatStore.rooms) {
                if (room.name) map[room.id] = room.name;
              }
              return map;
            });

            pushService.setAllSenderNamesGetter(() => {
              const senders: Record<string, string> = {};
              const client = matrixService.client;
              if (!client) return senders;
              for (const room of client.getRooms()) {
                for (const member of room.getJoinedMembers()) {
                  const userId = member.userId;
                  const name = member.name;
                  if (name && name !== userId && !senders[userId]) {
                    senders[userId] = name;
                  }
                }
              }
              return senders;
            });

            console.log('[auth] Initializing push service...');
            await pushService.init(matrixService.client);

            // Wire call handler after push init (needs nativeCallBridge)
            try {
              const { nativeCallBridge } = await import('@/shared/lib/native-calls');
              pushService.setCallHandler((data) => {
                nativeCallBridge.reportIncomingCall(data);
              });
            } catch (err) {
              console.warn("[auth] Failed to wire push call handler:", err);
            }
          } catch (err) {
            console.error("[auth] Failed to init push service:", err);
          }
        }

        // Wire native call bridge on Capacitor (isolated from push)
        if (isNative) {
          try {
            const { nativeCallBridge } = await import('@/shared/lib/native-calls');
            const callService = useCallService();
            await nativeCallBridge.wire(callService);
          } catch (err) {
            console.warn("[auth] Failed to init native call bridge:", err);
          }

          // Switch background sync interval when app goes to background
          // Guard: only register once (prevent leak on account switch → re-init)
          if (!_appStateHandle) {
            import("@capacitor/app").then(({ App: CapApp }) => {
              CapApp.addListener("appStateChange", ({ isActive }) => {
                backgroundSyncManager.setAppState(isActive);
              }).then(handle => { _appStateHandle = handle; }).catch(() => {});
            }).catch(() => {});
          }
        }

        // Note: rooms are loaded by the onSync("PREPARED") callback which
        // fires once the initial sync completes. Handlers are wired before
        // startClient(), so the event cannot be missed. Calling refreshRoomsNow()
        // here would run with 0 rooms (sync hasn't finished) and poison the
        // IndexedDB cache with an empty array.
      } else {
        console.error("[auth] Matrix client NOT ready, error:", matrixService.error);
        matrixError.value = matrixService.error || "Matrix init failed";
        if (bootStatus.state.value === 'booting') {
          bootStatus.setError(matrixError.value);
        }
      }
    } catch (e) {
      console.error("[auth] Matrix init error:", e);
      matrixError.value = String(e);
      if (bootStatus.state.value === 'booting') {
        bootStatus.setError(`Matrix initialization failed: ${matrixError.value}`);
      }
    }
  };

  const fetchUserInfo = async () => {
    if (!address.value || !privateKey.value) {
      return;
    }

    await appInitializer.initializeAndFetchUserData(
      address.value,
      (userData: UserData) => {
        setUserInfo(userData);
        PocketnetInstanceConfigurator.setUserAddress(address.value!);
        PocketnetInstanceConfigurator.setUserGetKeyPairFc(() =>
          createKeyPair(privateKey.value!)
        );
        // Sync own profile to userStore so Avatar components show correct name/initial
        if (userData.name) {
          useUserStore().setUser(address.value!, {
            address: address.value!,
            name: userData.name ?? "",
            about: userData.about ?? "",
            image: userData.image ?? "",
            site: userData.site ?? "",
            language: userData.language ?? "",
          });
        }
      }
    );
  };

  /** Verify user has 12 published encryption keys; re-publish if missing.
   *  Called on every login to catch users stuck in broken state.
   *  Uses SDK getuserprofile with update:true (not cache-only) to avoid false negatives.
   *  Skips if registration is already in progress (register() handles it). */
  const verifyAndRepublishKeys = async () => {
    if (!address.value || !privateKey.value) return;

    // Don't interfere with active registration — register() manages its own poll
    if (registrationPending.value || pendingRegProfile.value) {
      console.log("[auth] Key verification skipped — registration in progress");
      return;
    }

    // Step 1: Quick check via local SDK cache
    const userData = appInitializer.getUserData(address.value);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedKeys: string[] = (userData as any)?.keys ?? [];

    if (cachedKeys.length >= 12) {
      console.log("[auth] Key verification OK (cache):", cachedKeys.length, "keys");
      return;
    }

    // Step 2: Cache may be stale/empty after login — verify via fresh SDK profile load
    console.log("[auth] Cache shows", cachedKeys.length, "keys, verifying via RPC...");
    try {
      const rawProfiles = await appInitializer.loadUsersInfoRaw([address.value]);
      const rawProfile = rawProfiles[0];
      if (rawProfile) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawKeys = (rawProfile as any).k ?? (rawProfile as any).keys ?? "";
        let blockchainKeys: string[] = [];
        if (Array.isArray(rawKeys)) {
          blockchainKeys = rawKeys.filter((k: string) => k);
        } else if (typeof rawKeys === "string" && rawKeys) {
          blockchainKeys = rawKeys.split(",").filter((k: string) => k);
        }

        if (blockchainKeys.length >= 12) {
          console.log("[auth] Key verification OK (blockchain):", blockchainKeys.length, "keys");
          return;
        }
        console.warn("[auth] Blockchain confirms only", blockchainKeys.length, "keys. Re-publishing...");
      } else {
        console.warn("[auth] No profile found on blockchain. Re-publishing...");
      }
    } catch (e) {
      console.warn("[auth] RPC key check failed, skipping re-publish:", e);
      // Don't block login if RPC fails — keys might be fine, cache just didn't load
      return;
    }

    // Step 3: Keys genuinely missing — re-derive and re-publish
    const encKeys = generateEncryptionKeys(privateKey.value);
    const encPublicKeys = encKeys.map(k => k.public);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const name = (userData as any)?.name ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const language = (userData as any)?.language ?? "en";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const about = (userData as any)?.about ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const image = (userData as any)?.image ?? "";

    const hasUnspents = await appInitializer.checkUnspents(address.value);
    if (!hasUnspents) {
      console.warn("[auth] No PKOIN for key re-publish. Setting pending for poll.");
      setPendingRegProfile({ name, language, about, encPublicKeys, image });
      setRegistrationPending(true);
      startRegistrationPoll();
      return;
    }

    try {
      await appInitializer.syncNodeTime();
      const { registrationNode } = await appInitializer.registerUserProfile(address.value, { name, language, about }, encPublicKeys, image);
      registrationFnode = registrationNode;
      console.log("[auth] Key re-publish broadcast sent (fnode:", registrationFnode, "). Starting confirmation poll.");
      setRegistrationPending(true);
      startRegistrationPoll();
    } catch (e) {
      console.error("[auth] Key re-publish failed:", e);
      setPendingRegProfile({ name, language, about, encPublicKeys });
      setRegistrationPending(true);
      startRegistrationPoll();
    }
  };

  const { execute: login, isLoading: isLoggingIn } = useAsyncOperation(
    async (cryptoCredential: string) => {
      try {
        const keyPair = createKeyPair(cryptoCredential);
        const addr = getAddressFromPubKey(keyPair.publicKey);
        if (!addr) throw new Error("Failed to derive address");

        const authData: AuthData = {
          address: addr,
          privateKey: convertToHexString(keyPair.privateKey)
        };
        setAuthData(authData);
        await fetchUserInfo();

        // Verify encryption keys are published; re-publish if missing
        await verifyAndRepublishKeys();

        // Initialize Matrix after successful auth
        await initMatrix();

        // Bind per-account localStorage keys (pinned/muted rooms)
        if (address.value) {
          useChatStore().bindAccountKeys(address.value);
        }

        return { data: authData, error: null };
      } catch {
        return { data: null, error: "Invalid private key or mnemonic" };
      }
    }
  );

  const logout = async () => {
    const logoutAddress = activeAddress.value;

    // ── 0. Clear in-memory auth state ──
    userInfo.value = undefined;

    // ── 1. Reset Pinia stores (in-memory state) ──
    useChatStore().cleanup();
    useUserStore().cleanup();
    useCallStore().clearCall();
    useChannelStore().cleanup();

    // ── 2. Tear down Matrix (before async DB work to stop incoming events) ──
    resetMatrixClientService();
    matrixReady.value = false;
    matrixError.value = null;
    matrixKit.value = null;

    if (pcrypto.value) {
      for (const room of Object.values(pcrypto.value.rooms)) {
        room.destroy();
      }
      pcrypto.value = null;
    }

    // ── 3. Clean up window listeners & intervals ──
    if (typeof window !== "undefined") {
      if (_onlineHandler) { window.removeEventListener("online", _onlineHandler); _onlineHandler = null; }
      if (_offlineHandler) { window.removeEventListener("offline", _offlineHandler); _offlineHandler = null; }
    }
    if (_blockHeightInterval) { clearInterval(_blockHeightInterval); _blockHeightInterval = null; }

    // ── 4. Clear localStorage account data ──
    clearAllDrafts();
    clearQueue();
    clearAccountLocalStorage(logoutAddress ?? undefined);

    // ── 5. Delete Dexie local-first database (await to prevent race with re-login) ──
    await deleteChatDb().catch(() => {});

    // ── 6. Delete legacy IndexedDB cache ──
    deleteLegacyCache();

    // ── 7. Fire-and-forget cleanup ──
    import("@/features/video-calls/model/call-tab-lock").then(({ destroyCallTabLock }) => {
      destroyCallTabLock();
    }).catch(() => { /* ignore */ });

    import("@/features/messaging/model/use-file-download").then(({ revokeAllFileUrls }) => {
      revokeAllFileUrls();
    }).catch(() => { /* ignore */ });

    setRegistrationPending(false);
    setPendingRegProfile(null);
    stopRegistrationPoll();

    // ── 8. Stop all background pollers ──
    backgroundSyncManager.stopAll();

    // ── 9. Remove session from manager ──
    if (logoutAddress) {
      sessionManager.removeSession(logoutAddress);
    }
    syncSessionsFromStorage();
  };

  // ── Registration methods ──

  const generateRegistrationKeys = () => {
    const mnemonic = bitcoin.bip39.generateMnemonic();
    const keyPair = createKeyPair(mnemonic);
    const addr = getAddressFromPubKey(keyPair.publicKey);
    if (!addr) throw new Error("Failed to derive address from generated keys");

    regMnemonic.value = mnemonic;
    regAddress.value = addr;
    regPrivateKeyHex.value = convertToHexString(keyPair.privateKey);

    // Set user context so fetchauth can sign requests (required for captcha)
    PocketnetInstanceConfigurator.setUserAddress(addr);
    PocketnetInstanceConfigurator.setUserGetKeyPairFc(() => createKeyPair(mnemonic));
  };

  const findRegistrationProxy = async () => {
    const proxy = await appInitializer.getRegistrationProxy();
    if (!proxy) throw new Error("No registration proxy available");
    regProxyId.value = proxy.id;
    return proxy;
  };

  const fetchCaptcha = async () => {
    if (!regProxyId.value) throw new Error("No proxy selected");
    const result = await appInitializer.getCaptcha(regProxyId.value, regCaptchaId.value || undefined);
    if (!result) throw new Error("Failed to fetch captcha");
    regCaptchaId.value = result.id;
    regCaptchaDone.value = false;
    return result;
  };

  const submitCaptcha = async (text: string) => {
    if (!regProxyId.value || !regCaptchaId.value) throw new Error("No captcha in progress");
    const result = await appInitializer.solveCaptcha(regProxyId.value, regCaptchaId.value, text);
    if (!result || !result.done) {
      regCaptchaDone.value = false;
      throw new Error("Incorrect captcha solution");
    }
    regCaptchaDone.value = true;
    return result;
  };

  /** Check if a username is already taken on the blockchain.
   *  Returns the owning address if taken, null if available. */
  const checkUsername = async (name: string): Promise<string | null> => {
    return appInitializer.checkUsernameExists(name);
  };

  const register = async (profile: { name: string; language: string; about: string; image?: string }) => {
    if (!regAddress.value || !regCaptchaId.value || !regProxyId.value || !regMnemonic.value) {
      throw new Error("Registration state incomplete");
    }

    // 1. Request free registration PKOIN
    await appInitializer.requestFreeRegistration(regAddress.value, regCaptchaId.value, regProxyId.value);

    // 2. Generate encryption public keys (12 BIP32 keys) for chat encryption
    const encKeys = generateEncryptionKeys(regPrivateKeyHex.value!);
    const encPublicKeys = encKeys.map(k => k.public);

    // 3. Save profile for deferred broadcast (PKOIN hasn't arrived yet)
    setPendingRegProfile({ ...profile, encPublicKeys });

    // 4. Auto-login with the generated mnemonic (sets up SDK account + Matrix)
    const mnemonic = regMnemonic.value;
    clearRegistrationState();

    // Mark as pending — blockchain hasn't confirmed yet
    setRegistrationPending(true);
    setRegistrationPhase('init');

    const loginResult = await login(mnemonic);
    if (!loginResult?.data) {
      setRegistrationPending(false);
      setRegistrationPhase('init');
      throw new Error(loginResult?.error ?? 'Login failed after registration');
    }

    // 5. Start polling — will broadcast UserInfo when PKOIN arrives, then wait for confirmation
    startRegistrationPoll();
  };

  /** Retry registration with a new username after code 18 error.
   *  Re-uses existing PKOIN and encryption keys — only changes the display name. */
  const retryRegistrationWithNewName = async (newName: string) => {
    if (!address.value || !privateKey.value) throw new Error("Not authenticated");
    registrationUsernameError.value = false;

    // Re-derive encryption keys (same as original registration)
    const encKeys = generateEncryptionKeys(privateKey.value);
    const encPublicKeys = encKeys.map(k => k.public);

    // Re-build pending profile with new name
    const language = pendingRegProfile.value?.language ?? "en";
    const about = pendingRegProfile.value?.about ?? "";
    const image = pendingRegProfile.value?.image;

    setPendingRegProfile({ name: newName, language, about, image, encPublicKeys });
    setRegistrationPending(true);
    setRegistrationPhase('init');
    startRegistrationPoll();
  };

  const setRegistrationPending = (val: boolean) => {
    registrationPending.value = val;
    setLSRegPending(val);
  };

  /** Poll blockchain with exponential backoff. Two phases:
   *  Phase 1: Wait for PKOIN (unspents) to arrive, then broadcast UserInfo.
   *  Phase 2: Wait for UserInfo to be confirmed on-chain (getuserstate + Actions status).
   *  Safety bounds: 30-min total timeout, 15s per-RPC timeout, 5 consecutive errors → stop. */
  const startRegistrationPoll = () => {
    if (registrationPollTimer) clearTimeout(registrationPollTimer);
    let pollInterval = 3000;
    const MAX_POLL_INTERVAL = 60000;
    let attempt = 0;
    const pollStartedAt = Date.now();
    let consecutiveErrors = 0;
    console.log("[auth] Starting registration poll (phase:", pendingRegProfile.value ? "1-broadcast" : "2-confirm", ")");
    // Set initial phase based on current state (handles reload resume)
    if (pendingRegProfile.value) {
      if (registrationPhase.value !== 'init') setRegistrationPhase('init');
    } else {
      if (registrationPhase.value !== 'confirming') setRegistrationPhase('confirming');
    }

    const poll = async () => {
      if (!address.value) {
        stopRegistrationPoll();
        return;
      }

      // Total timeout check
      if (Date.now() - pollStartedAt > REGISTRATION_POLL_TIMEOUT) {
        console.error("[auth] Registration poll timed out after", REGISTRATION_POLL_TIMEOUT / 1000, "s");
        registrationErrorMessage.value = 'timeout';
        setRegistrationPhase('error');
        stopRegistrationPoll();
        return;
      }

      attempt++;
      try {
        // Phase 1: Broadcast UserInfo once PKOIN arrives
        if (pendingRegProfile.value) {
          const hasUnspents = await withTimeout(
            appInitializer.checkUnspents(address.value),
            RPC_CALL_TIMEOUT,
            "checkUnspents",
          );
          if (hasUnspents) {
            console.log("[auth] PKOIN received, broadcasting UserInfo...");
            setRegistrationPhase('broadcasting');
            try {
              await appInitializer.syncNodeTime();
              const { encPublicKeys, image, ...profile } = pendingRegProfile.value;
              await appInitializer.initializeAndFetchUserData(address.value);
              const { registrationNode } = await appInitializer.registerUserProfile(address.value, profile, encPublicKeys, image);
              registrationFnode = registrationNode;
              console.log("[auth] UserInfo broadcast requested, moving to phase 2 (fnode:", registrationFnode, ")");
              setRegistrationPhase('confirming');
              setPendingRegProfile(null);
              pollInterval = 3000;
              attempt = 0;
            } catch (broadcastErr: unknown) {
              // Check for error code 18 (username taken/invalid) — stop polling and surface error
              const errCode = extractErrorCode(broadcastErr);
              if (errCode === 18) {
                console.error("[auth] UserInfo broadcast rejected: username taken/invalid (code 18)");
                setRegistrationPhase('error');
                registrationUsernameError.value = true;
                setRegistrationPending(false);
                stopRegistrationPoll();
                return;
              }
              // Other broadcast errors — rethrow to be caught by outer catch and retried
              throw broadcastErr;
            }
          } else {
            console.log("[auth] Waiting for PKOIN... (attempt", attempt, ", next in", pollInterval / 1000, "s)");
          }
          consecutiveErrors = 0;
          schedulePoll();
          return;
        }

        // Phase 2: Wait for blockchain confirmation of UserInfo
        const actionsStatus = appInitializer.getAccountRegistrationStatus();
        console.log("[auth] Registration poll — actions:", actionsStatus, "(attempt", attempt, ")");

        if (actionsStatus === 'registered') {
          console.log("[auth] Registration confirmed via Actions system!");
          await onRegistrationConfirmed();
          return;
        }

        const confirmed = await withTimeout(
          appInitializer.checkUserRegistered(address.value, registrationFnode),
          RPC_CALL_TIMEOUT,
          "checkUserRegistered",
        );
        if (confirmed) {
          console.log("[auth] Registration confirmed on blockchain! (fnode:", registrationFnode, ")");
          await onRegistrationConfirmed();
          return;
        }

        consecutiveErrors = 0;
        console.log("[auth] Waiting for blockchain confirmation... (attempt", attempt, ", next in", pollInterval / 1000, "s)");
      } catch (e) {
        consecutiveErrors++;
        console.warn("[auth] Registration poll error (attempt", attempt, ", consecutive:", consecutiveErrors, "):", e);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error("[auth] Too many consecutive poll errors, showing error UI");
          registrationErrorMessage.value = 'network';
          setRegistrationPhase('error');
          stopRegistrationPoll();
          return;
        }
      }
      schedulePoll();
    };

    const schedulePoll = () => {
      registrationPollTimer = setTimeout(poll, pollInterval);
      pollInterval = Math.min(pollInterval * 2, MAX_POLL_INTERVAL);
    };

    poll();

    async function onRegistrationConfirmed() {
      setRegistrationPhase('done');
      // Keep overlay visible for 1.5s to show success step
      await new Promise(resolve => setTimeout(resolve, 1500));

      try {
        await appInitializer.initializeAndFetchUserData(
          address.value!,
          (data: UserData) => {
            setUserInfo(data);
            // Sync confirmed profile to userStore so Avatar/BottomTabBar update immediately
            useUserStore().setUser(address.value!, {
              address: address.value!,
              name: data.name ?? "",
              about: data.about ?? "",
              image: data.image ?? "",
              site: data.site ?? "",
              language: data.language ?? "",
            });
          }
        );
      } catch (e) {
        console.warn("[auth] initializeAndFetchUserData failed after confirmation, continuing:", e);
        // Non-fatal: user data will be fetched on next sync
      }

      // State cleanup ALWAYS runs, regardless of initializeAndFetchUserData outcome
      setRegistrationPending(false);
      setRegistrationPhase('init'); // Reset phase for clean localStorage state
      stopRegistrationPoll();

      if (!matrixReady.value) {
        PocketnetInstanceConfigurator.setUserAddress(address.value!);
        PocketnetInstanceConfigurator.setUserGetKeyPairFc(() =>
          createKeyPair(privateKey.value!)
        );
        try {
          await initMatrix();
        } catch (e) {
          console.warn("[auth] Matrix init failed after registration confirmation:", e);
          // Non-fatal: Matrix will retry on next app interaction or reload
        }
      }
    }
  };

  const stopRegistrationPoll = () => {
    if (registrationPollTimer) {
      clearTimeout(registrationPollTimer);
      registrationPollTimer = null;
    }
  };

  /** Retry registration after a timeout or network error.
   *  Clears error state and restarts the blockchain poll. */
  const retryRegistration = () => {
    registrationErrorMessage.value = null;
    registrationUsernameError.value = false;
    setRegistrationPhase('init');
    setRegistrationPending(true);
    startRegistrationPoll();
  };

  /** Resume polling on page reload if registration was pending.
   *  First verifies via blockchain RPC that keys are actually missing —
   *  registrationPending may be stale from a previous failed attempt. */
  const resumeRegistrationPoll = async () => {
    if (!registrationPending.value || registrationPollTimer) return;

    // Ensure POCKETNETINSTANCE has user address set
    if (address.value && privateKey.value) {
      PocketnetInstanceConfigurator.setUserAddress(address.value);
      PocketnetInstanceConfigurator.setUserGetKeyPairFc(() =>
        createKeyPair(privateKey.value!)
      );
    }

    // Before resuming poll, check if keys are already on blockchain
    // (registrationPending may be stale from a previous session)
    if (address.value) {
      try {
        const rawProfiles = await appInitializer.loadUsersInfoRaw([address.value]);
        const rawProfile = rawProfiles[0];
        if (rawProfile) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rawKeys = (rawProfile as any).k ?? (rawProfile as any).keys ?? "";
          let blockchainKeys: string[] = [];
          if (Array.isArray(rawKeys)) {
            blockchainKeys = rawKeys.filter((k: string) => k);
          } else if (typeof rawKeys === "string" && rawKeys) {
            blockchainKeys = rawKeys.split(",").filter((k: string) => k);
          }
          if (blockchainKeys.length >= 12) {
            console.log("[auth] resumeRegistrationPoll: keys already on blockchain (" + blockchainKeys.length + "), clearing pending state");
            setRegistrationPending(false);
            setPendingRegProfile(null);
            return;
          }
        }
      } catch (e) {
        console.warn("[auth] resumeRegistrationPoll: RPC check failed, resuming poll:", e);
      }
    }

    startRegistrationPoll();
  };

  const clearRegistrationState = () => {
    regMnemonic.value = null;
    regAddress.value = null;
    regPrivateKeyHex.value = null;
    regProxyId.value = null;
    regCaptchaId.value = null;
    regCaptchaDone.value = false;
    registrationFnode = null;
  };

  /** Load a Bastyon post by txid (delegates to AppInitializer RPC + cache) */
  const loadPost = (txid: string) => appInitializer.loadPost(txid);

  const loadPostScores = (txid: string) => appInitializer.loadPostScores(txid);
  const loadPostComments = (txid: string) => appInitializer.loadPostComments(txid, address.value || undefined);
  const loadMyPostScore = (txid: string) => appInitializer.loadMyPostScore(txid, address.value!);
  const submitUpvote = (txid: string, value: number) => appInitializer.submitUpvote(txid, value, address.value!);
  const submitComment = (txid: string, message: string, parentId?: string) => appInitializer.submitComment(txid, message, parentId, address.value || undefined);

  /** Get cached user data by raw address */
  const getBastyonUserData = (addr: string) => appInitializer.getUserData(addr);

  const getSubscribesChannels = (addr: string, blockNumber?: number, page?: number, pageSize?: number) =>
    appInitializer.getSubscribesChannels(addr, blockNumber, page, pageSize);

  const getCachedPost = (txid: string) => appInitializer.getCachedPost(txid);
  const cachePost = (raw: Record<string, unknown>) => appInitializer.cachePost(raw);

  const getProfileFeed = (authorAddress: string, options?: { height?: number; startTxid?: string; count?: number }) =>
    appInitializer.getProfileFeed(authorAddress, options);

  function setSyncStatusCallback(cb: (state: string) => void) {
    _onSyncStatusCallback = cb;
  }

  /** Add a new account (from AddAccountModal) */
  const addAccount = async (cryptoCredential: string): Promise<{ error: string | null }> => {
    try {
      const keyPair = createKeyPair(cryptoCredential);
      const addr = getAddressFromPubKey(keyPair.publicKey);
      if (!addr) return { error: "Failed to derive address" };

      if (sessionManager.getSession(addr)) {
        return { error: "Account already added" };
      }
      if (sessionManager.getSessions().length >= 5) {
        return { error: "Maximum 5 accounts allowed" };
      }

      const pk = convertToHexString(keyPair.privateKey);
      sessionManager.addSession(addr, pk);
      syncSessionsFromStorage();

      // Switch to the new account
      await switchAccount(addr);

      return { error: null };
    } catch {
      return { error: "Invalid private key or mnemonic" };
    }
  };

  /** Remove a specific account */
  const removeAccount = async (targetAddress: string) => {
    if (targetAddress === activeAddress.value) {
      await logout();
      return;
    }
    // Remove non-active account
    backgroundSyncManager.stop(targetAddress);
    sessionManager.removeSession(targetAddress);
    syncSessionsFromStorage();
  };

  let _switching = false;

  /** Hot-swap to a different account without page reload */
  const switchAccount = async (targetAddress: string) => {
    if (_switching || targetAddress === activeAddress.value) return;
    _switching = true;

    try {
      const targetSession = sessionManager.getSession(targetAddress);
      if (!targetSession) throw new Error("Session not found: " + targetAddress);

      // 1. DEMOTE current — save connection info for background polling
      const currentAddr = activeAddress.value;
      if (currentAddr && matrixReady.value) {
        const matrixService = getMatrixClientService();
        const client = matrixService.client;
        if (client) {
          const syncToken = client.getSyncToken?.() ?? "";
          const accessToken = client.getAccessToken?.() ?? "";
          const homeserverUrl = client.getHomeserverUrl?.() ?? "";
          // Cache connection info for background sync
          if (accessToken && homeserverUrl) {
            sessionManager.updateConnectionInfo(currentAddr, accessToken, homeserverUrl);
          }
          if (syncToken) {
            sessionManager.updateSyncToken(currentAddr, syncToken);
          }
        }

        // Start lightweight poller for the account being demoted
        const savedSession = sessionManager.getSession(currentAddr);
        if (savedSession?.accessToken && savedSession?.homeserverUrl && savedSession?.syncToken) {
          backgroundSyncManager.demote({
            address: currentAddr,
            accessToken: savedSession.accessToken,
            homeserverUrl: savedSession.homeserverUrl,
            syncToken: savedSession.syncToken,
          });
        }
      }

      // 2. CLEANUP current context (no data deletion)
      useChatStore().cleanup();
      useChannelStore().cleanup();
      useCallStore().clearCall();
      resetMatrixClientService();
      matrixReady.value = false;
      matrixError.value = null;
      matrixKit.value = null;

      if (pcrypto.value) {
        for (const room of Object.values(pcrypto.value.rooms)) {
          room.destroy();
        }
        pcrypto.value = null;
      }

      // Cleanup listeners
      if (typeof window !== "undefined") {
        if (_onlineHandler) { window.removeEventListener("online", _onlineHandler); _onlineHandler = null; }
        if (_offlineHandler) { window.removeEventListener("offline", _offlineHandler); _offlineHandler = null; }
      }
      if (_blockHeightInterval) { clearInterval(_blockHeightInterval); _blockHeightInterval = null; }

      // Close Dexie without deleting
      closeChatDb();

      // 3. SWAP active account
      sessionManager.setActive(targetAddress);
      syncSessionsFromStorage();
      userInfo.value = undefined;

      // 4. INIT new context (reuses the existing initMatrix which reads from computed address/privateKey)
      await fetchUserInfo();
      await initMatrix();

      // 5. Bind per-account localStorage keys (pinned/muted rooms)
      useChatStore().bindAccountKeys(targetAddress);

      // Stop lightweight poller for the newly active account
      backgroundSyncManager.promote(targetAddress);

    } catch (e) {
      console.error("[auth] switchAccount failed:", e);
      matrixError.value = String(e);
    } finally {
      _switching = false;
    }
  };

  return {
    address,
    activeAddress,
    sessions,
    isMultiAccount,
    inactiveAccounts,
    addAccount,
    removeAccount,
    switchAccount,
    /** Get unread count for a background account */
    getBackgroundUnreadCount: (addr: string) => backgroundSyncManager.getUnreadCount(addr),
    clearRegistrationState,
    editUserData,
    fetchCaptcha,
    fetchUserInfo,
    findRegistrationProxy,
    generateRegistrationKeys,
    cachePost,
    getCachedPost,
    getBastyonUserData,
    getProfileFeed,
    getSubscribesChannels,
    initMatrix,
    isAuthenticated,
    isEditingUserData,
    isLoggingIn,
    loadMyPostScore,
    loadPost,
    loadPostComments,
    loadPostScores,
    loadUsersInfo: (addresses: string[], options?: { update?: boolean }) =>
      appInitializer.loadUsersInfo(addresses, options),
    login,
    logout,
    matrixError,
    matrixKit,
    matrixReady,
    pcrypto,
    privateKey,
    regAddress,
    regCaptchaDone,
    regMnemonic,
    regProxyId,
    checkUsername,
    register,
    registrationErrorMessage,
    registrationPending,
    registrationPhase,
    registrationUsernameError,
    resumeRegistrationPoll,
    retryRegistration,
    retryRegistrationWithNewName,
    setSyncStatusCallback,
    submitCaptcha,
    submitComment,
    submitUpvote,
    userInfo
  };
});
