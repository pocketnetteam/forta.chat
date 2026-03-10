# Bastyon Channels Tab Design

## Overview

Add a "Channels" tab to the chat interface, displaying Bastyon channel subscriptions as chat-like entries. Channels appear alongside regular chats, and opening a channel shows its posts rendered as message bubbles.

## Architecture: Parallel Entity (Approach B)

Channels are a separate entity from Matrix chats — different data source (Bastyon RPC vs Matrix), separate store, isolated components. They merge visually in the "All" tab but remain architecturally independent.

## Data Layer

### Types (`src/entities/channel/model/types.ts`)

```typescript
interface Channel {
  address: string
  name: string
  avatar: string
  lastContent: ChannelPost | null
}

interface ChannelPost {
  txid: string
  type: 'video' | 'share' | 'article'
  caption: string
  message: string
  time: number
  height: number
  scoreSum: number
  scoreCnt: number
  comments: number
  images?: string[]
  url?: string
}
```

### Store (`src/entities/channel/model/channel-store.ts`)

Pinia store with:
- `channels: Channel[]` — subscription list
- `activeChannelAddress: string | null` — currently open channel
- `posts: Map<string, ChannelPost[]>` — posts keyed by channel address
- `isLoadingChannels / isLoadingPosts` — loading states
- `fetchChannels(address, page)` — calls `getsubscribeschannels`
- `fetchPosts(channelAddress, page)` — calls `getprofilefeed`
- Pagination: `channelsPage`, `postsPage`, `hasMoreChannels`, `hasMorePosts`

### RPC Service (`src/shared/api/bastyon-rpc.ts`)

Dedicated module for Bastyon RPC calls to `test.2.pocketnet.app:39091/`:
- `getSubscribesChannels(address, blockNumber, page, pageSize)`
- `getProfileFeed(address, height, txid, count)`

## UI Integration

### Chat List

**FolderTabs** — new tab value `"channels"` alongside `"all" | "personal" | "groups" | "invites"`.

**ChannelList.vue** — visually identical to ContactList:
- Avatar, name, last post as "message" preview, relative time
- RecycleScroller for virtual scrolling
- Infinite scroll pagination

**"All" tab merge** — channels mixed with chats, sorted by time:
- Channels use `lastContent.time`, chats use `lastMessage.timestamp`
- Channel entries show a small megaphone icon/badge to distinguish from chats

**Click behavior**:
- Sets `activeChannelAddress` in channel store
- Clears `activeRoom` in chat store (and vice versa)

### Channel View (`src/features/channels/ui/ChannelView.vue`)

Replaces ChatWindow content when a channel is active:
- Header: channel avatar, name
- Post area: bottom-to-top scroll (like chat), newest posts at bottom

### Post Bubble (`src/features/channels/ui/ChannelPostBubble.vue`)

Each post rendered as an incoming message bubble:
- Caption (bold, if present)
- Message text (HTML/markdown support)
- Images (gallery/preview)
- Video (preview with play icon)
- Timestamp via `formatRelativeTime()`
- Action bar: rating (scoreSum/scoreCnt), comments count
- Click on comments → expand PostComments or open PostPlayerModal
- Uses existing `use-post-scores.ts`, `use-post-comments.ts`

## Error Handling

- Empty channels list: "You have no channel subscriptions" message
- Empty posts: "No posts in this channel yet"
- Network errors: toast notification + "Retry" button
- Uses existing `useToast` pattern

## File Structure

```
src/entities/channel/
  model/
    types.ts
    channel-store.ts
  index.ts

src/features/channels/
  ui/
    ChannelList.vue
    ChannelView.vue
    ChannelPostBubble.vue
  index.ts

src/shared/api/
  bastyon-rpc.ts
```

## Modified Files

- `FolderTabs.vue` — add "Channels" tab
- `ContactList.vue` — merge channels in "All" tab
- `ChatWindow.vue` — conditional render of ChannelView
- `use-sidebar-tab.ts` — extend filter type
- `en.ts` / `ru.ts` — new i18n keys

## RPC Details

### getsubscribeschannels
```json
POST test.2.pocketnet.app:39091/
{
  "method": "getsubscribeschannels",
  "params": ["<ADDRESS>", <BLOCK_NUMBER>, <PAGE>, <PAGE_SIZE>, 1]
}
```

### getprofilefeed
Parameters: `[height, txid, count, lang, tagsfilter, type, reserved, reserved, tagsexcluded, address, keyword, orderby, ascdesc]`
