# Reliable Registration & Crypto Keys Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Guarantee every user has published Pocketnet encryption keys before entering chat; gracefully handle peers without keys.

**Architecture:** Three-layer fix: (1) registration poll without timeout + login-time key verification, (2) `canBeEncrypt()` checks peer keys so encryption only happens when both sides are ready, (3) UI shows clear status when peer lacks keys. No new modules — surgical changes to existing files.

**Tech Stack:** Vue 3 + Pinia + TypeScript, Pcrypto (secp256k1 ECDH + AES-SIV), Pocketnet SDK (blockchain UserInfo transactions)

---

## Context for Implementor

### The Problem

Pcrypto E2E encryption requires **both** chat participants to have 12 published secp256k1 public keys in the Pocketnet blockchain. The function `preparedUsers()` in `matrix-crypto.ts:288-291` filters out any user with `keys.length < 12`. If a user has 0 keys:

- **Encryption:** `encryptEvent()` encrypts for an incomplete user set → peer can't decrypt
- **Decryption:** `decryptEvent()` can't find `body[myId]` → throws → message shows as `[encrypted]`

Three root causes create keyless users:
1. Registration poll has 5-minute timeout (`stores.ts:665`) → dies before UserInfo publishes
2. No key check on regular login → broken state persists forever
3. `canBeEncrypt()` (`matrix-crypto.ts:633-641`) checks `usersinfo.length > 1` but NOT whether all users have 12 keys

### Key Files

| File | Lines | Role |
|------|-------|------|
| `src/entities/auth/model/stores.ts` | 662-743 | Registration poll, login flow |
| `src/entities/matrix/model/matrix-crypto.ts` | 288-291, 633-641, 650-678 | Key filtering, encryption gate |
| `src/entities/chat/model/chat-store.ts` | 3174-3182, 4490-4501 | Decrypt error handling |
| `src/features/messaging/model/use-messages.ts` | 106-141 | Send path (`canBeEncrypt` check) |
| `src/features/messaging/ui/MessageInput.vue` | 140, 598-600 | Send button UI |
| `src/widgets/chat-window/ChatWindow.vue` | — | Chat window (warning banner) |

### Existing Plaintext Fallback

`use-messages.ts:108-141` already has a plaintext path when `canBeEncrypt()` returns `false`. Our fix leverages this: make `canBeEncrypt()` correctly return `false` when peers lack keys → existing plaintext path activates → no crash.

---

## Task 1: Remove registration poll timeout

**Files:**
- Modify: `src/entities/auth/model/stores.ts:662-724`

**Step 1: Write the failing test**

Create test file:
- Create: `src/entities/auth/model/__tests__/registration-poll.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the poll logic indirectly by checking behavior:
// 1. Poll should NOT stop after 5 minutes
// 2. Poll should use exponential backoff
// 3. Poll should survive and keep retrying

describe("registration poll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should not have a hardcoded 5-minute timeout constant", async () => {
    // Read the source file and verify MAX_WAIT_MS is removed
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../stores.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8"
    );
    expect(source).not.toContain("MAX_WAIT_MS");
    expect(source).not.toContain("5 * 60 * 1000");
    expect(source).not.toContain("5 minutes fallback");
  });

  it("should use exponential backoff with max 60s cap", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../stores.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8"
    );
    // Verify backoff logic exists
    expect(source).toContain("pollInterval");
    expect(source).toContain("Math.min");
    expect(source).toContain("60000"); // 60s max
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/entities/auth/model/__tests__/registration-poll.test.ts`
Expected: FAIL — MAX_WAIT_MS still exists, no backoff logic

**Step 3: Implement — replace fixed interval + timeout with exponential backoff**

In `src/entities/auth/model/stores.ts`, replace `startRegistrationPoll` (lines 662-724):

```typescript
  /** Poll blockchain with exponential backoff. Two phases:
   *  Phase 1: Wait for PKOIN (unspents) to arrive, then broadcast UserInfo.
   *  Phase 2: Wait for UserInfo to be confirmed on-chain (getuserstate + Actions status).
   *  NO TIMEOUT — polls indefinitely until confirmed or user logs out. */
  const startRegistrationPoll = () => {
    if (registrationPollTimer) clearTimeout(registrationPollTimer as ReturnType<typeof setTimeout>);
    let pollInterval = 3000; // Start at 3s
    const MAX_POLL_INTERVAL = 60000; // Cap at 60s
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

            // Re-initialize SDK account so it sees the new unspents
            await appInitializer.initializeAndFetchUserData(address.value);

            await appInitializer.registerUserProfile(address.value, profile, encPublicKeys, image);
            console.log("[auth] UserInfo broadcast requested, moving to phase 2");
            setPendingRegProfile(null);
            // Reset backoff for phase 2
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
      registrationPollTimer = setTimeout(poll, pollInterval) as unknown as ReturnType<typeof setInterval>;
      // Exponential backoff: 3s → 6s → 12s → 24s → 48s → 60s (capped)
      pollInterval = Math.min(pollInterval * 2, MAX_POLL_INTERVAL);
    };

    // Start first poll immediately
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
      clearTimeout(registrationPollTimer as ReturnType<typeof setTimeout>);
      registrationPollTimer = null;
    }
  };
```

Also update the `registrationPollTimer` type declaration at line 128:

```typescript
  let registrationPollTimer: ReturnType<typeof setTimeout> | null = null;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/entities/auth/model/__tests__/registration-poll.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/entities/auth/model/stores.ts src/entities/auth/model/__tests__/registration-poll.test.ts
git commit -m "fix: remove 5-minute registration poll timeout, use exponential backoff"
```

---

## Task 2: Add login-time key verification and re-publish

**Files:**
- Modify: `src/entities/auth/model/stores.ts:498-519` (login function)
- Test: `src/entities/auth/model/__tests__/registration-poll.test.ts` (extend)

**Step 1: Write the failing test**

Add to `registration-poll.test.ts`:

```typescript
describe("login key verification", () => {
  it("source code should contain verifyAndRepublishKeys function", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../stores.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8"
    );
    expect(source).toContain("verifyAndRepublishKeys");
  });

  it("login should call verifyAndRepublishKeys after fetchUserInfo", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../stores.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8"
    );
    // Verify the login function calls verifyAndRepublishKeys
    const loginSection = source.slice(
      source.indexOf("execute: login"),
      source.indexOf("execute: login") + 800
    );
    expect(loginSection).toContain("verifyAndRepublishKeys");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/entities/auth/model/__tests__/registration-poll.test.ts`
Expected: FAIL — no verifyAndRepublishKeys function

**Step 3: Implement key verification**

Add new function in `stores.ts` before the `login` definition (~line 497):

```typescript
  /** Verify user has 12 published encryption keys; re-publish if missing.
   *  Called on every login to catch users stuck in broken state. */
  const verifyAndRepublishKeys = async () => {
    if (!address.value || !privateKey.value) return;

    const userData = appInitializer.getUserData(address.value);
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
      // Store as pending — poll will handle it when PKOIN arrives
      const name = (userData as any)?.name ?? "";
      const language = (userData as any)?.language ?? "en";
      const about = (userData as any)?.about ?? "";
      const image = (userData as any)?.image ?? "";
      setPendingRegProfile({ name, language, about, encPublicKeys, image });
      setRegistrationPending(true);
      startRegistrationPoll();
      return;
    }

    // Has PKOIN — publish immediately
    try {
      await appInitializer.syncNodeTime();
      const name = (userData as any)?.name ?? "";
      const language = (userData as any)?.language ?? "en";
      const about = (userData as any)?.about ?? "";
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
      // Fall back to pending poll
      const name = (userData as any)?.name ?? "";
      const language = (userData as any)?.language ?? "en";
      const about = (userData as any)?.about ?? "";
      const image = (userData as any)?.image ?? "";
      setPendingRegProfile({ name, language, about, encPublicKeys });
      setRegistrationPending(true);
      startRegistrationPoll();
    }
  };
```

Modify the `login` function (lines 498-519) to call `verifyAndRepublishKeys`:

```typescript
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/entities/auth/model/__tests__/registration-poll.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/entities/auth/model/stores.ts src/entities/auth/model/__tests__/registration-poll.test.ts
git commit -m "feat: verify and re-publish encryption keys on every login"
```

---

## Task 3: Fix `canBeEncrypt()` to check peer keys

**Files:**
- Modify: `src/entities/matrix/model/matrix-crypto.ts:633-641`
- Test: `src/entities/matrix/model/__tests__/can-be-encrypt.test.ts`

**Step 1: Write the failing test**

Create: `src/entities/matrix/model/__tests__/can-be-encrypt.test.ts`

```typescript
import { describe, it, expect } from "vitest";

describe("canBeEncrypt peer key check", () => {
  it("source should check that all usersinfo entries have >= 12 keys", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../matrix-crypto.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8"
    );
    // Find the canBeEncrypt function
    const start = source.indexOf("canBeEncrypt(): boolean");
    const end = source.indexOf("}", start + 1) + 1;
    const fnBody = source.slice(start, end + 50); // grab a bit extra

    // Must check keys.length for all users, not just count of usersinfo
    expect(fnBody).toContain("keys");
    expect(fnBody).toContain(".every(") ;
    // Must NOT only check usersinfo.length > 1 without key check
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/entities/matrix/model/__tests__/can-be-encrypt.test.ts`
Expected: FAIL — canBeEncrypt doesn't use `.every(` for key check

**Step 3: Implement — update `canBeEncrypt` to verify peer keys**

In `matrix-crypto.ts`, replace `canBeEncrypt` (lines 633-641):

```typescript
      canBeEncrypt(): boolean {
        const publicChat = pcrypto.getIsChatPublic?.(chat) ?? false;
        if (publicChat) return false;
        if (!pcrypto.user?.private || pcrypto.user.private.length !== 12) return false;
        if (!pcrypto.user.userinfo?.id || !users[pcrypto.user.userinfo.id]) return false;

        const usersinfoArray = Object.values(usersinfo);
        if (usersinfoArray.length <= 1 || usersinfoArray.length >= 50) return false;

        // ALL participants must have 12 published keys for ECDH to work
        return usersinfoArray.every(u => u.keys && u.keys.length >= m);
      },
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/entities/matrix/model/__tests__/can-be-encrypt.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/entities/matrix/model/matrix-crypto.ts src/entities/matrix/model/__tests__/can-be-encrypt.test.ts
git commit -m "fix: canBeEncrypt checks all peers have 12 keys before encrypting"
```

---

## Task 4: Graceful decrypt degradation

**Files:**
- Modify: `src/entities/matrix/model/matrix-crypto.ts:650-790` (encryptEvent, decryptEvent)

**Step 1: Write the failing test**

Add to `src/entities/matrix/model/__tests__/can-be-encrypt.test.ts`:

```typescript
describe("decrypt graceful degradation", () => {
  it("decryptEvent should catch missing body[myId] and throw descriptive error", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../matrix-crypto.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8"
    );
    // Find decryptEvent function body
    const start = source.indexOf("async decryptEvent(event");
    const relevantSection = source.slice(start, start + 2000);

    // Should have explicit check for missing body entries with descriptive message
    expect(relevantSection).toContain("no encrypted payload for");
  });

  it("encryptEvent should warn when preparedUsers is incomplete", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../matrix-crypto.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8"
    );
    const start = source.indexOf("async encryptEvent(text");
    const relevantSection = source.slice(start, start + 1000);

    // Should log warning about missing users
    expect(relevantSection).toContain("missing encryption keys");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/entities/matrix/model/__tests__/can-be-encrypt.test.ts`
Expected: FAIL

**Step 3: Implement graceful degradation**

In `matrix-crypto.ts`, update `encryptEvent` (around line 650):

```typescript
      // ---- encryptEvent — routes to group or 1:1 path ----
      async encryptEvent(text: string): Promise<Record<string, unknown>> {
        const tetatet = pcrypto.getIsTetatetChat?.(chat) ?? false;

        // Group chats use common key + AES-CBC
        if (!tetatet) {
          return room.encryptEventGroup(text);
        }

        // 1:1 chats use per-user ECDH + AES-SIV
        const _users = preparedUsers(0, version);

        // Warn if not all room members have keys (encryption will be partial)
        const allMembers = Object.values(usersinfo);
        const missingKeys = allMembers.filter(u => !u.keys || u.keys.length < m);
        if (missingKeys.length > 0) {
          console.warn("[pcrypto] encryptEvent: " + missingKeys.length + " member(s) missing encryption keys:", missingKeys.map(u => u.id.slice(0, 10)));
        }

        const encryptedEvent: Record<string, unknown> = {
          block: pcrypto.currentblock.height,
          version: version,
          msgtype: "m.encrypted",
          body: {} as Record<string, unknown>,
        };

        const body: Record<string, unknown> = {};
        for (let i = 0; i < _users.length; i++) {
          const user = _users[i];
          if (user.id != pcrypto.user?.userinfo?.id || _users.length <= 1) {
            body[user.id] = await room._encrypt(user.id, text, version);
          }
        }

        encryptedEvent.body = Base64.encode(JSON.stringify(body));
        return encryptedEvent;
      },
```

Update `decryptEvent` — add explicit check for missing body entry (around line 730, after the JSON parse):

Find the section after `body = JSON.parse(decoded_atob)` and before the existing keyindex/bodyindex logic. Add a check:

```typescript
        // Check if encrypted payload exists for us
        const allIds = Object.keys(body);
        if (allIds.length === 0) {
          throw new Error("Empty encrypted body — sender may lack encryption keys");
        }

        // Original logic: find which key to use
        // ... (keep existing keyindex/bodyindex detection)
```

After the existing keyindex/bodyindex detection block (around where it picks `body[bodyindex]`), add a guard:

```typescript
        if (!bodyindex || !body[bodyindex]) {
          throw new Error("no encrypted payload for this user — sender may not have our encryption keys");
        }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/entities/matrix/model/__tests__/can-be-encrypt.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/entities/matrix/model/matrix-crypto.ts src/entities/matrix/model/__tests__/can-be-encrypt.test.ts
git commit -m "fix: graceful degradation when peer lacks encryption keys"
```

---

## Task 5: Add peer key status to chat store

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts`
- Modify: `src/entities/chat/model/types.ts`

**Step 1: Write the failing test**

Create: `src/entities/chat/model/__tests__/peer-keys.test.ts`

```typescript
import { describe, it, expect } from "vitest";

describe("peer key status tracking", () => {
  it("chat-store should expose peerKeysStatus reactive map", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../chat-store.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8"
    );
    expect(source).toContain("peerKeysStatus");
    expect(source).toContain("checkPeerKeys");
  });

  it("types should define PeerKeysStatus type", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../types.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8"
    );
    expect(source).toContain("PeerKeysStatus");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/entities/chat/model/__tests__/peer-keys.test.ts`
Expected: FAIL

**Step 3: Implement peer key status tracking**

In `src/entities/chat/model/types.ts`, add at the end:

```typescript
/** Peer encryption key status for a room */
export type PeerKeysStatus = "unknown" | "available" | "missing";
```

In `src/entities/chat/model/chat-store.ts`, add state and method:

Add near other reactive state declarations (around line 380):

```typescript
  // Track peer encryption key availability per room
  const peerKeysStatus = reactive(new Map<string, PeerKeysStatus>());
```

Import the type at the top of the file where other types from `./types` are imported:

```typescript
import type { ..., PeerKeysStatus } from "./types";
```

Add the check function (near the end of the store, before the return statement):

```typescript
  /** Check if all peers in a room have published encryption keys.
   *  Updates peerKeysStatus map and returns the status. */
  const checkPeerKeys = async (roomId: string): Promise<PeerKeysStatus> => {
    const authStore = useAuthStore();
    const roomCrypto = authStore.pcrypto?.rooms[roomId];
    if (!roomCrypto) {
      peerKeysStatus.set(roomId, "unknown");
      return "unknown";
    }

    const canEncrypt = roomCrypto.canBeEncrypt();
    const status: PeerKeysStatus = canEncrypt ? "available" : "missing";
    peerKeysStatus.set(roomId, status);
    return status;
  };
```

Add to the return statement:

```typescript
    peerKeysStatus,
    checkPeerKeys,
```

Add cleanup in the `cleanup()` function:

```typescript
    peerKeysStatus.clear();
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/entities/chat/model/__tests__/peer-keys.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/entities/chat/model/chat-store.ts src/entities/chat/model/types.ts src/entities/chat/model/__tests__/peer-keys.test.ts
git commit -m "feat: track peer encryption key availability per room"
```

---

## Task 6: UI — disable send when peer lacks keys + warning banner

**Files:**
- Modify: `src/features/messaging/ui/MessageInput.vue`
- Modify: `src/widgets/chat-window/ChatWindow.vue`

**Step 1: Implement MessageInput disable**

In `MessageInput.vue`, add peer key check:

After the existing imports/composable calls (around line 30), add:

```typescript
const peerKeysOk = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return true; // no room selected = don't block
  const status = chatStore.peerKeysStatus.get(roomId);
  return status !== "missing";
});
```

Update the `handleSend` function (line 140):

```typescript
const handleSend = () => {
  if (!text.value.trim() || !peerKeysOk.value) return;
  // ... rest unchanged
```

Update the send button disabled state (line 600):

```html
:disabled="!text.trim() || sending || !peerKeysOk" @click="handleSend">
```

**Step 2: Add warning banner in ChatWindow**

In `ChatWindow.vue`, add a banner that shows when peer keys are missing.

Find the template area where the chat content is rendered. Add before the MessageList:

```html
<div v-if="peerKeysMissing" class="mx-4 my-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex items-center gap-2">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-amber-500">
    <path d="M12 9v4m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>
  </svg>
  <span>{{ t('chat.peerNoKeys', 'Peer hasn\'t published encryption keys yet. Messaging is temporarily unavailable.') }}</span>
</div>
```

Add computed in script setup:

```typescript
const peerKeysMissing = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return false;
  return chatStore.peerKeysStatus.get(roomId) === "missing";
});
```

**Step 3: Trigger peer key check when entering a room**

In `ChatWindow.vue`, add a watcher that checks peer keys when the active room changes:

```typescript
watch(() => chatStore.activeRoomId, async (roomId) => {
  if (roomId) {
    await chatStore.checkPeerKeys(roomId);
  }
}, { immediate: true });
```

**Step 4: Add periodic recheck (30s) for rooms with missing keys**

In `ChatWindow.vue`, add interval-based recheck:

```typescript
let peerKeyRecheckTimer: ReturnType<typeof setInterval> | null = null;

watch(() => chatStore.activeRoomId, (roomId) => {
  if (peerKeyRecheckTimer) { clearInterval(peerKeyRecheckTimer); peerKeyRecheckTimer = null; }
  if (!roomId) return;

  peerKeyRecheckTimer = setInterval(async () => {
    const status = chatStore.peerKeysStatus.get(roomId);
    if (status === "missing") {
      // Re-prepare the crypto room to fetch fresh user data
      const authStore = useAuthStore();
      const roomCrypto = authStore.pcrypto?.rooms[roomId];
      if (roomCrypto) {
        try {
          await roomCrypto.prepare();
          await chatStore.checkPeerKeys(roomId);
        } catch { /* ignore */ }
      }
    }
  }, 30_000);
}, { immediate: true });

onUnmounted(() => {
  if (peerKeyRecheckTimer) { clearInterval(peerKeyRecheckTimer); peerKeyRecheckTimer = null; }
});
```

**Step 5: Commit**

```bash
git add src/features/messaging/ui/MessageInput.vue src/widgets/chat-window/ChatWindow.vue
git commit -m "feat: block messaging when peer lacks encryption keys, show warning banner"
```

---

## Task 7: Registration gate — block chat until keys confirmed

**Files:**
- Modify: `src/app/App.vue` or the component that shows chat vs registration state

**Step 1: Explore current gate**

The app already has `registrationPending` flag. We need to ensure the UI shows a progress indicator instead of the chat when registration is pending.

Check how `registrationPending` is currently used in the UI:

```bash
grep -r "registrationPending" src/ --include="*.vue" --include="*.ts" -l
```

**Step 2: Implement gate in the appropriate component**

In the main chat layout component, add a gate that shows when `registrationPending` is true:

```html
<template>
  <!-- If registration pending, show progress overlay -->
  <div v-if="authStore.registrationPending" class="fixed inset-0 z-50 flex items-center justify-center bg-white dark:bg-gray-900">
    <div class="flex flex-col items-center gap-4 text-center px-8">
      <div class="h-12 w-12 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
      <h2 class="text-lg font-semibold text-gray-900 dark:text-white">{{ t('auth.publishingKeys', 'Publishing encryption keys...') }}</h2>
      <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('auth.publishingKeysDesc', 'This may take a few minutes. Please wait while your profile is being registered on the blockchain.') }}</p>
    </div>
  </div>
  <!-- Normal content -->
  ...
</template>
```

**Step 3: Commit**

```bash
git add <modified-file>
git commit -m "feat: block chat access while encryption keys are being published"
```

---

## Task 8: Full verification

**Step 1: Run all tests**

```bash
npm run test
```
Expected: All pass

**Step 2: Type check**

```bash
npx vue-tsc --noEmit
```
Expected: No errors

**Step 3: Lint**

```bash
npm run lint
```
Expected: Clean or only pre-existing warnings

**Step 4: Build**

```bash
npm run build
```
Expected: Success

**Step 5: Code review**

Use `superpowers:code-reviewer` to review all changes against the design.

**Step 6: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address review feedback for reliable registration"
```
