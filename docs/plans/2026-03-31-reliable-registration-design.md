# Reliable Registration & Crypto Keys — Design

## Problem

Users can end up with `sdkUser = no` and 0 published encryption keys in Pocketnet blockchain.
This makes Pcrypto E2E encryption impossible — `preparedUsers()` filters them out,
ECDH key agreement fails, messages cannot be encrypted/decrypted.

Root causes:
1. Registration poll has 5-minute timeout — if PKOIN/blockchain confirmation doesn't arrive, keys never get published
2. No key verification on login — if registration didn't complete, user stays broken forever
3. No graceful degradation — crash instead of user-friendly message when peer has no keys

## Solution: Hard Gate

### 1. Registration — infinite poll

- Remove 5-minute timeout from `startRegistrationPoll()`
- Exponential backoff: 3s → 6s → 12s → ... → max 60s
- Poll survives page reload via `resumeRegistrationPoll()`
- Block chat access until UserInfo transaction confirmed with keys
- UI: progress screen "Publishing crypto keys... (attempt N)"

### 2. Login — mandatory key check

- After login: `getUserData(address)` → verify `keys.length >= 12`
- If keys missing:
  - Re-derive 12 keys from private key (same `m/33'/0'/0'/{1-12}'` path)
  - Call `registerUserProfile()` again
  - Wait for confirmation (same poll mechanism)
- Only after confirmation → initialize Matrix and Pcrypto

### 3. Chat — peer key verification

- Before encryption: if `preparedUsers()` doesn't contain all room members → UI warning
- Block send button: "Peer hasn't completed registration. Messaging unavailable."
- Periodic recheck (30s) — auto-unblock when keys appear
- Decrypt failure: show "[Message unavailable: sender hasn't published crypto keys]" instead of crash

### 4. Files to modify

| File | Changes |
|------|---------|
| `src/entities/auth/model/stores.ts` | Infinite poll, login key check, re-publish |
| `src/entities/matrix/model/matrix-crypto.ts` | Graceful encrypt/decrypt degradation |
| `src/entities/chat/model/chat-store.ts` | Peer key check, periodic recheck |
| `src/app/providers/initializers/app-initializer.ts` | Gate before Matrix init |
| `src/features/messaging/ui/MessageInput.vue` | Block input when peer has no keys |
| `src/widgets/chat-window/ChatWindow.vue` | Warning banner |
