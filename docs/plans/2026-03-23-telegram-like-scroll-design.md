# Telegram-like Smooth Chat Scroll Design

## Problem

When scrolling up in chat, the current implementation shows visible loaders/skeletons, causes scroll jumps, and creates a jarring UX. Messages should load seamlessly in the background.

## Root Causes

1. **Data path mismatch**: `loadMoreMessages()` writes to `messages.value` (shallowRef) but `activeMessages` reads from Dexie liveQuery — scrollback data never reaches UI
2. **Double scroll correction**: Virtua `shift` mode + manual `scrollTop += delta` fight each other
3. **liveQuery re-subscription resets isReady**: causes skeleton flash during pagination
4. **Fake prefetch**: `doPrefetch` calls `loadMoreMessages` (network), not actual cache fill
5. **Visible spinner** at index 0 during `loadingMore`

## Architecture: Three-Tier Message Pipeline

```
TIER 1: DISPLAY — activeMessages ← Dexie liveQuery (messageWindowSize limit)
TIER 2: CACHE — all messages ever loaded in Dexie (expandMessageWindow reads from here)
TIER 3: NETWORK — Matrix scrollback (only when Dexie exhausted)
```

## Changes Made

### Phase 0: Hotfix
- Removed spinner at index 0
- Skeleton only during initial room load (not pagination)
- `useLiveQuery` no longer resets `isReady` on re-subscription
- Added Dexie dual-write to `loadMoreMessages`

### Phase 1: Incremental Background Prefetch (Telegram-like)
- `prefetchNextBatch()` — fetches 25 messages from Matrix, writes ONLY to Dexie (no UI)
- Called after room load + after each scroll-up expand → always one batch ahead
- `doLoadMore` → `expandMessageWindow()` reads from local Dexie cache (instant)
- If cache empty (prefetch hasn't arrived) → network fallback as safety net
- After each expand → fire-and-forget `prefetchNextBatch` for next scroll-up
- Virtua shift mode permanently disabled — manual scrollTop correction via ResizeObserver
- Scroll events suppressed during pagination to prevent jitter

### Phase 2: Velocity-Adaptive Load Thresholds
- Dynamic load threshold based on scroll speed (1200-3000px)
- Subtle 2px shimmer bar when waiting for network (safety net only)
