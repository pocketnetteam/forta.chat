# Youth Chat Pack — Design Document

## Goal
Make Bastyon Chat more appealing to younger audiences by adding modern messaging features found in Telegram, Discord, iMessage, and Gboard.

## Features

### 1. Emoji Kitchen
- **Location:** Bottom bar in EmojiPicker — after selecting first emoji, shows horizontal strip of available combinations
- **Library:** `emoji-kitchen-mart` (npm) — lookup for all 14k+ Google combinations
- **Send format:** PNG sticker via Matrix image message (m.image with sticker flag)
- **UX flow:** Select emoji → combination strip appears → tap combo → sends as sticker
- **Fallback:** If no combination exists for the pair, strip stays hidden

### 2. GIF Search (Tenor v2)
- **Location:** Tab in unified picker (Emoji | Stickers | GIF)
- **API:** Tenor v2 REST API, free key
- **UI:** Search input + 2-column masonry grid with lazy-loaded previews. Trending GIFs shown on open
- **Send format:** Matrix image message with animated GIF URL or downloaded blob
- **Caching:** Recent/favorite GIFs stored in localStorage

### 3. Fullscreen Animated Reactions
- **Trigger:** When any user sends a reaction, fullscreen effect plays over chat (1-2 seconds)
- **Reaction mapping:**
  - ❤️ → floating hearts rising from bottom
  - 🔥 → flame particles from bottom edge
  - 🎉 → confetti falling from top
  - 👍 → large thumb bouncing in center
  - 😂 → falling laughing emojis
  - Default → enlarged emoji with burst particles
- **Implementation:** CSS animations + requestAnimationFrame, no canvas needed
- **Toggle:** `animatedReactions` setting in themeStore (default: ON)
- **Performance:** Auto-disable on low-end devices (check navigator.hardwareConcurrency)

### 4. Built-in Sticker Packs
- **Location:** "Stickers" tab in unified picker
- **Packs:** 3-5 pre-installed (memes, cats, emotions, anime-style). ~50 stickers per pack
- **Storage:** WebP assets in `public/stickers/{pack-name}/`
- **Manifest:** `public/stickers/manifest.json` with pack metadata (name, icon, list of files)
- **Send format:** Matrix image message with sticker content type
- **Display:** Rendered larger than regular images, no bubble background (like Telegram stickers)

### 5. Typing Bubble (Wave Animation)
- **Location:** Inside MessageList, shown as pseudo-message before last message
- **Animation:** 3 dots with wave delay (0ms, 150ms, 300ms), scale + opacity pulse
- **Data source:** Matrix typing events (already available via SDK)
- **Shows:** Avatar + sender name (in groups) + animated dots
- **Auto-hide:** After 5s timeout if no new typing event received

## Architecture

### Modified Files
| File | Changes |
|------|---------|
| `EmojiPicker.vue` | Refactor to tabbed layout (emoji/stickers/GIF), add Emoji Kitchen bar |
| `MessageInput.vue` | Update picker integration for unified tabbed picker |
| `MessageBubble.vue` | Render stickers/kitchen results as borderless enlarged images |
| `MessageList.vue` | Add TypingBubble component at bottom |
| `ReactionRow.vue` | Trigger fullscreen effect on reaction toggle |
| `themeStore` | Add `animatedReactions` setting |
| `chat-store.ts` | Expose typing users for active room |
| `use-messages.ts` | Add sendSticker/sendGif helpers |

### New Files
| File | Purpose |
|------|---------|
| `GifPicker.vue` | Tenor search UI with grid |
| `StickerPicker.vue` | Sticker pack tabs and grid |
| `EmojiKitchenBar.vue` | Horizontal combination suggestions strip |
| `ReactionEffect.vue` | Fullscreen reaction animations (teleported to body) |
| `TypingBubble.vue` | Wave-animated typing indicator |
| `shared/lib/tenor.ts` | Tenor API client |
| `shared/lib/emoji-kitchen.ts` | Emoji Kitchen lookup wrapper |
| `shared/lib/sticker-packs.ts` | Sticker manifest loader |

### Dependencies
- `emoji-kitchen-mart` — Emoji Kitchen combination lookup (~2MB)
- No new dependencies for Tenor (plain fetch)
- No new dependencies for animations (pure CSS + JS)

## Sticker Assets
Sticker packs need to be sourced/created. Options:
- Use open-source/CC0 sticker packs
- Commission custom packs
- Placeholder packs for initial implementation

## API Keys
- Tenor v2 API key needed (free tier, no rate limits for non-commercial)
- Store in environment variable `VITE_TENOR_API_KEY`
