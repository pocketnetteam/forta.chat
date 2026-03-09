# Chat Info Panel — Design Document

**Date:** 2026-03-03
**Platform:** Web (Electron + browser), hybrid layout: side panel (desktop) / fullscreen (mobile)
**Approach:** Redesign existing `ChatInfoPanel.vue` with internal navigation stack

---

## Architecture

Single panel component with two internal "screens":
- **Screen 1 (Main):** Profile header, action buttons, contact info, chat settings, media preview, members list (groups)
- **Screen 2 (Gallery):** Full media/files browser with 4 filter tabs

**Desktop:** 360px side panel, slides from right, chat window narrows.
**Mobile (<640px):** Fullscreen overlay with back navigation.

**Entry points:**
1. Click on chat header (avatar + name) — opens info for current chat/contact
2. Click on @mention in message — opens profile of that user
3. Click on sender avatar in group message — opens profile of that user

For entry points 2 and 3, the panel shows the user's profile (not the room), with a "Chat" button that creates/opens a 1:1 chat with them.

---

## Screen 1: Main Info Screen

### 1.1 Panel Header

```
┌──────────────────────────────────┐
│  [←]                        [✕]  │
```

- **Mobile:** `←` back arrow (left), closes panel
- **Desktop:** `✕` close button (right)
- Sticky on scroll; gains `box-shadow` when content scrolls beneath
- No title text (clean look)

### 1.2 Profile Block

```
│           ┌────────┐             │
│           │ AVATAR │             │
│           │  80px  │             │
│           └────────┘             │
│        User Name                │
│       PGtV9k...address         │
```

**Avatar:**
- Circular, 80px diameter
- 1:1 chat: peer's avatar. Group: room avatar
- Clickable — opens full-size in existing `MediaViewer.vue`
- Groups (admin): camera overlay icon on hover for avatar change (existing functionality)

**Name:**
- 18px, `font-semibold`, `text-text-color`
- 1:1: peer's Bastyon profile name
- Group: room name

**Subtitle:**
- 1:1: Bastyon address, truncated, 13px, `text-text-color/50`
- Group: "N members", 13px, `text-text-color/50`

### 1.3 Action Buttons

```
│   ┌──────┐ ┌──────┐ ┌────┐      │
│   │  💬  │ │  📞  │ │ ⋯  │      │
│   │ Chat │ │ Call │ │More│      │
│   └──────┘ └──────┘ └────┘      │
```

Three buttons in a centered row. Each button: vertical stack of icon (24px) + label (11px).

| Button | Icon | Label (en/ru) | Action |
|--------|------|---------------|--------|
| Chat | MessageSquare | Chat / Чат | Close panel, focus message input |
| Call | Phone | Call / Звонок | Initiate voice call |
| More | MoreHorizontal (⋯) | More / Ещё | Open context menu |

**Button styling:**
- Touch target: ~72×52px
- Background: `bg-color-bg-ac/10`, border-radius: 12px
- Hover: `bg-color-bg-ac/18`
- Active: `scale(0.95)` transform, 120ms

**Call button visibility:**
- Hidden in group chats (calls are 1:1 only)
- Disabled (opacity 0.4) during an active call

**More button — context menu:**
Uses existing `ContextMenu.vue`, anchored below the button.

| Item | Icon | Visible when | Color |
|------|------|-------------|-------|
| Video call | Video | 1:1 only | default |
| Search in chat | Search | Always | default |
| Mute / Unmute notifications | BellOff / Bell | Always | default |
| — separator — | | | |
| Clear history | Trash2 | Always | default |
| Block / Unblock user | Ban | 1:1 only | red |
| Leave group | LogOut | Group only | red |
| Delete chat | Trash | 1:1 only | red |
| Delete group | Trash | Group + admin | red |

Red items: `text-red-500`. Destructive actions show confirmation modal before executing.

### 1.4 Contact Info Section

```
├──────────────────────────────────┤
│  Information                     │
│  📝  About                       │
│      User's bio text...         │
│  🌐  Website                     │
│      https://example.com        │
│  📋  Bastyon Address             │
│      PGtV9k...truncated        │
├──────────────────────────────────┤
```

**1:1 chats:**
- **About** (`user.about`) — multiline, 14px, `text-text-color/70`
- **Website** (`user.site`) — clickable link, `text-color-txt-ac`, opens in new window
- **Bastyon Address** — truncated, tap to copy + toast "Copied"

**Groups:**
- **Description** (`room.topic`) — multiline text. Admin: edit button (pencil icon) for inline editing
- Fields that don't exist are hidden (no empty rows)

Each row: icon left (16px, muted) + text right. Row spacing: 16px.

### 1.5 Chat Settings Section

```
├──────────────────────────────────┤
│  🔔  Notifications        [⬤⚪] │
├──────────────────────────────────┤
```

Single toggle using existing `Toggle.vue`. State from `chatStore.mutedRoomIds`.

### 1.6 Media Preview Section

```
├──────────────────────────────────┤
│  Media, files and links      [→] │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐   │
│  │ 📷 │ │ 📷 │ │ ▶🎬│ │ 📷 │   │
│  └────┘ └────┘ └────┘ └────┘   │
│  12 photos · 3 videos · 8 files │
├──────────────────────────────────┤
```

- Horizontal strip of last 4 photos/videos
- Each preview: square, border-radius 8px, `object-cover`
- Videos: small ▶ icon overlay + duration badge
- Counters: "N photos · N videos · N files", 12px, `text-text-color/40`
- Click anywhere in section → navigates to Gallery screen
- **Hidden entirely** if no media/files exist in chat

### 1.7 Group Members Section (groups only)

```
├──────────────────────────────────┤
│  Members (12)               [+]  │
│  🔍 Search members              │
│  ┌──┐ User Name          admin  │
│  │AV│ Address...                │
│  └──┘                           │
│  ┌──┐ Another User              │
│  │AV│ Address...                │
│  └──┘                           │
├──────────────────────────────────┤
│  🚫 Banned members (2)      [→] │
├──────────────────────────────────┤
│  [🚪 Leave group]               │
│  [🗑️ Delete group]              │
└──────────────────────────────────┘
```

- Member row: Avatar (36px) + Name + address (truncated)
- Badges: "admin" (power level >= 50), "muted"
- Right-click / long-tap → context menu: Promote/Demote admin, Mute, Kick, Ban
- `[+]` button (admin only): inline search to add/invite members
- Search field shown when 5+ members
- "Banned members" row (admin only): navigates to banned list with Unban buttons
- "Leave group" button: red text, confirmation modal
- "Delete group" button (admin only): red text, confirmation modal

---

## Screen 2: Gallery (Internal Navigation)

Accessed by clicking "Media, files and links" from Screen 1. Slides in from right within the panel.

### 2.1 Gallery Header

```
┌──────────────────────────────────┐
│  [←]  Media and files            │
```

Back arrow returns to Screen 1 (slide-right animation).

### 2.2 Filter Tabs

```
│  ┌──────┬──────┬──────┬────────┐ │
│  │Media │Files │Links │Voice   │ │
│  │ ▬▬▬  │      │      │        │ │
│  └──────┴──────┴──────┴────────┘ │
```

- 4 text tabs in horizontal row, evenly distributed
- Active: `text-color-txt-ac` + 2px bottom border (accent color)
- Inactive: `text-text-color/50`
- Underline slides between tabs: 150ms transition
- Content crossfades: 150ms
- Tabs stick below header on scroll

### 2.3 Tab: Media (Photos + Videos)

**Grid layout:**
- 3 columns, 2px gap
- Each cell: square (`aspect-ratio: 1`), `object-cover`, border-radius: 2px
- Videos: white ▶ icon (centered, with shadow) + duration badge bottom-right (`0:34`, 10px, white on black/50 pill)

**Grouping:**
- By month: "March 2026" header, 13px, `font-medium`, `text-text-color/50`, 12px top padding

**Interaction:**
- Tap → opens `MediaViewer.vue` with filtered array (photos + videos only from this chat)
- Swipe left/right in viewer to navigate

**Loading:**
- Infinite scroll, loads more as user scrolls down
- Skeleton placeholders (gray squares pulsing) while loading

### 2.4 Tab: Files

**List layout:**
```
│  March 2026                      │
│  ┌──┐ document.pdf               │
│  │📄│ 2.4 MB · Mar 12            │
│  └──┘                            │
```

- Row: file type icon (40px, rounded square bg) + filename (14px, truncated) + size and date (12px, muted)
- Grouped by month
- Tap → downloads file via existing `use-file-download.ts`

**File type icons:** PDF (red), spreadsheet (green), document (blue), archive (yellow), generic (gray).

### 2.5 Tab: Links

**List layout:**
```
│  ┌──┐ https://example.com/art.. │
│  │🔗│ Message context text...   │
│  │  │ Mar 12                    │
│  └──┘                            │
```

- Row: link icon (40px) + URL (14px, truncated, accent color) + message excerpt (12px, muted, 1 line) + date
- Links extracted from text messages using existing `URL_RE` from `message-format.ts`
- Tap → opens URL in new window (`window.open`)
- Grouped by month

### 2.6 Tab: Voice Messages

**List layout:**
```
│  ┌──┐ Voice message              │
│  │🎙│ 0:24 · Mar 12             │
│  │  │ ▶ ▁▂▃▅▃▂▁▃▅▇▅▃▂▁         │
│  └──┘                            │
```

- Row: mic icon + duration + date + mini waveform visualization
- Tap → inline playback (play/pause + progress bar)
- Uses existing `VoiceMessage.vue` component for rendering/playback
- Grouped by month

### 2.7 Empty States

Centered in content area for each tab:

| Tab | Icon | Text (en) | Text (ru) |
|-----|------|-----------|-----------|
| Media | ImageIcon 48px | No photos or videos yet | Пока нет фото и видео |
| Files | FileIcon 48px | No files yet | Пока нет файлов |
| Links | LinkIcon 48px | No links yet | Пока нет ссылок |
| Voice | MicIcon 48px | No voice messages yet | Пока нет голосовых сообщений |

Icon: 48px, `text-text-color/20`. Text: 14px, `text-text-color/40`.

---

## States

### Blocked Contact (1:1 only)

- Avatar at 50% opacity
- "Call" button hidden
- Warning block below buttons: "You blocked this user" + "Unblock" link button
- In "More" menu: "Block" changes to "Unblock"
- Media/files sections still accessible (historical content)

### Panel for @mention / avatar click (user profile mode)

When opened by clicking @mention or sender avatar in a group:
- Shows that specific user's profile (not the room info)
- "Chat" button creates/opens 1:1 chat with them
- "Call" button calls them directly
- No group members section
- No media section (since this isn't a room view, it's a user profile)
- Shows: avatar, name, about, site, address

---

## Animations

| Transition | Duration | Easing |
|-----------|----------|--------|
| Panel open (desktop) | 250ms | ease-out |
| Panel open (mobile) | 250ms | ease-out |
| Screen 1 → Gallery | 200ms | ease-in-out (slide-left) |
| Gallery → Screen 1 | 200ms | ease-in-out (slide-right) |
| Tab switch underline | 150ms | ease |
| Tab content crossfade | 150ms | ease |
| Context menu appear | 150ms | cubic-bezier(0.34, 1.3, 0.64, 1) |

---

## Navigation

| Action | Result |
|--------|--------|
| Click "Chat" button | Close panel, focus message input |
| Click ✕ (desktop) or ← (mobile) | Close panel |
| Click outside panel (desktop) | Close panel |
| Press Escape (desktop) | Close panel |
| Click ← in gallery header | Return to Screen 1 |
| Click media preview on Screen 1 | Navigate to Gallery, Media tab |
| Click file preview on Screen 1 | Navigate to Gallery, Files tab |

---

## Data Sources

| Data | Source |
|------|--------|
| User name, about, site, image | `authStore.loadUsersInfo([address])` → `authStore.getBastyonUserData(address)` |
| Room name, topic, members, avatar | `chatStore.activeRoom` (ChatRoom) |
| Messages (for media/files/links) | `chatStore.activeMessages` filtered by type |
| Mute state | `chatStore.mutedRoomIds` |
| Power levels | `chatStore.getRoomPowerLevels(roomId)` |
| Member actions | `chatStore.inviteMember/kickMember/banMember/etc.` |
| Blocked state | `chatStore.banMember/unbanMember` (1:1 block TBD) |
| File download | `use-file-download.ts` |
| Media viewer | `MediaViewer.vue` |
| Voice playback | `VoiceMessage.vue` |

---

## i18n Keys to Add

```
"chatInfo.chat": "Chat" / "Чат"
"chatInfo.call": "Call" / "Звонок"
"chatInfo.more": "More" / "Ещё"
"chatInfo.information": "Information" / "Информация"
"chatInfo.about": "About" / "О себе"
"chatInfo.website": "Website" / "Сайт"
"chatInfo.address": "Bastyon Address" / "Адрес Bastyon"
"chatInfo.copied": "Copied" / "Скопировано"
"chatInfo.notifications": "Notifications" / "Уведомления"
"chatInfo.mediaFilesLinks": "Media, files and links" / "Медиа, файлы и ссылки"
"chatInfo.media": "Media" / "Медиа"
"chatInfo.files": "Files" / "Файлы"
"chatInfo.links": "Links" / "Ссылки"
"chatInfo.voice": "Voice" / "Голосовые"
"chatInfo.members": "Members" / "Участники"
"chatInfo.searchMembers": "Search members" / "Поиск участников"
"chatInfo.bannedMembers": "Banned members" / "Заблокированные"
"chatInfo.leaveGroup": "Leave group" / "Покинуть группу"
"chatInfo.deleteGroup": "Delete group" / "Удалить группу"
"chatInfo.deleteChat": "Delete chat" / "Удалить чат"
"chatInfo.clearHistory": "Clear history" / "Очистить историю"
"chatInfo.blockUser": "Block user" / "Заблокировать"
"chatInfo.unblockUser": "Unblock user" / "Разблокировать"
"chatInfo.searchInChat": "Search in chat" / "Поиск в чате"
"chatInfo.videoCall": "Video call" / "Видеозвонок"
"chatInfo.blockedWarning": "You blocked this user" / "Вы заблокировали этого пользователя"
"chatInfo.noMedia": "No photos or videos yet" / "Пока нет фото и видео"
"chatInfo.noFiles": "No files yet" / "Пока нет файлов"
"chatInfo.noLinks": "No links yet" / "Пока нет ссылок"
"chatInfo.noVoice": "No voice messages yet" / "Пока нет голосовых сообщений"
"chatInfo.nPhotos": "{n} photos" / "{n} фото"
"chatInfo.nVideos": "{n} videos" / "{n} видео"
"chatInfo.nFiles": "{n} files" / "{n} файлов"
"chatInfo.mediaAndFiles": "Media and files" / "Медиа и файлы"
"chatInfo.editDescription": "Edit description" / "Редактировать описание"
"chatInfo.addMember": "Add member" / "Добавить участника"
"chatInfo.confirmLeave": "Are you sure you want to leave this group?" / "Вы уверены, что хотите покинуть группу?"
"chatInfo.confirmDelete": "Are you sure you want to delete this chat?" / "Вы уверены, что хотите удалить этот чат?"
"chatInfo.confirmClear": "Are you sure you want to clear chat history?" / "Вы уверены, что хотите очистить историю чата?"
"chatInfo.confirmBlock": "Are you sure you want to block this user?" / "Вы уверены, что хотите заблокировать этого пользователя?"
```

---

## Component Structure

```
ChatInfoPanel.vue (container — manages open/close + internal navigation stack)
├── ChatInfoMain.vue (Screen 1)
│   ├── ProfileBlock (avatar, name, subtitle)
│   ├── ActionButtons (Chat, Call, More)
│   ├── ContactInfoSection (about, site, address)
│   ├── SettingsSection (notifications toggle)
│   ├── MediaPreviewSection (last 4 media + counters)
│   └── MembersSection (group only — list, search, add, banned, leave/delete)
├── ChatInfoGallery.vue (Screen 2)
│   ├── GalleryTabs (Media, Files, Links, Voice)
│   ├── MediaGrid.vue
│   ├── FilesList.vue
│   ├── LinksList.vue
│   └── VoiceList.vue
└── UserProfilePanel.vue (variant for @mention/avatar click — user profile mode)
```
