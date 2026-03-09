# Chat Search Redesign — Design Document

**Date:** 2026-03-09
**Status:** Approved

## Overview

Redesign chat search to provide Telegram-like UX with two entry points:
1. **Cmd+K modal** — lightweight quick-switch between chats
2. **Sidebar extended search** — full search with sections (Chats, Contacts, Messages)

## 1. Cmd+K — Quick Chat Switcher

**Activation:** `Cmd+K` (Mac) / `Ctrl+K` (Win/Linux)

**UI:**
- Modal centered on screen, width ~480px, max-height ~400px
- Dimmed backdrop, close on Escape or click outside
- Search input at top with magnifier icon, placeholder "Перейти к чату..."
- Scrollable result list below

**Behavior:**

| State | Display |
|-------|---------|
| Empty input | Recent chats (last 8-10 by `updatedAt`) |
| Typing | Filtered chats, debounce 200ms |
| No results | "Ничего не найдено" |

**Each list item:** avatar + chat name (highlighted match) + last message (gray, truncated)

**Keyboard:** Arrow up/down, Enter to open, Escape to close. First item selected by default.

**Search logic:** client-side filter on `chatStore.sortedRooms` by name only.

**Ranking:**
1. Name starts with query (+100)
2. Name contains query
3. Pinned chats bonus (+50)
4. Recency score by `updatedAt` (0-30)

## 2. Sidebar Extended Search

**Activation:** Search input always visible at top of sidebar (replaces current toggle button).

**UI:**
- Input type="search" with magnifier icon, placeholder "Поиск...", X button to clear
- On input, chat list replaced with sectioned results

**Result sections:**

| Section | Source | Display |
|---------|--------|---------|
| **Chats** | `chatStore.sortedRooms` | Avatar, name with highlight, last message |
| **Contacts** | Matrix API `searchUsers` | Avatar, name with highlight, address |
| **Messages** | Cached decrypted messages | Chat avatar, chat name, message snippet with highlight, date |

**Behavior:**

| State | Display |
|-------|---------|
| Empty input / blur | Normal chat list |
| Typing | Sectioned results; chats instant, contacts/messages debounced 250ms |
| No results | "Ничего не найдено" + "Очистить поиск" button |

**Click actions:**
- Chat/Contact → open chat
- Message → open chat + scroll to message + highlight (reuse existing ChatSearch behavior)

**Ranking:** same as Cmd+K for chats section.

**Message search (client-side):**
- Search `message.content` across all cached/decrypted messages in all rooms
- Limitation: only decrypted/cached messages available
- Limit: show first 20 matches, sorted by timestamp (newest first)
- Each section shows max 5 items with "Show more" button

## 3. Match Highlighting

Extract existing `splitByQuery()` from `MessageContent.vue` into shared utility.
Highlight markup: `<mark class="bg-accent/20 text-accent font-semibold">`

## 4. Data Structure

```typescript
interface SearchableRoom {
  id: string
  name: string
  members: string[]
  avatar: string
  lastMessage?: string
  updatedAt: number
  isGroup: boolean
  isPinned: boolean
}
```

## 5. Pseudocode

### Debounced search
```
const query = ref('')
const debouncedQuery = refDebounced(query, 250)

// Chats — instant computed from query
// Contacts — API call on debouncedQuery
// Messages — client-side filter on debouncedQuery
```

### Chat ranking
```
function rankRooms(rooms, query):
  q = query.toLowerCase()
  scored = rooms
    .filter(r => r.name.toLowerCase().includes(q))
    .map(r => {
      score = 0
      if r.name.toLowerCase().startsWith(q): score += 100
      if r.isPinned: score += 50
      score += recencyScore(r.updatedAt)  // 0-30
      return { room: r, score }
    })
  return scored.sort((a,b) => b.score - a.score)
```

### Message search
```
function searchMessages(allRooms, query):
  q = query.toLowerCase()
  results = []
  for room in allRooms:
    for msg in room.cachedMessages:
      if msg.content.toLowerCase().includes(q):
        results.push({ room, message: msg })
  return results
    .sort((a,b) => b.message.timestamp - a.message.timestamp)
    .slice(0, 20)
```

## 6. UI Specifications

| Parameter | Value |
|-----------|-------|
| Cmd+K modal max-height | 400px |
| Cmd+K modal width | 480px |
| Sidebar section max items | 5, with "Show more" button |
| List item height | 56px (40px avatar + 8px padding) |
| Title font | 14px, semibold |
| Message preview font | 13px, regular, text-muted |
| Match highlight | bg-accent/20, font-semibold |
| Modal animation | fade + scale 0.95→1.0, 150ms ease-out |
| List transition | fade 100ms |
| Debounce (Cmd+K chats) | 200ms |
| Debounce (sidebar contacts/messages) | 250ms |

## 7. Files to Modify/Create

**New files:**
- `src/features/search/ui/QuickSearchModal.vue` — Cmd+K modal
- `src/features/search/model/use-search.ts` — shared search composable
- `src/shared/lib/utils/highlight.ts` — extracted `splitByQuery()` utility

**Modified files:**
- `src/widgets/sidebar/ChatSidebar.vue` — replace search toggle with always-visible input, integrate extended search
- `src/features/contacts/ui/ContactSearch.vue` — refactor into sidebar extended search with sections
- `src/features/messaging/ui/MessageContent.vue` — use shared highlight utility
- `src/app/App.vue` or layout — register Cmd+K global shortcut, mount QuickSearchModal
