# In-Chat Search Redesign (Telegram-style) — Design Document

**Date:** 2026-03-09
**Status:** Approved

## Overview

Redesign the in-chat search (Cmd+F) to provide Telegram-like UX with a results dropdown, user filter chips, and smooth highlight animation.

## UI Layout

Search bar at top of chat window:

```
[←] [chip?] [________search input________] [👤] [N of M] [▲] [▼] [✕]
```

- `←` — close search
- chip — optional user filter chip (e.g. `[Daniel ✕]`)
- Input — text query
- `👤` — user filter button (shows member picker dropdown)
- `N of M` — results counter
- `▲ ▼` — navigate results
- `✕` — close search

## Behavior

### Text Search
1. User types → debounce 250ms → dropdown appears below search bar with matching messages
2. Each dropdown item: sender avatar, sender name, message snippet with highlight, date
3. Click item → dropdown closes, chat scrolls to message, message gets highlight animation
4. ▲▼ buttons navigate dropdown selection + auto-scroll to message
5. Counter shows "N of M"

### User Filter
1. Click 👤 → dropdown with chat participants (avatar + name)
2. Select user → chip appears in input: `[Name ✕]`
3. Results filtered to only that user's messages
4. If text also entered → filter by text within that user's messages
5. Backspace on empty text input → removes chip entirely
6. ✕ on chip → removes filter

### Results Dropdown
- Max-height ~300px, scrollable
- Max 50 results
- Sorted: newest first
- Uses `formatPreview` for message formatting
- Uses `splitByQuery` for match highlighting

## Highlight Animation

Replace current `search-highlight` with smooth accent-color pulse:

```css
@keyframes message-highlight {
  0%   { background-color: rgb(var(--color-bg-ac-bright) / 0.3); }
  50%  { background-color: rgb(var(--color-bg-ac-bright) / 0.1); }
  100% { background-color: transparent; }
}
.search-highlight {
  animation: message-highlight 1.5s ease-out;
  border-radius: 0.5rem;
}
```

Uses theme accent color → visible in both dark and light themes.

## Data Structure

```typescript
interface ChatSearchState {
  query: string;
  filterUser: string | null;
  results: Message[];
  selectedIndex: number;
  showDropdown: boolean;
  showUserPicker: boolean;
}
```

## Files to Modify

- `src/features/messaging/ui/ChatSearch.vue` — major rewrite
- `src/features/messaging/ui/MessageList.vue` — update highlight CSS
- `src/widgets/chat-window/ChatWindow.vue` — potentially adjust search integration
