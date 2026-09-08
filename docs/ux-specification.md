# Forta Chat — UX/UI Specification

> Messenger UX inspired by Telegram's speed, simplicity, and progressive disclosure.
> No brand copying — only the logic, feel, and interaction quality.
>
> **Note:** This is an aspirational UX spec. Route map highlights core flows;
> also shipped: `/apps`, `/download`, `/invite`, `/join`, `/settings/appearance`
> (settings hub is primarily `SettingsPanel`, not a `/settings` index).

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Screen Map](#2-screen-map)
3. [Design Tokens & Visual Language](#3-design-tokens--visual-language)
4. [Screen 1: Chat List (Home)](#4-screen-1-chat-list-home)
5. [Screen 2: Chat Room (Dialog / Group / Channel)](#5-screen-2-chat-room)
6. [Screen 3: Message Forwarding Flow](#6-screen-3-message-forwarding-flow)
7. [Screen 4: Context Actions on Messages](#7-screen-4-context-actions-on-messages)
8. [Screen 5: Groups & Channels](#8-screen-5-groups--channels)
9. [Screen 6: Profile & Settings](#9-screen-6-profile--settings)
10. [Screen 7: Media Viewer](#10-screen-7-media-viewer)
11. [Micro-animations & Transitions](#11-micro-animations--transitions)
12. [Onboarding & Progressive Disclosure](#12-onboarding--progressive-disclosure)
13. [UX Scenarios (Step-by-Step)](#13-ux-scenarios)
14. [Component State Reference](#14-component-state-reference)
15. [Accessibility & Edge Cases](#15-accessibility--edge-cases)

---

## 1. Design Principles

### Core Values

| Principle | Implementation |
|-----------|---------------|
| **Speed** | Every tap gets instant visual feedback (<100ms). Network-dependent actions show optimistic UI, then confirm. Animations never exceed 250ms. |
| **Simplicity** | One action = one tap. Two-action max for any core flow (open chat → type → send). |
| **Minimalism** | No decorative elements. Every pixel serves hierarchy, readability, or interaction. Generous whitespace. |
| **Progressive Disclosure** | Primary actions visible. Secondary actions behind long-press, swipe, or "..." menus. Advanced features appear naturally — never in tutorials. |
| **Control** | The user always knows where they are, what will happen, and can undo. Destructive actions require confirmation. |

### Information Hierarchy (top → bottom priority)

1. **Content** — message text, media, names
2. **Navigation** — where am I, where can I go
3. **Status** — online, typing, delivery
4. **Actions** — send, reply, forward
5. **Meta** — timestamps, read counts, labels

---

## 2. Screen Map

```
                    ┌──────────────┐
                    │   Welcome    │ (guest only)
                    │   /welcome   │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │    Login     │ (guest only)
                    │    /login    │
                    └──────┬───────┘
                           │ auth success
              ┌────────────▼────────────┐
              │     Chat List (Home)    │
              │        /chat            │
              │  ┌───────────────────┐  │
              │  │   Sidebar         │  │
              │  │  ┌─────────────┐  │  │
              │  │  │ Room List   │  │  │
              │  │  └─────────────┘  │  │
              │  │  ┌─────────────┐  │  │
              │  │  │ Search      │  │  │
              │  │  └─────────────┘  │  │
              │  │  ┌─────────────┐  │  │
              │  │  │ Folder Tabs │  │  │
              │  │  └─────────────┘  │  │
              │  └───────────────────┘  │
              │  ┌───────────────────┐  │
              │  │   Chat Window     │  │
              │  │  ┌─────────────┐  │  │
              │  │  │ Messages    │  │  │
              │  │  └─────────────┘  │  │
              │  │  ┌─────────────┐  │  │
              │  │  │ Input Bar   │  │  │
              │  │  └─────────────┘  │  │
              │  └───────────────────┘  │
              └─────────────────────────┘
                     │          │
          ┌──────────┘          └──────────┐
          ▼                                ▼
   ┌──────────────┐                ┌──────────────┐
   │   Profile    │                │   Settings   │
   │  /profile    │                │  /settings   │
   └──────────────┘                └──────────────┘
          │
          ▼
   ┌──────────────┐
   │ Profile Edit │
   │ /profile/edit│
   └──────────────┘
```

### Overlay / Modal Screens (no route change)

- **Forward Picker** — bottom sheet over chat
- **Media Viewer** — fullscreen overlay
- **Context Menu** — floating popover anchored to message
- **Reaction Picker** — floating emoji row above message
- **New Chat** — modal / pushed screen
- **Group/Channel Creation** — multi-step modal
- **Chat Info** — slide-in panel (right on desktop, pushed screen on mobile)

---

## 3. Design Tokens & Visual Language

### Color Palette (semantic, via CSS vars)

The app uses CSS custom properties mapped to Tailwind. All values below are semantic names — exact RGB tuning happens in `main.css`.

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--background-total-theme` | White (#FFFFFF) | Near-black (#1C1C1E) | Page background |
| `--background-secondary-theme` | Light gray (#F5F5F5) | Dark gray (#2C2C2E) | Cards, panels |
| `--chat-sidebar` | Off-white (#F7F7F8) | Charcoal (#252527) | Sidebar bg |
| `--chat-bubble-own` | Soft teal/green (#E3F9E5) | Dark teal (#1A3A2A) | Own messages |
| `--chat-bubble-other` | White (#FFFFFF) | Dark gray (#2C2C2E) | Others' messages |
| `--chat-input-bg` | Light gray (#F0F0F3) | Dark input (#3A3A3C) | Input field bg |
| `--color-bg-ac` | Calm blue-teal (#3390EC) | Brighter teal (#5EB5F7) | Primary accent |
| `--color-bg-ac-1` | Hover/pressed accent | Hover/pressed accent | Interactive states |
| `--text-color` | Near-black (#1A1A1A) | White (#F0F0F0) | Primary text |
| `--text-on-main-bg-color` | Gray (#8E8E93) | Light gray (#AEAEB2) | Secondary text |
| `--color-txt-ac` | Accent color | Accent color | Links, active labels |
| `--color-good` | Green | Green | Success, online |
| `--color-bad` | Red | Red | Error, destructive |
| `--neutral-grad-0` | Lightest border | Darkest border | Dividers |
| `--neutral-grad-2` | Mid gray | Mid gray | Placeholder text |

### Typography

| Element | Size | Weight | Line Height | Color |
|---------|------|--------|-------------|-------|
| Chat room name | 16px | 600 (semibold) | 22px | `--text-color` |
| Last message preview | 14px | 400 (regular) | 20px | `--text-on-main-bg-color` |
| Message body | 15px | 400 | 21px | `--text-color` |
| Sender name (group) | 14px | 600 | 18px | hash-based accent color |
| Timestamp (message) | 12px | 400 | 16px | `--text-on-main-bg-color` at 70% opacity |
| Timestamp (chat list) | 12px | 400 | 16px | `--text-on-main-bg-color` |
| Unread badge | 12px | 700 (bold) | 1 | White on accent |
| Date separator | 13px | 600 | 18px | `--text-on-main-bg-color` |
| Section header | 14px | 600 | 20px | `--color-txt-ac` |

### Spacing System

Base unit: **4px**. All spacing is multiples of 4.

| Token | Value | Usage |
|-------|-------|-------|
| `xs` | 4px | Micro gaps (icon-to-text inside badge) |
| `sm` | 8px | Inner padding of compact elements |
| `md` | 12px | Standard padding (message content) |
| `lg` | 16px | Section padding, list item padding |
| `xl` | 24px | Major section gaps |
| `2xl` | 32px | Page-level margins |

### Sizing

| Element | Size |
|---------|------|
| Avatar (chat list) | 52px |
| Avatar (chat header) | 40px |
| Avatar (message, group) | 32px |
| Avatar (profile page) | 100px |
| Unread badge | min 20px width, 20px height, pill-shaped |
| Touch target minimum | 44px x 44px |
| Input bar height (collapsed) | 52px |
| Top bar height | 56px |
| Sidebar width (desktop) | 360px |

### Border Radius

| Element | Radius |
|---------|--------|
| Message bubble | 18px (outer corners), 6px (inner corner near tail) |
| Avatar | 50% (circle) |
| Button | 12px |
| Input field | 20px (pill-like) |
| Unread badge | 10px (pill) |
| Card / panel | 12px |
| Floating menu | 14px |
| Media thumbnail | 12px |

### Shadows

| Usage | Value |
|-------|-------|
| Floating menu / context | `0 2px 16px rgba(0,0,0,0.12)` |
| FAB (scroll-to-bottom) | `0 2px 8px rgba(0,0,0,0.15)` |
| Bottom sheet | `0 -2px 16px rgba(0,0,0,0.08)` |
| None in dark theme | Replaced by subtle border `1px solid var(--neutral-grad-0)` |

---

## 4. Screen 1: Chat List (Home)

### Layout Structure

```
┌────────────────────────────────────────┐
│  ☰  Bastyon Chat              🔍  ✏️  │  ← Top Bar (56px)
├────────────────────────────────────────┤
│  All │ Personal │ Groups │ Channels   │  ← Folder Tabs (optional, 40px)
├────────────────────────────────────────┤
│                                        │
│  ┌─ Avatar ──────────────── Time ──┐  │
│  │  Alice Johnson           2:45 PM │  │  ← Room Item (72px)
│  │  Hey, are you free?         (3) │  │
│  └─────────────────────────────────┘  │
│                                        │
│  ┌─ Avatar ──────────────── Time ──┐  │
│  │  📌 Work Team            1:12 PM │  │  ← Pinned indicator
│  │  Bob: Updated the docs     ✓✓  │  │
│  └─────────────────────────────────┘  │
│                                        │
│  ... more rooms ...                    │
│                                        │
└────────────────────────────────────────┘
```

### 4.1 Top Bar

| Element | Position | Behavior |
|---------|----------|----------|
| Hamburger `☰` | Left, 44x44 touch target | Opens side drawer (ChatMenu): Profile, Contacts, Saved Messages, Settings, Logout |
| Title "Bastyon Chat" | Center-left, semibold 18px | Static text. On narrow screens, can truncate or hide |
| Search `🔍` | Right, 44x44 | Toggles search mode (replaces room list with search results) |
| New Chat `✏️` | Far right, 44x44 | Opens New Chat screen (contact picker) |

**Search Mode** (activated by tapping 🔍):

```
┌────────────────────────────────────────┐
│  ←  [  Search chats and messages  ]   │  ← Input replaces top bar
├────────────────────────────────────────┤
│  Recent Searches (if any)              │
│  ────────────────────                  │
│  Chats                                 │
│    Avatar  Alice Johnson               │
│    Avatar  Work Team                   │
│  ────────────────────                  │
│  Messages                              │
│    "meeting tomorrow" in Work Team     │
│    "meeting" in Alice Johnson          │
└────────────────────────────────────────┘
```

- **Behavior**: Incremental search. Starts filtering after 1 character. Debounce: 200ms.
- **Sections**: "Chats" (room name matches), "Contacts" (user matches), "Messages" (content matches).
- **Empty state**: "No results for '[query]'"
- **Back arrow** `←` closes search, restores normal list.

### 4.2 Folder Tabs

Horizontal scrollable row of filter tabs below the top bar. Only visible if user has created custom folders.

| Tab | Filter Logic |
|-----|-------------|
| All | No filter — all rooms |
| Personal | 1:1 direct messages |
| Groups | Rooms with >2 members |
| Channels | Rooms marked as channel (read-only for subscribers) |
| Custom... | User-created folders (e.g., "Work", "Family") |

**Behavior**:
- Tap to filter instantly (no network call — local filter)
- Active tab: accent color underline + accent text
- Inactive tab: `--text-on-main-bg-color`
- Unread dot on tab if any chat in that folder has unread messages
- Horizontal scroll with momentum if tabs overflow
- Long-press on "All" tab → "Edit Folders" (manage custom folders)

### 4.3 Room List Item

Each room item is a **72px tall** row:

```
┌──────────────────────────────────────────────────────────────┐
│  [Avatar 52px]  Name ·······················  Time  12px    │
│                 Preview text ··············  [Badge] / ✓✓   │
└──────────────────────────────────────────────────────────────┘
```

| Element | Details |
|---------|---------|
| **Avatar** | 52px circle. For 1:1: user photo (fallback: colored initials from hash). For groups: group photo or auto-generated mosaic of member avatars (max 4 faces). |
| **Name** | 16px semibold. For 1:1: display name. For groups: room name or "Alice, Bob, Charlie..." |
| **Time** | 12px, right-aligned. Today: "2:45 PM". Yesterday: "Yesterday". This week: "Mon". Older: "Jan 15". Accent color if unread > 0. |
| **Preview** | 14px regular, 1 line max, truncated with "...". Format: "You: message" / "Bob: message" (in groups) / "📷 Photo" / "📄 Document" / "🎤 Voice message". |
| **Unread badge** | Pill, min-width 20px, accent bg, white bold text. Shows count. Muted rooms: gray badge. |
| **Delivery status** (own last msg) | ✓ sent, ✓✓ delivered/read. Shown instead of badge when no unread. |
| **Pinned icon** | Small 📌 next to name if room is pinned. |
| **Muted icon** | Small 🔇 next to name if notifications muted. |
| **Group indicator** | Tiny people-icon overlay on avatar bottom-right for groups. |

**States**:

| State | Visual |
|-------|--------|
| Default | `--background-total-theme` bg |
| Pressed | Darker shade (0.05 opacity overlay) |
| Active (selected room, desktop) | `--color-bg-ac` at 10% opacity bg |
| Swiping | Room slides to reveal action buttons underneath |

### 4.4 Gestures on Room List Items

| Gesture | Action | Visual |
|---------|--------|--------|
| **Tap** | Open chat room | Standard push transition (mobile) or load in chat window (desktop) |
| **Long press** (500ms) | Open context menu | Haptic feedback (mobile). Menu appears as floating popover anchored to item. Slight scale-up (1.02) of the item during hold, then context menu fades in. |
| **Swipe right** (partial, 80px) | Pin / Unpin | Teal bg revealed with 📌 icon. Release to confirm. |
| **Swipe left** (partial, 80px) | Archive | Orange bg revealed with 📦 icon. Release to confirm. |
| **Swipe left** (full, >160px) | Delete | Red bg revealed with 🗑 icon. Release to confirm → shows confirmation dialog. |

### 4.5 Context Menu (Long Press on Room)

Floating popover, 14px radius, shadow, max 6 items:

```
┌─────────────────────────┐
│  📌  Pin to Top          │
│  🔇  Mute Notifications  │
│  📦  Archive              │
│  ✓   Mark as Read        │
│  📁  Move to Folder      │
│  🗑  Delete              │  ← Red text
└─────────────────────────┘
```

- Items 44px tall, full-width touch targets
- Appears with fade-in + slight scale (from 0.95 to 1.0), 150ms
- Tap outside → dismiss with fade-out, 100ms
- Backdrop: semi-transparent overlay (rgba(0,0,0,0.3))
- "Delete" triggers confirmation dialog: "Delete chat with Alice? This will remove the chat for you."

### 4.6 Empty State (No Chats)

```
┌────────────────────────────────────────┐
│                                        │
│         [Chat bubble SVG icon]         │
│                                        │
│        No conversations yet            │   ← 18px semibold
│   Start a chat to begin messaging      │   ← 14px, secondary color
│                                        │
│        [ Start a Chat ]                │   ← Accent button
│                                        │
└────────────────────────────────────────┘
```

### 4.7 Side Drawer (Hamburger Menu)

Slides in from left, 300px wide (or 80% on mobile), with semi-transparent backdrop.

```
┌─────────────────────────────────┐
│  [Avatar 64px]                  │
│  Alice Johnson                  │
│  @alice · online                │
│─────────────────────────────────│
│  👤  Profile                    │
│  👥  Contacts                   │
│  📞  Calls                      │
│  ⭐  Saved Messages             │
│  ⚙️  Settings                   │
│─────────────────────────────────│
│  🌙  Dark Mode         [Toggle] │
│─────────────────────────────────│
│  🚪  Log Out                    │
└─────────────────────────────────┘
```

- Slide-in: 250ms ease-out
- Dismiss: tap backdrop or swipe left
- Dark Mode toggle is a switch — toggles instantly with theme transition

---

## 5. Screen 2: Chat Room

### Layout Structure (Mobile)

```
┌────────────────────────────────────────┐
│  ←  [Avatar 40px] Name     🔍  ⋮     │  ← Header (56px)
│                    typing...           │
├────────────────────────────────────────┤
│                                        │
│         ── January 15, 2025 ──         │  ← Date separator
│                                        │
│  [32]  Bob                             │  ← Sender name (groups)
│  [ava] ┌──────────────────────┐        │
│        │ Hey everyone!        │        │  ← Other's bubble (left)
│        │              10:32 AM│        │
│        └──────────────────────┘        │
│                                        │
│        ┌──────────────────────┐        │
│        │ Check this out       │ [Mine] │  ← Own bubble (right)
│        │     10:33 AM ✓✓      │        │
│        └──────────────────────┘        │
│                                        │
│                   [↓ 3]                │  ← Scroll-to-bottom FAB
│                                        │
├────────────────────────────────────────┤
│  ┌ Reply to Bob ─────────── ✕ ─┐      │  ← Reply bar (if active)
│  │ Hey everyone!                │      │
│  └─────────────────────────────┘      │
│  📎  [  Type a message...      ] 🎤   │  ← Input bar (52px min)
└────────────────────────────────────────┘
```

### Layout Structure (Desktop)

Split view: Sidebar (360px) | Chat Window (remaining width).

### 5.1 Chat Header

| Element | Position | Behavior |
|---------|----------|----------|
| **Back arrow** `←` | Left, 44x44 | Mobile only. Returns to chat list with slide-right transition. |
| **Avatar** | 40px, left of name | Tap → opens Chat Info panel |
| **Room name** | 16px semibold, truncate | Tap → opens Chat Info panel |
| **Subtitle** | 13px, secondary color | 1:1: "online" (green dot) / "last seen 2h ago" / "typing..." (animated). Group: "3 members, 1 online" / "Alice is typing..." |
| **Search** `🔍` | Right | Opens in-chat search bar (replaces header temporarily) |
| **More** `⋮` | Far right | Opens dropdown: Chat Info, Mute, Search, Clear Chat |

**Typing indicator** (replaces subtitle):

- Text: "Alice is typing..." (1:1) or "Alice, Bob are typing..." (group)
- Animated three-dot bounce after name
- Appears with fade-in (150ms), disappears after 5s of no typing signal

### 5.2 Message Area

#### Date Separators

```
         ── Today ──
```

- Centered pill/chip, 13px semibold
- Background: `--background-secondary-theme` at 80% opacity + backdrop-blur(8px)
- Sticky: as you scroll, current date sticks to top of viewport
- Text: "Today", "Yesterday", "Monday", or "January 15, 2025"

#### Message Bubbles

**Own messages** (right-aligned):

```
                    ┌────────────────────────────┐
                    │  Look at this link:         │
                    │  https://example.com        │ ← clickable, accent color
                    │                             │
                    │              2:45 PM ✓✓     │ ← inline timestamp
                    └────────────────────────────┘
```

**Others' messages** (left-aligned, with avatar in groups):

```
[Ava]  Alice Johnson                      ← sender name, colored by hash
       ┌────────────────────────────┐
       │  Sounds good! Let's do it   │
       │                  2:46 PM    │
       └────────────────────────────┘
```

**Bubble styling details**:

| Property | Own | Other |
|----------|-----|-------|
| Background | `--chat-bubble-own` (soft teal/green) | `--chat-bubble-other` (white / dark gray) |
| Alignment | Right | Left |
| Max width | 75% of container | 75% of container |
| Border radius | 18px top-left, 18px top-right, 6px bottom-right, 18px bottom-left | 18px top-left, 18px top-right, 18px bottom-right, 6px bottom-left |
| Sender name | Never shown | Shown in groups, 14px semibold, hash-colored |
| Avatar | Never shown | Shown in groups (32px), only on first message in consecutive sequence |
| Padding | 8px 12px | 8px 12px |

**Consecutive message grouping**:

When same sender sends multiple messages within 1 minute:
- Only first message shows avatar + sender name
- Subsequent messages: reduced top margin (2px vs 8px), no avatar, small radius on connected side
- Creates a visual "cluster"

#### Timestamp Positioning

Timestamps sit **inline at the bottom-right of the message text**. For short messages, the timestamp flows on the same line. For long messages, it wraps to the bottom-right of the last line. Implementation: a transparent `::after` pseudo-element reserves space, and the actual timestamp is positioned absolutely.

#### Delivery Status Icons (own messages only)

| State | Icon | Color |
|-------|------|-------|
| Sending | Clock ⏳ | Gray |
| Sent | Single check ✓ | Gray |
| Delivered | Double check ✓✓ | Gray |
| Read | Double check ✓✓ | Accent blue |
| Failed | Red ⚠ + "Retry" tap | Red |

#### Message Content Types

**Text message**: Rendered with `parseMessage()` — links are clickable (accent color, underline on hover), @mentions are accent-colored bold spans.

**Image**:
```
┌──────────────────────┐
│                      │
│    [Image preview]   │  ← Max 320px wide, maintains aspect ratio
│                      │
│         2:45 PM ✓✓   │  ← Timestamp overlaid on image (white, shadow)
└──────────────────────┘
```
- Tap → opens Media Viewer
- Loading: blurred thumbnail placeholder → sharp image
- Border radius: 12px (on image itself), bubble radius on outer corners

**File**:
```
┌──────────────────────────────┐
│  [📄]  document.pdf          │
│        1.2 MB                │
│                   2:45 PM ✓✓ │
└──────────────────────────────┘
```

**Voice message** (future):
```
┌──────────────────────────────┐
│  ▶  ═══════●═══════  1:32   │
│                   2:45 PM ✓✓ │
└──────────────────────────────┘
```

**Link preview** (future):
```
┌──────────────────────────────┐
│  Check this out:             │
│  ┌────────────────────────┐  │
│  │ [thumbnail]  Title     │  │
│  │              Desc...   │  │
│  │              site.com  │  │
│  └────────────────────────┘  │
│                   2:45 PM ✓✓ │
└──────────────────────────────┘
```

#### Reply Preview (inside bubble)

When a message is a reply to another:

```
       ┌────────────────────────────────┐
       │ ┃ Alice                        │  ← Thin accent bar + sender name
       │ ┃ Hey everyone!                │  ← Quoted text (1 line, truncated)
       │                                │
       │  Yes, I agree completely!      │  ← Actual message
       │                     2:47 PM    │
       └────────────────────────────────┘
```

- Left accent bar: 3px wide, `--color-bg-ac`
- Sender name: 13px semibold, accent color
- Quoted text: 13px regular, secondary color, max 1 line
- Tap on reply preview → scrolls to original message (highlight flash)

#### Forwarded Message

```
       ┌────────────────────────────────┐
       │  ↗ Forwarded from Bob          │  ← 12px, secondary color, italic
       │                                │
       │  The original message text     │
       │  goes here...                  │
       │                     2:47 PM    │
       └────────────────────────────────┘
```

- "Forwarded from [Name]" in secondary color
- Optional: "Forwarded" without sender (privacy option)
- Original content rendered exactly as the message type dictates

#### Reactions Row

Displayed below the bubble content:

```
       ┌────────────────────────────────┐
       │  Message text here...          │
       │                     2:47 PM    │
       ├────────────────────────────────┤
       │  [👍 3] [❤️ 1] [😂 2]          │  ← Reaction pills
       └────────────────────────────────┘
```

Each reaction pill:
- Pill shape: 24px height, 8px horizontal padding, 12px radius
- Contains emoji + count
- Default bg: `--neutral-grad-0`
- Own reaction: accent bg at 15%, accent border
- Tap own reaction → remove it (with shrink animation)
- Tap others' reaction → add your own of that emoji
- Long press reaction pill → show who reacted (bottom sheet with user list)

### 5.3 Scroll-to-Bottom FAB

Appears when user scrolls **more than 300px from bottom**:

```
            ┌────┐
            │ ↓3 │   ← Circle, 44px, shadow
            └────┘
```

- Position: bottom-right of message area, 16px from edge, 16px above input bar
- Background: `--background-secondary-theme`, shadow
- Shows unread count inside if new messages arrived while scrolled up
- Tap → smooth scroll to bottom (300ms)
- Fade-in/out transition: 200ms

### 5.4 Input Bar

#### Default State (empty)

```
┌──────────────────────────────────────────────┐
│  📎   [  Message...                    ]  🎤 │
└──────────────────────────────────────────────┘
```

| Element | Behavior |
|---------|----------|
| **Clip** `📎` | Tap → opens attachment panel |
| **Text input** | Placeholder "Message...", 15px regular. Pill-shaped bg (`--chat-input-bg`), 20px radius. |
| **Mic** `🎤` | When input is empty. Tap → start voice recording (future). |

#### Typing State (has text)

```
┌──────────────────────────────────────────────┐
│  📎   [  Hello, how are you?           ]  ➤  │
└──────────────────────────────────────────────┘
```

| Element | Behavior |
|---------|----------|
| **Send** `➤` | Replaces mic when text is non-empty. Accent bg, white arrow icon, 40px circle. |
| **Transition** | Mic → Send: smooth cross-fade + slight scale, 150ms |

#### Multi-line Expansion

- Input grows from 1 line (22px) to max 6 lines (132px) as user types
- Growth is animated (100ms, ease)
- After 6 lines: internal scroll within input
- Shift+Enter: new line. Button click / Enter (configurable): send.

#### Reply Mode

When replying to a message, a bar appears above the input:

```
┌──────────────────────────────────────────────┐
│  ┃ Alice                                  ✕  │  ← Reply bar
│  ┃ Hey everyone!                             │
├──────────────────────────────────────────────┤
│  📎   [  Type a message...             ]  🎤 │
└──────────────────────────────────────────────┘
```

- Left accent bar: 3px, `--color-bg-ac`
- Sender name: accent color, 13px semibold
- Preview text: secondary color, 13px, max 1 line
- Close `✕`: 24px circle, tap to cancel reply
- Slide-down animation on appear (150ms)
- Focus automatically moves to input

#### Edit Mode

Same as reply bar, but labeled "Editing":

```
┌──────────────────────────────────────────────┐
│  ✏️ Editing                                ✕  │
│  ┃ Original message text...                  │
├──────────────────────────────────────────────┤
│  📎   [  Updated message text          ]  ✓  │  ← Check replaces send
└──────────────────────────────────────────────┘
```

- Input is pre-filled with original text
- Send button becomes a check `✓` (save)

### 5.5 Attachment Panel

Triggered by `📎`. Slides up from bottom as a **bottom sheet** (320px height, drag-dismissible):

```
┌────────────────────────────────────────┐
│  ── drag handle ──                     │
│                                        │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐     │
│  │ 📷  │ │ 📁  │ │ 📍  │ │ 👤  │     │
│  │Photo│ │File │ │Loc. │ │Cont.│     │
│  └─────┘ └─────┘ └─────┘ └─────┘     │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ Recent Photos Grid (3 columns)  │  │
│  │ [img] [img] [img]               │  │
│  │ [img] [img] [img]               │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
```

- Top row: action buttons (64px each, icon + label below)
- Below: recent photos grid (last 12 from gallery), 3 columns
- Tap photo → selected (check overlay), can multi-select
- "Send (N)" button appears when photos selected
- Drag up to expand to full-screen gallery view
- Drag down or tap outside → dismiss

---

## 6. Screen 3: Message Forwarding Flow

### 6.1 Entering Forward Mode

**Trigger**: Long-press message → "Forward" in context menu, or select multiple → forward button in selection bar.

### 6.2 Selection Mode (Multi-Message)

When user long-presses a message:

```
┌────────────────────────────────────────┐
│  ← Selected: 3        Forward  Delete  │  ← Selection bar (56px)
├────────────────────────────────────────┤
│                                        │
│  [✓]  ┌──────────────────────┐         │
│       │ Message 1             │         │  ← Selected (check + highlight)
│       └──────────────────────┘         │
│                                        │
│  [ ]  ┌──────────────────────┐         │
│       │ Message 2             │         │  ← Not selected
│       └──────────────────────┘         │
│                                        │
│  [✓]  ┌──────────────────────┐         │
│       │ Message 3             │         │  ← Selected
│       └──────────────────────┘         │
│                                        │
└────────────────────────────────────────┘
```

**Selection bar** replaces the chat header:
- Left: `←` (cancel selection) + "Selected: N"
- Right: action buttons — Forward `↗`, Copy `📋`, Delete `🗑`

**Behavior**:
- Each message gets a circular checkbox on the left
- Tap any message to toggle selection
- Selected messages get a subtle accent bg overlay (5% opacity)
- Selection count updates live

### 6.3 Forward Chat Picker

After tapping "Forward", a **bottom sheet** slides up (90% screen height) or a **full-screen modal** on mobile:

```
┌────────────────────────────────────────┐
│  Forward to...                    Done │  ← Header
├────────────────────────────────────────┤
│  [  Search chats...                  ] │  ← Search input
├────────────────────────────────────────┤
│  ─── Recent ───                        │
│                                        │
│  [✓] Avatar  Saved Messages            │  ← "Saved Messages" always first
│  [ ] Avatar  Alice Johnson             │
│  [ ] Avatar  Work Team                 │
│  [ ] Avatar  Bob Smith                 │
│  [ ] Avatar  Family Group              │
│                                        │
│  ─── All Chats ───                     │
│  ... (full room list)                  │
│                                        │
├────────────────────────────────────────┤
│  Forwarding 3 messages                 │
│  [ ] Forward without sender info       │  ← Privacy checkbox
│  [       Send        ]                 │  ← Accent button, full-width
└────────────────────────────────────────┘
```

**Behavior**:
- **Multi-select**: can choose multiple target chats (circular checkboxes)
- **Search**: filters chats incrementally
- **"Saved Messages"** always appears first (personal notes)
- **Selected chips**: chosen chats appear as horizontal chips below search bar
- **Privacy option**: "Forward without sender info" — hides original author
- **Send button**: "Send to N chats" — disabled until at least 1 chat selected
- Tap "Send" → messages forwarded to all selected chats → toast "Forwarded to N chats" → sheet dismissed

### 6.4 Forwarded Message Display

In the target chat:

```
┌──────────────────────────────────────┐
│  ↗ Forwarded from Alice Johnson      │  ← 12px italic, secondary text
│  ─────────────────────────           │
│  The original message content here.  │
│                                      │
│  [image thumbnail if media]          │
│                           3:12 PM ✓✓ │
└──────────────────────────────────────┘
```

- "Forwarded from [Name]" with `↗` icon, lighter color
- If "without sender info": just "Forwarded message"
- Thin separator line between forward header and content
- Media: shown as thumbnails inline
- Multiple forwarded messages: each gets its own bubble (not merged)

---

## 7. Screen 4: Context Actions on Messages

### 7.1 Long-Press Context Menu

Triggered by **500ms long press** on any message. The menu appears as a floating card above/below the message (whichever has more space), with a subtle blur-and-dim backdrop.

**Animation**: The message slightly lifts (translateY: -2px, scale: 1.02), and the menu fades in from 0.95 scale → 1.0 scale, 150ms.

```
                    ┌──────────────────┐
                    │ 👍❤️😂😮😢🔥 [+]  │  ← Quick reaction row
                    ├──────────────────┤
                    │  ↩️  Reply        │
                    │  📋  Copy         │
                    │  ↗️  Forward      │
                    │  📌  Pin          │
                    │  ✏️  Edit         │  ← Only for own messages
                    │  🗑  Delete       │  ← Red text
                    └──────────────────┘
```

**Reaction row** (top):
- 6 quick emojis: 👍 ❤️ 😂 😮 😢 🔥
- Each is 36px circle, slight bounce on tap
- `[+]` opens full emoji picker (bottom sheet with emoji grid)
- Tap emoji → reaction applied → menu dismissed → reaction pill appears on message

**Menu items** (44px height each):

| Action | Availability | Behavior |
|--------|-------------|----------|
| **Reply** | Always | Sets reply mode in input bar, scrolls to bottom, focuses input |
| **Copy** | Text messages | Copies text to clipboard, toast "Copied to clipboard" |
| **Forward** | Always | Opens Forward Chat Picker (Section 6.3) |
| **Pin** | Groups (admin) | Pins message to top of chat. Confirmation if replacing existing pin. |
| **Edit** | Own messages, within 48h | Opens edit mode in input bar |
| **Select** | Always | Enters multi-select mode with this message pre-selected |
| **Delete** | Own messages / admin | Sub-menu: "Delete for me" / "Delete for everyone" |

**Delete sub-options**:
```
┌───────────────────────────────┐
│  Delete message?              │
│                               │
│  ○ Delete for me              │
│  ○ Delete for everyone        │  ← Only if own message & within time limit
│                               │
│  [Cancel]         [Delete]    │  ← Delete in red
└───────────────────────────────┘
```

### 7.2 Swipe-to-Reply

**Gesture**: Swipe message **right** (from left edge of bubble toward right).

**Behavior**:
- At 40px swipe distance: reply arrow icon appears, low opacity
- At 80px: icon fully visible, haptic feedback
- Release at >60px: reply mode activated
- Release at <60px: spring back to original position

**Animation**: The message shifts right following the finger, with a reply `↩️` icon anchored behind it. On release, the message springs back (200ms, spring easing) and the reply bar slides down above the input.

### 7.3 Double-Tap to React (optional gesture)

Double-tap on a message → applies ❤️ reaction (default quick reaction). Second double-tap removes it.

- Visual: brief heart pop animation on the message (scale 0→1.2→1.0, 300ms)

---

## 8. Screen 5: Groups & Channels

### 8.1 Group Chat

**Header subtitle**: "N members, M online" or "Alice is typing..."

**Group-specific elements**:
- Sender name + avatar on messages from others (color-coded by hash)
- Admin badge next to admin names
- Pinned message bar at top (below header)

#### Pinned Message Bar

```
┌────────────────────────────────────────┐
│  📌  Bob: Updated project docs         │  ← 1 line, truncate
│       ▲▼ 1 of 3 pinned                │  ← Navigation (if multiple)
└────────────────────────────────────────┘
```

- Tap → scrolls to pinned message (or opens pinned message list if multiple)
- `▲▼` arrows to navigate between pinned messages
- Thin accent left border

#### Group Info Panel (slide-in or pushed screen)

```
┌────────────────────────────────────────┐
│  [Group Avatar 100px]                  │
│  Work Team                             │
│  Group · 12 members                    │
├────────────────────────────────────────┤
│  🔔  Notifications         [On/Off]    │
│  🔍  Search in Chat                    │
├────────────────────────────────────────┤
│  📷  Photos (24)          >            │  ← Shared media
│  📄  Files (8)            >            │
│  🔗  Links (15)           >            │
├────────────────────────────────────────┤
│  Members (12)             >            │
│  [Ava] Alice (admin)                   │
│  [Ava] Bob                             │
│  [Ava] Charlie                         │
│  ... Show all                          │
├────────────────────────────────────────┤
│  🗑  Leave Group                       │  ← Red text
└────────────────────────────────────────┘
```

#### Admin Capabilities

| Action | Access |
|--------|--------|
| Edit group name/photo | Group settings |
| Pin/unpin messages | Context menu on message |
| Remove member | Long-press on member in member list |
| Set admin | Long-press on member → "Make Admin" |
| Delete others' messages | Context menu → "Delete for everyone" |
| Mute member | Long-press on member → "Restrict" |

### 8.2 Channels

Channels are rooms with **one-way communication** (only admins post).

**Subscriber view**:
- Messages shown without input bar (read-only)
- Each post shows view count: "👁 1.2K" below the message
- Reactions available (tap to react)
- Bottom bar: "Join Channel" (if not member) or "[Muted 🔇] [Share ↗]"

**Admin/Owner view**:
- Input bar available (same as regular chat)
- "Schedule" button in attachment panel → date/time picker for delayed post
- Post stats: views, reactions, forwards count

**Channel Info Panel**:
```
┌────────────────────────────────────────┐
│  [Channel Avatar 100px]               │
│  Tech News                             │
│  Channel · 1.2K subscribers            │
├────────────────────────────────────────┤
│  ℹ️  About: Daily tech updates...      │
├────────────────────────────────────────┤
│  🔔  Notifications         [On/Off]    │
├────────────────────────────────────────┤
│  📷  Photos (120)          >           │
│  📄  Files (45)            >           │
│  🔗  Links (89)            >           │
├────────────────────────────────────────┤
│  Subscribers (1,234)       >           │
├────────────────────────────────────────┤
│  🗑  Leave Channel                     │
└────────────────────────────────────────┘
```

---

## 9. Screen 6: Profile & Settings

### 9.1 Own Profile

```
┌────────────────────────────────────────┐
│  ←           Profile           ✏️ Edit │
├────────────────────────────────────────┤
│                                        │
│           [Avatar 100px]               │
│           Alice Johnson                │
│           @alice_j                     │
│           "Available for chat"         │  ← Status/bio
│                                        │
├────────────────────────────────────────┤
│  📱  +7 (999) 123-4567                 │  ← Phone (tap to copy)
│  @   alice_j                           │  ← Username (tap to copy)
│  ℹ️  Bio: Software developer at...     │
├────────────────────────────────────────┤
│  🔔  Notifications                  >  │
│  🔒  Privacy & Security             >  │
│  🎨  Appearance                      >  │
│  💾  Data & Storage                  >  │
└────────────────────────────────────────┘
```

### 9.2 Other User's Profile

Accessed by tapping avatar/name in chat or contact list:

```
┌────────────────────────────────────────┐
│  ←         Bob Smith                   │
├────────────────────────────────────────┤
│                                        │
│           [Avatar 100px]               │
│           Bob Smith                    │
│           last seen 2 hours ago        │
│                                        │
│  [ 💬 Message ]  [ 📞 Call ]           │  ← Action buttons
│                                        │
├────────────────────────────────────────┤
│  @   bob_smith                         │
│  ℹ️  Bio: Designer, coffee lover       │
├────────────────────────────────────────┤
│  🔔  Notifications          [On/Off]   │
│  📷  Shared Media                   >  │
├────────────────────────────────────────┤
│  🚫  Block User                        │  ← Red
│  ⚠️  Report                            │
└────────────────────────────────────────┘
```

### 9.3 Settings

```
┌────────────────────────────────────────┐
│  ←           Settings                  │
├────────────────────────────────────────┤
│  Account                               │
│    Phone number, username, bio          │
├────────────────────────────────────────┤
│  Privacy & Security                    │
│    Last seen, profile photo, read      │
│    receipts, two-step verification     │
├────────────────────────────────────────┤
│  Notifications & Sounds               │
│    Private chats, groups, channels     │
│    In-app sounds, vibration            │
├────────────────────────────────────────┤
│  Appearance                            │
│    Theme (Light/Dark/System)           │
│    Chat wallpaper                      │
│    Accent color                        │
│    Font size (slider)                  │
│    Animation speed (slider)            │
├────────────────────────────────────────┤
│  Data & Storage                        │
│    Auto-download media                 │
│    Storage usage, cache clear          │
├────────────────────────────────────────┤
│  Chat Folders                          │
│    Create, edit, reorder folders       │
├────────────────────────────────────────┤
│  Language                              │
│    App language selection              │
├────────────────────────────────────────┤
│  About                                 │
│    Version, licenses, feedback         │
└────────────────────────────────────────┘
```

### 9.4 Appearance / Theming

```
┌────────────────────────────────────────┐
│  ←        Appearance                   │
├────────────────────────────────────────┤
│  Theme                                 │
│  ┌──────┐ ┌──────┐ ┌──────┐           │
│  │ ☀️   │ │ 🌙   │ │ 📱   │           │
│  │Light │ │ Dark │ │ Auto │           │
│  └──────┘ └──────┘ └──────┘           │
├────────────────────────────────────────┤
│  Accent Color                          │
│  ● ● ● ● ● ● ●                        │  ← 7 color options (Telegram-style)
│  Blue Teal Green Orange Pink Purple Red │
├────────────────────────────────────────┤
│  Chat Wallpaper                        │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐          │
│  │None│ │Grad│ │Pat1│ │Pat2│          │  ← Wallpaper presets
│  └────┘ └────┘ └────┘ └────┘          │
│  [ Choose from Gallery ]               │
├────────────────────────────────────────┤
│  Font Size            [——●——]  15px    │  ← Slider: 13-19px
│  Message corners      [Round/Square]   │
├────────────────────────────────────────┤
│  Preview:                              │
│  ┌──────────────────────────────────┐  │
│  │  [Mock chat bubble preview]      │  │  ← Live preview of settings
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
```

- **7 accent colors**: Calm Blue, Teal, Forest Green, Warm Orange, Rose Pink, Violet Purple, Coral Red
- Each changes `--color-bg-ac` and related vars
- **Live preview**: shows a mock chat with 2-3 bubbles using current settings
- Changes apply **immediately** (no save button needed)

---

## 10. Screen 7: Media Viewer

Triggered by tapping an image/video in chat.

### Layout

```
┌────────────────────────────────────────┐
│  ←   Alice Johnson · Jan 15   ⋮  ↗    │  ← Header (fades in/out on tap)
│                                        │
│                                        │
│                                        │
│          [Full-screen image]           │
│                                        │
│                                        │
│                                        │
│  ◄ ●●●○○ ►                            │  ← Page indicator (if gallery)
│                                        │
│  [Caption text if any]                 │  ← Bottom overlay
└────────────────────────────────────────┘
```

### Behavior

| Gesture | Action |
|---------|--------|
| **Tap** | Toggle header/footer visibility |
| **Pinch** | Zoom in/out (min 1x, max 5x) |
| **Double-tap** | Toggle between 1x and 2x zoom |
| **Swipe left/right** | Navigate to next/previous media in chat |
| **Swipe down** (from 1x zoom) | Dismiss viewer (image shrinks back to chat bubble) |
| **Pan** (when zoomed) | Pan around zoomed image |

### Transitions

- **Open**: Image thumbnail in chat animates to full-screen position (shared element transition, 300ms, ease-out). Background fades to black.
- **Close** (swipe down): Image shrinks and translates back to original position in chat. Background fades from black.
- **Close** (back button): Fade out, 200ms.

### Header actions

| Button | Action |
|--------|--------|
| `←` | Close viewer |
| Sender name + date | Context info |
| `↗` | Forward this media |
| `⋮` | Save to device, Share, Delete |

### Video (future)

- Plays inline in chat (auto-play muted for GIFs/short clips)
- In viewer: full controls (play/pause, scrub, fullscreen, volume)
- Loading: progress ring on play button

---

## 11. Micro-animations & Transitions

### General Rules

| Property | Value |
|----------|-------|
| Default duration | 200ms |
| Short (state change) | 150ms |
| Medium (layout shift) | 250ms |
| Long (page transition) | 300ms |
| Easing (enter) | ease-out / cubic-bezier(0.25, 0.46, 0.45, 0.94) |
| Easing (exit) | ease-in |
| Easing (spring) | cubic-bezier(0.175, 0.885, 0.32, 1.275) |

### Specific Animations

#### Page Transitions

| Transition | Animation |
|-----------|-----------|
| Chat List → Chat Room (mobile) | Chat window slides in from right (300ms). Chat list stays in place (parallax: slight left shift). |
| Chat Room → Chat List (mobile) | Chat window slides out to right (250ms). |
| Chat List ↔ Chat Room (desktop) | No transition — split view, content loads in right panel. |
| Any → Profile/Settings | Slide up from bottom (300ms) or push from right. |

#### Message Animations

| Event | Animation |
|-------|-----------|
| New message (own, sending) | Bubble slides up from input bar area, slight scale 0.95→1.0 (200ms) |
| New message (received) | Bubble fades in + slides from left (150ms) |
| Message deleted | Bubble shrinks (scale 1.0→0.8) + fade out (200ms), then space collapses (250ms, ease) |
| Reaction added | Emoji pops in with spring scale (0→1.2→1.0, 250ms) |
| Reaction removed | Emoji shrinks + fades (150ms) |

#### Input Bar Animations

| Event | Animation |
|-------|-----------|
| Mic → Send button | Cross-fade + slight rotation (150ms) |
| Reply bar appears | Slide down from above input (150ms, ease-out) |
| Reply bar dismissed | Slide up + fade (100ms) |
| Input grows (multiline) | Height expands smoothly (100ms, ease) |
| Input shrinks | Height reduces smoothly (100ms, ease) |

#### Micro-interactions

| Element | Animation |
|---------|-----------|
| Send button tap | Brief scale pulse (1.0→0.9→1.0, 100ms) |
| Heart reaction (double-tap) | Heart emoji scales 0→1.3→1.0 with slight bounce, 300ms |
| Checkbox (select message) | Scale 0→1.1→1.0 with check drawing animation, 200ms |
| Unread badge appears | Pop-in with spring (scale 0→1.1→1.0), 200ms |
| Unread badge disappears | Shrink + fade (scale 1.0→0, opacity 1→0), 150ms |
| Typing indicator dots | Three dots bounce sequentially (each 300ms, 100ms offset) |
| Pull-to-refresh | Spinner rotates in, list content shifts down (250ms) |
| Swipe-to-reply spring | On release: spring back (cubic-bezier(0.175, 0.885, 0.32, 1.275), 250ms) |
| Context menu open | Scale 0.95→1.0 + fade 0→1 from touch point origin (150ms) |
| Context menu close | Fade out (100ms) |
| Bottom sheet open | Slide up + backdrop fade in (250ms) |
| Bottom sheet close | Slide down + backdrop fade out (200ms) |
| Toast notification | Slide down from top + fade in (200ms), auto-dismiss after 3s with fade up (200ms) |

#### Skeleton Loading

While data loads:
- Chat list: gray pulsing rectangles mimicking avatar + 2 text lines
- Message area: gray pulsing bubbles (3-4 varying widths)
- Pulse animation: opacity 0.4→0.7→0.4, 1.5s infinite

---

## 12. Onboarding & Progressive Disclosure

### 12.1 Registration Flow

Minimal steps — no more than 4 screens:

```
Step 1: Welcome           Step 2: Verify        Step 3: Profile        Step 4: Done
┌──────────────┐         ┌──────────────┐       ┌──────────────┐      ┌──────────────┐
│              │         │              │       │              │      │              │
│  [Logo]      │         │  Enter code  │       │  [Tap to add │      │  ✓ All set!  │
│              │         │  sent to     │       │   photo]     │      │              │
│  Bastyon Chat│         │  +7(999)***  │       │              │      │  Your chats  │
│              │         │              │       │  Your name:  │      │  are ready.  │
│  [Phone/ID   │         │  [● ● ● ● ] │       │  [Alice    ] │      │              │
│   input    ] │         │              │       │              │      │  [Start ➤]   │
│              │         │  Resend (29) │       │  [Continue]  │      │              │
│  [Continue]  │         │              │       │              │      │              │
└──────────────┘         └──────────────┘       └──────────────┘      └──────────────┘
```

- **Step 1**: Single input field (phone, email, or Bastyon address). Large "Continue" button. Logo + tagline above.
- **Step 2**: 4-6 digit code. Auto-submit when all digits entered. "Resend" countdown timer. Keyboard opens automatically.
- **Step 3**: Name (required) + photo (optional). Photo: tap placeholder circle → camera/gallery picker. "Skip" link if no photo.
- **Step 4**: Confirmation. "Start" goes directly to chat list.

**No tutorials. No feature tours.** The user lands in the chat list immediately.

### 12.2 Progressive Disclosure of Features

Features are discovered organically through interaction, not through tutorials:

| Feature | Discovery Method |
|---------|-----------------|
| **Swipe actions** | First time: subtle "swipe" arrow hint appears briefly on first chat item (one-time, 2s) |
| **Long-press menu** | No hint needed — universal pattern. If user hasn't long-pressed after 5 sessions, a one-time tooltip: "Long press for more options" |
| **Reactions** | Quick-reaction row appears naturally in context menu. Users see others' reactions on messages. |
| **Folders** | Not shown until user has 10+ chats. Then: one-time "Organize with folders" suggestion in side drawer |
| **Reply by swipe** | After user uses "Reply" from context menu 3 times, show brief "Tip: swipe right to reply quickly" toast |
| **Forward** | Discovered naturally via context menu |
| **Pin messages** | Only visible in group admin context menus |
| **Scheduled messages** | Only visible in channel admin interface |

### 12.3 Empty States

Every screen has a meaningful empty state:

| Screen | Empty State |
|--------|-------------|
| Chat list | Chat bubble icon + "No conversations yet" + "Start a Chat" button |
| Search results | "No results for '[query]'" |
| Chat (no messages) | "This is the start of your conversation with [Name]" |
| Saved Messages | Bookmark icon + "Save messages here for quick access" |
| Media gallery | "No shared media yet" |
| Contacts | "No contacts yet" + "Invite friends" button |

---

## 13. UX Scenarios

### Scenario 1: Send a Text Message

```
1. User opens app → Chat List shown (last state restored)
2. User taps "Alice Johnson" row
   → Chat room slides in (mobile) / loads in right panel (desktop)
   → Messages load from cache, then sync with server
   → Input bar focuses
3. User types "Hey, how's it going?"
   → Mic button cross-fades to Send button (150ms)
   → Input expands if multi-line
4. User taps Send button
   → Send button pulses briefly (100ms)
   → Message bubble appears at bottom with "sending" clock icon
   → Text input clears, shrinks to 1 line
   → Bubble updates: clock → ✓ (sent) → ✓✓ (delivered)
5. Reply arrives from Alice
   → New bubble slides in from left (150ms)
   → Scroll auto-adjusts to show new message (if near bottom)
   → If scrolled up: scroll-to-bottom FAB shows with unread count
```

### Scenario 2: Forward a Message

```
1. User long-presses a message in chat
   → Message lifts slightly (2px up, scale 1.02)
   → Context menu appears with fade-in (150ms)
   → Quick reaction row at top, action list below
2. User taps "Forward"
   → Context menu dismisses
   → Forward Picker bottom sheet slides up (250ms)
3. User sees recent chats, types "Work" in search
   → List filters to show "Work Team" and "Work Chat"
4. User taps "Work Team" (checkbox appears)
   → Chip "Work Team" appears below search bar
5. User optionally checks "Forward without sender info"
6. User taps "Send"
   → Sheet dismisses (200ms)
   → Toast: "Forwarded to Work Team" (3s)
   → In Work Team: forwarded message appears with "↗ Forwarded" header
```

### Scenario 3: Reply to a Message

**Method A — Context Menu:**
```
1. User long-presses a message
2. User taps "Reply" in context menu
   → Reply bar slides down above input (150ms)
   → Shows: accent bar | sender name | message preview | ✕
   → Input bar auto-focuses
3. User types reply text and taps Send
   → Reply bar dismisses
   → New message appears with reply preview inside bubble
```

**Method B — Swipe Gesture:**
```
1. User swipes a message to the right (>60px)
   → Reply arrow icon revealed behind message
   → Haptic feedback at 80px threshold
2. User releases finger
   → Message springs back (250ms)
   → Reply bar slides down above input
   → Rest same as Method A step 3
```

### Scenario 4: Create a Group

```
1. User taps ✏️ (New Chat) in top bar
   → New Chat screen appears
2. User taps "New Group"
   → Contact picker: "Add Members"
   → Search bar + scrollable contact list with checkboxes
3. User selects 3 contacts → "Next"
   → Group setup: name input + optional photo
4. User types "Weekend Plans", taps "Create"
   → Group created
   → Navigates to new group chat
   → System message: "You created the group 'Weekend Plans'"
```

### Scenario 5: Change Theme

```
1. User opens Side Drawer (☰)
2. User taps "Settings"
   → Settings page pushes in
3. User taps "Appearance"
   → Appearance page pushes in
4. User taps "Dark" theme option
   → Theme switches immediately (200ms crossfade on all elements)
   → Preview area updates live
5. User taps a different accent color circle
   → Accent color changes immediately across preview
6. User navigates back
   → All changes already saved (no explicit save needed)
```

### Scenario 6: Search Messages

```
1. From Chat List: user taps 🔍
   → Search input replaces top bar, keyboard opens
   → User types "meeting notes"
   → Results appear in sections: Chats | Messages
   → Under "Messages": shows chat name + matched line + date

2. From Chat Room: user taps 🔍 in header
   → Search bar slides down below header
   → User types "deadline"
   → Chat scrolls to first match, highlighted in yellow
   → Up/Down arrows to navigate between matches
   → "3 of 7 results" counter
   → Tap result to jump to message in context
```

---

## 14. Component State Reference

### Buttons

| State | Visual |
|-------|--------|
| Default | Accent bg, white text, 12px radius |
| Hover (desktop) | 8% darker bg |
| Pressed | 15% darker bg, slight scale 0.97 |
| Disabled | 50% opacity, no interaction |
| Loading | Text replaced with spinner (centered) |

### Input Fields

| State | Visual |
|-------|--------|
| Empty | Placeholder text in `--neutral-grad-2` |
| Focused | Subtle accent border (1px), no bg change |
| Filled | Normal text color, no border |
| Error | Red border, red helper text below |
| Disabled | 50% opacity, gray bg |

### Avatar

| State | Visual |
|-------|--------|
| Photo loaded | Circular image, cover fit |
| Loading | Gray circle with pulse animation |
| No photo | Colored bg (hash-based from 7 Telegram-style colors) + white initials (1-2 chars) |
| Online indicator | Small green dot (12px) at bottom-right of avatar, white border 2px |

### Room List Item

| State | Visual |
|-------|--------|
| Default | Transparent bg |
| Hovered (desktop) | `--background-secondary-theme` bg |
| Pressed | Slightly darker bg (0.05 overlay) |
| Active/Selected | `--color-bg-ac` at 10% opacity bg |
| Unread | Bold room name, accent timestamp, badge visible |
| Muted + Unread | Normal weight name, gray badge (not accent) |
| Pinned | 📌 icon next to name, sorted to top |

### Message Bubble

| State | Visual |
|-------|--------|
| Sending | Clock icon, slightly reduced opacity (0.7) |
| Sent | Single gray check |
| Delivered | Double gray checks |
| Read | Double accent checks |
| Failed | Red warning icon + "Retry" text (tap to resend) |
| Selected (multi-select mode) | Accent bg overlay (5%), checkbox visible |
| Highlighted (from search/reply-jump) | Brief yellow flash (500ms fade) |

### Placeholder Texts

| Element | Text |
|---------|------|
| Chat list search | "Search chats and messages..." |
| In-chat search | "Search in this chat..." |
| Message input | "Message..." |
| Message input (channel, admin) | "Broadcast a message..." |
| Group name input | "Group name" |
| Bio input | "About you" |
| Forward search | "Search chats..." |
| Contact search | "Search contacts..." |

---

## 15. Accessibility & Edge Cases

### Accessibility

| Concern | Solution |
|---------|----------|
| Touch targets | Minimum 44x44px for all interactive elements |
| Color contrast | All text meets WCAG AA (4.5:1 for body, 3:1 for large text) |
| Screen readers | All icons have `aria-label`. Messages announce: sender, content, time, status. |
| Reduced motion | `prefers-reduced-motion: reduce` → disable all animations, use instant transitions |
| Keyboard nav (desktop) | Tab through rooms, Enter to open, Escape to go back, Up/Down for messages |
| Font scaling | All text uses relative units, respects system font size setting |
| Focus indicators | Visible focus ring (2px accent outline, 2px offset) on all focusable elements |

### Edge Cases

| Case | Handling |
|------|----------|
| Very long message | Wraps naturally. No collapse/expand for text. Max bubble width 75%. |
| Very long name | Truncate with "..." at container edge |
| Offline | Banner at top: "Waiting for connection..." (yellow bg). Messages queued locally. |
| Slow network | Optimistic UI: message appears immediately with clock. If send fails after 30s, show retry. |
| 100+ unread | Badge shows "99+" |
| Empty chat list | Empty state with "Start a Chat" CTA |
| Deleted message | "This message was deleted" placeholder in italic gray |
| Unknown message type | "Unsupported message. Update the app to view." |
| Large images | Thumbnail shown first (blurred), progressive load to full resolution |
| Long file names | Truncate middle: "very-long-file-name-th...at-I-need.pdf" |
| RTL languages | Full RTL layout support (mirrored) |
| Simultaneous typing (group) | "Alice, Bob are typing..." (max 2 names + "and N others") |
| Failed media upload | Red overlay on thumbnail + retry button |
| Push notification tap | Opens specific chat, scrolls to unread |
