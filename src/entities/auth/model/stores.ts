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
import { initChatDb, deleteChatDb } from "@/shared/lib/local-db";
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

// Store-level references for cleanup on logout
let _onlineHandler: (() => void) | null = null;
let _offlineHandler: (() => void) | null = null;
let _blockHeightInterval: ReturnType<typeof setInterval> | null = null;

export const useAuthStore = defineStore(NAMESPACE, () => {
  const { setLSValue: setLSAuthData, value: LSAuthData } =
    useLocalStorage<AuthData>(NAMESPACE, { address: null, privateKey: null });

  const appInitializer = createAppInitializer();

  const address = ref(LSAuthData.address);
  const privateKey = ref(LSAuthData.privateKey);
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

  const setAuthData = (authData: AuthData) => {
    address.value = authData.address;
    privateKey.value = authData.privateKey;
    setLSAuthData(authData);
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

            // Load SDK profiles and raw profiles in PARALLEL
            const [, rawProfiles] = await Promise.all([
              appInitializer.loadUsersInfo(rawAddresses).catch((e) => { console.warn("[pcrypto] loadUsersInfo failed:", e); }),
              appInitializer.loadUsersInfoRaw(rawAddresses).catch(() => [] as Record<string, unknown>[]),
            ]);

            // Build lookup map for raw profiles (O(1) instead of O(n) per user)
            const rawProfileMap = new Map<string, Record<string, unknown>>();
            for (const p of rawProfiles) {
              if (p && (p as any).address) {
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

              // Ensure source always has an id field for deterministic sort order.
              // Fallback to SDK user data if rawProfile is missing.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const source: Record<string, unknown> = rawProfile
                ? rawProfile
                : (sdkUser ? { ...(sdkUser as any), address: rawAddr } : { address: rawAddr });

              console.error("[getUsersInfo] id=" + hexId.slice(0,10) + " sdkPath=" + sdkPath + " sdkKeys=" + ((sdkUser as any)?.keys?.length ?? 0) + " finalKeys=" + keys.length + " k0=" + (keys[0]?.slice(0,10) ?? "none") + " sdkUser=" + (sdkUser ? "yes" : "no") + " sourceId=" + ((source as any)?.id ?? "none"));

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
      await withTimeout(cryptoInstance.prepare(), 10_000, "Pcrypto storage init");
      pcrypto.value = cryptoInstance;

      // Step 7: Wire Matrix events → chat store
      matrixError.value = "Wiring events...";
      const chatStore = useChatStore();

      // Step 6.5: Initialize local-first database
      const chatDbKit = initChatDb(
        LSAuthData.address!,
        async (roomId: string) => pcrypto.value?.rooms[roomId],
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

      matrixService.setHandlers({
        onSync: (state) => {
          if (state === "PREPARED" || state === "SYNCING") {
            chatStore.refreshRooms(state);
            // Sync room names to native for push notification display
            if (isNative && state === "PREPARED") {
              import('@/shared/lib/push').then(({ pushService }) => {
                pushService.syncRoomNamesToNative();
              }).catch(() => {});
            }
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
        }

        // Note: rooms are loaded by the onSync("PREPARED") callback which
        // fires once the initial sync completes. Handlers are wired before
        // startClient(), so the event cannot be missed. Calling refreshRoomsNow()
        // here would run with 0 rooms (sync hasn't finished) and poison the
        // IndexedDB cache with an empty array.
      } else {
        console.error("[auth] Matrix client NOT ready, error:", matrixService.error);
        matrixError.value = matrixService.error || "Matrix init failed";
      }
    } catch (e) {
      console.error("[auth] Matrix init error:", e);
      matrixError.value = String(e);
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
      }
    );
  };

  /** Verify user has 12 published encryption keys; re-publish if missing.
   *  Called on every login to catch users stuck in broken state. */
  const verifyAndRepublishKeys = async () => {
    if (!address.value || !privateKey.value) return;

    const userData = appInitializer.getUserData(address.value);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const publishedKeys: string[] = (userData as any)?.keys ?? [];

    if (publishedKeys.length >= 12) {
      console.log("[auth] Key verification OK:", publishedKeys.length, "keys published");
      return;
    }

    console.warn("[auth] Key verification FAILED: only", publishedKeys.length, "keys published. Re-publishing...");

    // Re-derive the 12 encryption keys from private key
    const encKeys = generateEncryptionKeys(privateKey.value);
    const encPublicKeys = encKeys.map(k => k.public);

    // Check if user has PKOIN for transaction
    const hasUnspents = await appInitializer.checkUnspents(address.value);
    if (!hasUnspents) {
      console.warn("[auth] No PKOIN for key re-publish. Setting pending profile for poll.");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const name = (userData as any)?.name ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const language = (userData as any)?.language ?? "en";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const about = (userData as any)?.about ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const image = (userData as any)?.image ?? "";
      setPendingRegProfile({ name, language, about, encPublicKeys, image });
      setRegistrationPending(true);
      startRegistrationPoll();
      return;
    }

    // Has PKOIN — publish immediately
    try {
      await appInitializer.syncNodeTime();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const name = (userData as any)?.name ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const language = (userData as any)?.language ?? "en";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const about = (userData as any)?.about ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const image = (userData as any)?.image ?? "";
      await appInitializer.registerUserProfile(
        address.value,
        { name, language, about },
        encPublicKeys,
        image
      );
      console.log("[auth] Key re-publish broadcast sent. Starting confirmation poll.");
      setRegistrationPending(true);
      startRegistrationPoll();
    } catch (e) {
      console.error("[auth] Key re-publish failed:", e);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const name = (userData as any)?.name ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const language = (userData as any)?.language ?? "en";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const about = (userData as any)?.about ?? "";
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

        return { data: authData, error: null };
      } catch {
        return { data: null, error: "Invalid private key or mnemonic" };
      }
    }
  );

  const logout = async () => {
    // ── Clean up all account data ──

    // 1. Reset Pinia stores (in-memory state)
    useChatStore().cleanup();
    useUserStore().cleanup();
    useCallStore().clearCall();
    useChannelStore().cleanup();

    // 2. Delete Dexie local-first database (await to prevent race with re-login)
    await deleteChatDb().catch(() => {});

    // 3. Clear localStorage account data
    clearAllDrafts();
    clearQueue();
    clearAccountLocalStorage();

    // 4. Delete legacy IndexedDB cache
    deleteLegacyCache();

    // Destroy cross-tab call lock
    import("@/features/video-calls/model/call-tab-lock").then(({ destroyCallTabLock }) => {
      destroyCallTabLock();
    }).catch(() => { /* ignore */ });

    // Revoke cached blob URLs from file downloads
    import("@/features/messaging/model/use-file-download").then(({ revokeAllFileUrls }) => {
      revokeAllFileUrls();
    }).catch(() => { /* ignore */ });

    // Clean up window online/offline listeners
    if (typeof window !== "undefined") {
      if (_onlineHandler) { window.removeEventListener("online", _onlineHandler); _onlineHandler = null; }
      if (_offlineHandler) { window.removeEventListener("offline", _offlineHandler); _offlineHandler = null; }
    }

    // Clear block height polling interval
    if (_blockHeightInterval) { clearInterval(_blockHeightInterval); _blockHeightInterval = null; }

    // Tear down Matrix
    resetMatrixClientService();
    matrixReady.value = false;
    matrixError.value = null;
    matrixKit.value = null;

    if (pcrypto.value) {
      // Destroy all room crypto instances
      for (const room of Object.values(pcrypto.value.rooms)) {
        room.destroy();
      }
      pcrypto.value = null;
    }

    setAuthData({ address: null, privateKey: null });
    userInfo.value = undefined;
    setRegistrationPending(false);
    setPendingRegProfile(null);
    stopRegistrationPoll();
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

    await login(mnemonic);

    // 5. Start polling — will broadcast UserInfo when PKOIN arrives, then wait for confirmation
    startRegistrationPoll();
  };

  const setRegistrationPending = (val: boolean) => {
    registrationPending.value = val;
    setLSRegPending(val);
  };

  /** Poll blockchain with exponential backoff. Two phases:
   *  Phase 1: Wait for PKOIN (unspents) to arrive, then broadcast UserInfo.
   *  Phase 2: Wait for UserInfo to be confirmed on-chain (getuserstate + Actions status).
   *  NO TIMEOUT — polls indefinitely until confirmed or user logs out. */
  const startRegistrationPoll = () => {
    if (registrationPollTimer) clearTimeout(registrationPollTimer);
    let pollInterval = 3000;
    const MAX_POLL_INTERVAL = 60000;
    let attempt = 0;
    console.log("[auth] Starting registration poll (phase:", pendingRegProfile.value ? "1-broadcast" : "2-confirm", ")");

    const poll = async () => {
      if (!address.value) {
        stopRegistrationPoll();
        return;
      }
      attempt++;
      try {
        // Phase 1: Broadcast UserInfo once PKOIN arrives
        if (pendingRegProfile.value) {
          const hasUnspents = await appInitializer.checkUnspents(address.value);
          if (hasUnspents) {
            console.log("[auth] PKOIN received, broadcasting UserInfo...");
            await appInitializer.syncNodeTime();
            const { encPublicKeys, image, ...profile } = pendingRegProfile.value;
            await appInitializer.initializeAndFetchUserData(address.value);
            await appInitializer.registerUserProfile(address.value, profile, encPublicKeys, image);
            console.log("[auth] UserInfo broadcast requested, moving to phase 2");
            setPendingRegProfile(null);
            pollInterval = 3000;
            attempt = 0;
          } else {
            console.log("[auth] Waiting for PKOIN... (attempt", attempt, ", next in", pollInterval / 1000, "s)");
          }
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

        const confirmed = await appInitializer.checkUserRegistered(address.value);
        if (confirmed) {
          console.log("[auth] Registration confirmed on blockchain!");
          await onRegistrationConfirmed();
          return;
        }

        console.log("[auth] Waiting for blockchain confirmation... (attempt", attempt, ", next in", pollInterval / 1000, "s)");
      } catch (e) {
        console.warn("[auth] Registration poll error (attempt", attempt, "):", e);
      }
      schedulePoll();
    };

    const schedulePoll = () => {
      registrationPollTimer = setTimeout(poll, pollInterval);
      pollInterval = Math.min(pollInterval * 2, MAX_POLL_INTERVAL);
    };

    poll();

    async function onRegistrationConfirmed() {
      await appInitializer.initializeAndFetchUserData(
        address.value!,
        (data: UserData) => setUserInfo(data)
      );
      setRegistrationPending(false);
      stopRegistrationPoll();
      if (!matrixReady.value) {
        PocketnetInstanceConfigurator.setUserAddress(address.value!);
        PocketnetInstanceConfigurator.setUserGetKeyPairFc(() =>
          createKeyPair(privateKey.value!)
        );
        await initMatrix();
      }
    }
  };

  const stopRegistrationPoll = () => {
    if (registrationPollTimer) {
      clearTimeout(registrationPollTimer);
      registrationPollTimer = null;
    }
  };

  /** Resume polling on page reload if registration was pending */
  const resumeRegistrationPoll = () => {
    if (registrationPending.value && !registrationPollTimer) {
      // Ensure POCKETNETINSTANCE has user address set (might not be if fetchUserInfo failed)
      if (address.value && privateKey.value) {
        PocketnetInstanceConfigurator.setUserAddress(address.value);
        PocketnetInstanceConfigurator.setUserGetKeyPairFc(() =>
          createKeyPair(privateKey.value!)
        );
      }
      startRegistrationPoll();
    }
  };

  const clearRegistrationState = () => {
    regMnemonic.value = null;
    regAddress.value = null;
    regPrivateKeyHex.value = null;
    regProxyId.value = null;
    regCaptchaId.value = null;
    regCaptchaDone.value = false;
  };

  /** Load a Bastyon post by txid (delegates to AppInitializer RPC + cache) */
  const loadPost = (txid: string) => appInitializer.loadPost(txid);

  const loadPostScores = (txid: string) => appInitializer.loadPostScores(txid);
  const loadPostComments = (txid: string) => appInitializer.loadPostComments(txid, address.value || undefined);
  const loadMyPostScore = (txid: string) => appInitializer.loadMyPostScore(txid, address.value!);
  const submitUpvote = (txid: string, value: number) => appInitializer.submitUpvote(txid, value, address.value!);
  const submitComment = (txid: string, message: string, parentId?: string) => appInitializer.submitComment(txid, message, parentId);

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

  return {
    address,
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
    loadUsersInfo: (addresses: string[]) => appInitializer.loadUsersInfo(addresses),
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
    register,
    registrationPending,
    resumeRegistrationPoll,
    setSyncStatusCallback,
    submitCaptcha,
    submitComment,
    submitUpvote,
    userInfo
  };
});
