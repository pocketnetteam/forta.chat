import {
  createAppInitializer,
  PocketnetInstanceConfigurator
} from "@/app/providers";
import { useChatStore } from "@/entities/chat";
import {
  getMatrixClientService,
  resetMatrixClientService,
  MatrixKit,
  Pcrypto,
} from "@/entities/matrix";
import type { UserWithPrivateKeys } from "@/entities/matrix/model/matrix-crypto";
import { getmatrixid } from "@/shared/lib/matrix/functions";
import { useLocalStorage } from "@/shared/lib/browser";
import { convertToHexString } from "@/shared/lib/convert-to-hex-string";
import { mergeObjects } from "@/shared/lib/merge-objects";
import { useAsyncOperation } from "@/shared/use";
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

export const useAuthStore = defineStore(NAMESPACE, () => {
  const { setLSValue: setLSAuthData, value: LSAuthData } =
    useLocalStorage<AuthData>(NAMESPACE, { address: null, privateKey: null });

  const appInitializer = createAppInitializer();

  const address = ref(LSAuthData.address);
  const privateKey = ref(LSAuthData.privateKey);
  const userInfo = ref<UserData>();

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

    console.log("[auth] initMatrix starting for", address.value);
    matrixReady.value = false;
    matrixError.value = "Initializing...";

    try {
      // Step 1: Check bitcoin global
      if (typeof bitcoin === "undefined") {
        throw new Error("bitcoin global not found — SDK scripts may not have loaded");
      }
      console.log("[auth] Step 1: bitcoin global OK");

      // Step 2: Get matrix service
      const matrixService = getMatrixClientService();
      matrixError.value = "Deriving credentials...";

      // Step 3: Derive credentials
      const credentials = deriveMatrixCredentials(address.value, privateKey.value);
      console.log("[auth] Step 3: credentials derived, user=%s", credentials.username);
      matrixService.setCredentials(credentials);

      // Step 4: Initialize MatrixKit
      matrixError.value = "Creating MatrixKit...";
      matrixKit.value = new MatrixKit(matrixService);
      console.log("[auth] Step 4: MatrixKit created");

      // Step 5: Generate encryption keys
      matrixError.value = "Generating encryption keys...";
      const encKeys = generateEncryptionKeys(privateKey.value);
      console.log("[auth] Step 5: %d encryption keys generated", encKeys.length);

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
              appInitializer.loadUsersInfo(rawAddresses),
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

              console.error("[getUsersInfo] id=" + hexId.slice(0,10) + " sdkPath=" + sdkPath + " sdkKeys=" + ((sdkUser as any)?.keys?.length ?? 0) + " finalKeys=" + keys.length + " k0=" + (keys[0]?.slice(0,10) ?? "none") + " sdkUser=" + (sdkUser ? "yes" : "no"));

              return { id: hexId, keys, source: rawProfile };
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
      await cryptoInstance.prepare();
      pcrypto.value = cryptoInstance;
      console.log("[auth] Step 6: Pcrypto initialized (hexAddr=%s)", hexAddr);

      // Step 7: Wire Matrix events → chat store
      matrixError.value = "Wiring events...";
      const chatStore = useChatStore();
      chatStore.setHelpers(matrixKit.value!, cryptoInstance);

      matrixService.setHandlers({
        onSync: (state) => {
          chatStore.refreshRooms(state);
        },
        onTimeline: (event: unknown, room: unknown) => {
          const roomId = typeof room === "string" ? room : (room as any)?.roomId;
          if (roomId) chatStore.markRoomChanged(roomId);
          if (roomId) chatStore.handleTimelineEvent(event, roomId);
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
          // When kicked/banned from a room, remove it immediately from the UI
          if (prevMembership === "join" && (membership === "leave" || membership === "ban")) {
            if (roomId) {
              console.log("[auth] myMembership: kicked from room", roomId);
              chatStore.handleKicked(roomId);
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
        onIncomingCall: (call: unknown) => {
          import("@/features/video-calls/model/call-service").then(({ useCallService }) => {
            const callService = useCallService();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callService.handleIncomingCall(call as any);
          }).catch((err) => {
            console.error("[auth] Failed to load call-service:", err);
            try { (call as any).reject?.(); } catch { /* ignore */ }
          });
        },
      });
      console.log("[auth] Step 7: events wired");

      // Step 8: Start the Matrix client (login + sync)
      matrixError.value = "Connecting to Matrix server...";
      console.log("[auth] Step 8: Starting Matrix client...");
      await matrixService.init();

      if (matrixService.isReady()) {
        console.log("[auth] Matrix client ready!");
        matrixReady.value = true;
        matrixError.value = null;

        // Init cross-tab call lock
        import("@/features/video-calls/model/call-tab-lock").then(({ initCallTabLock }) => {
          initCallTabLock();
          console.log("[auth] Call tab lock initialized");
        }).catch((err) => {
          console.warn("[auth] Failed to init call tab lock:", err);
        });

        // Explicitly load rooms immediately — the onSync callback may have
        // already fired before handlers were wired.
        chatStore.refreshRoomsNow();
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
      console.log("[auth] fetchUserInfo skipped: no credentials");
      return;
    }
    console.log("[auth] fetchUserInfo starting for", address.value);

    await appInitializer.initializeAndFetchUserData(
      address.value,
      (userData: UserData) => {
        console.log("[auth] fetchUserInfo: user data received", userData?.name);
        setUserInfo(userData);
        PocketnetInstanceConfigurator.setUserAddress(address.value!);
        PocketnetInstanceConfigurator.setUserGetKeyPairFc(() =>
          createKeyPair(privateKey.value!)
        );
      }
    );
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

        // Initialize Matrix after successful auth
        await initMatrix();

        return { data: authData, error: null };
      } catch {
        return { data: null, error: "Invalid private key or mnemonic" };
      }
    }
  );

  const logout = () => {
    // Destroy cross-tab call lock
    import("@/features/video-calls/model/call-tab-lock").then(({ destroyCallTabLock }) => {
      destroyCallTabLock();
    }).catch(() => { /* ignore */ });

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
  };

  /** Load a Bastyon post by txid (delegates to AppInitializer RPC + cache) */
  const loadPost = (txid: string) => appInitializer.loadPost(txid);

  /** Get cached user data by raw address */
  const getBastyonUserData = (addr: string) => appInitializer.getUserData(addr);

  return {
    address,
    editUserData,
    fetchUserInfo,
    getBastyonUserData,
    initMatrix,
    isAuthenticated,
    isEditingUserData,
    isLoggingIn,
    loadPost,
    loadUsersInfo: (addresses: string[]) => appInitializer.loadUsersInfo(addresses),
    login,
    logout,
    matrixError,
    matrixKit,
    matrixReady,
    pcrypto,
    privateKey,
    userInfo
  };
});
