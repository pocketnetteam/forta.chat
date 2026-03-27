# Design: Unified Encrypted/Unresolved Data Display

**Date:** 2026-03-25
**Status:** Approved

## Problem

When decryption fails or name resolution gives up, the UI shows raw encrypted strings, truncated hex addresses (`a1b2c3d4…ef56`), or Matrix IDs instead of human-readable fallbacks. The handling is inconsistent across room names, user display names, and message previews.

## Approach: Typed `DisplayResult` Return Values

Introduce a `DisplayResult` type and three wrapper functions that encapsulate the resolving/ready/failed logic. Components use `state` to choose between skeleton, text, or fallback — never touching raw values directly.

```typescript
type DisplayState = 'resolving' | 'ready' | 'failed';
interface DisplayResult { state: DisplayState; text: string; }
```

## Three Formatters

### `getRoomTitleForUI(room, opts): DisplayResult`
Wraps `resolveRoom()` + `isUnresolvedName()`:
- `isUnresolvedName(resolved)` && not gave up → `{ state: 'resolving', text: '' }`
- `isUnresolvedName(resolved)` && gave up → `{ state: 'failed', text: 'Чат #' + room.id.slice(1,5).toUpperCase() }`
- Otherwise → `{ state: 'ready', text: resolved }`

### `getUserDisplayNameForUI(address, getDisplayName): DisplayResult`
Wraps `getDisplayName()`:
- Result passes `isUnresolvedName()` → `{ state: 'failed', text: t('common.unknownUser') }`
- Otherwise → `{ state: 'ready', text: result }`

No `resolving` state — `getDisplayName` is synchronous with full fallback chain.

### `getMessagePreviewForUI(msg, room, formatPreview): DisplayResult`
Wraps `isEncryptedPlaceholder()` + `formatPreview()`:
- `isEncryptedPlaceholder(msg.content)` && `decryptionStatus !== 'failed'` → `{ state: 'resolving', text: '' }`
- `isEncryptedPlaceholder(msg.content)` && `decryptionStatus === 'failed'` → `{ state: 'failed', text: t('message.notDecrypted') }`
- Otherwise → `{ state: 'ready', text: formatPreview(msg, room) }`

## Required Data Pipeline Change

Add `decryptionStatus?: 'pending' | 'failed'` to `Message` interface (absence = ok).
Propagate from `LocalMessage` during `LocalMessage → Message` mapping in chat-store.

## Fallback Text

| Entity | Failed fallback | Uniqueness |
|--------|----------------|------------|
| Room title | `"Чат #" + room.id.slice(1,5).toUpperCase()` | 4 chars from room ID |
| User name | `t('common.unknownUser')` = "Пользователь" | Uniform |
| Message preview | `t('message.notDecrypted')` = "Сообщение не расшифровано" | Uniform |

## State Transitions

| Entity | resolving → ready | resolving → failed |
|--------|------------------|--------------------|
| Room title | userStore.users updates, name resolves | gaveUpRooms (5 retries, exp backoff) |
| User name | — (synchronous) | getDisplayName fallback = truncated addr |
| Message preview | DecryptionWorker succeeds → status: ok | DecryptionWorker exhausts 5 attempts → status: failed |

## UI Application

### ContactList (room list)
- Room name: skeleton on resolving, fallback text on failed
- Preview: skeleton on resolving, italic "Сообщение не расшифровано" on failed

### ChatWindow (header)
- Room name: same pattern as ContactList

### MessageBubble (sender name)
- No skeleton (synchronous). Failed → italic "Пользователь"

## Files to Modify

- `src/entities/chat/lib/display-result.ts` — NEW: type + 3 functions
- `src/entities/chat/model/types.ts` — add `decryptionStatus` to Message
- `src/entities/chat/model/chat-store.ts` — propagate decryptionStatus in mapping
- `src/features/contacts/ui/ContactList.vue` — use formatters
- `src/widgets/chat-window/ChatWindow.vue` — use formatters
- `src/features/messaging/ui/MessageBubble.vue` — use formatters
- `src/shared/lib/i18n/` — add i18n keys: `common.unknownUser`, `message.notDecrypted`
