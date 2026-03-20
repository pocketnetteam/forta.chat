# Message Overlap Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate flaky message overlap in the virtualized chat list caused by stale height cache in virtua when dynamic content (replies, images) resizes after initial render.

**Architecture:** Replace the timing-guess `scrollToBottom` (triple-rAF + setTimeout) with an event-driven approach where contentResizeObserver collaborates with a `pendingScrollToBottom` flag. Additionally, increase VList's item-size estimate and add image `@load` nudge in MessageBubble.

**Tech Stack:** Vue 3, virtua (VList), ResizeObserver, TypeScript

---

### Task 1: Increase VList item-size estimate

**Files:**
- Modify: `src/features/messaging/ui/MessageList.vue:1043`

**Step 1: Change item-size from 72 to 100**

In MessageList.vue, line 1043, change:

```html
<!-- Before -->
<VList
  ...
  :item-size="72"

<!-- After -->
<VList
  ...
  :item-size="100"
```

This provides a better initial height estimate for messages with reply previews (~120-150px actual) and reduces the magnitude of offset corrections virtua needs to make.

**Step 2: Commit**

```bash
git add src/features/messaging/ui/MessageList.vue
git commit -m "fix: increase VList item-size estimate from 72 to 100

Reduces offset jump magnitude for messages with reply previews,
reactions, and other dynamic content that exceeds the 72px estimate."
```

---

### Task 2: Replace scrollToBottom with event-driven scrollToBottomStable

**Files:**
- Modify: `src/features/messaging/ui/MessageList.vue:318-348` (scrollToBottom function)
- Modify: `src/features/messaging/ui/MessageList.vue:836-862` (contentResizeObserver)

**Step 1: Add pendingScrollToBottom state and stability timer**

After line 320 (`let scrollRafId2`), add:

```typescript
let pendingScrollToBottom = false;
let scrollStableTimer: ReturnType<typeof setTimeout> | undefined;
let scrollStableRaf: number | undefined;
```

**Step 2: Replace scrollToBottom function**

Replace the entire `scrollToBottom` function (lines 321-348) with:

```typescript
const scrollToBottom = (_smooth = false, onSettled?: () => void) => {
  newMessageCount.value = 0;

  // Cancel any pending operations from a previous call
  clearTimeout(scrollBottomTimer);
  clearTimeout(scrollStableTimer);
  if (scrollRafId1 != null) cancelAnimationFrame(scrollRafId1);
  if (scrollRafId2 != null) cancelAnimationFrame(scrollRafId2);
  if (scrollStableRaf != null) cancelAnimationFrame(scrollStableRaf);

  const doScroll = () => {
    const el = getScrollContainer();
    if (el) {
      el.scrollTop = el.scrollHeight + 9999;
    }
  };

  // Activate event-driven mode: contentResizeObserver will keep
  // scrolling to bottom on every resize until content stabilises.
  pendingScrollToBottom = true;

  // Immediate scroll on next tick (handles fast/static content)
  nextTick(() => {
    doScroll();
    // One rAF pass for layout that settles within a single frame
    scrollRafId1 = requestAnimationFrame(() => {
      doScroll();
      // Start the stability window — if no resize fires within 300ms,
      // content has stabilised and we can stop.
      resetStableTimer(onSettled);
    });
  });
};

/** Reset the stability timer. Called after every content resize while
 *  pendingScrollToBottom is true. When 300ms pass without a resize,
 *  we consider the content stable and stop auto-scrolling. */
const resetStableTimer = (onSettled?: () => void) => {
  clearTimeout(scrollStableTimer);
  scrollStableTimer = setTimeout(() => {
    pendingScrollToBottom = false;
    onSettled?.();
  }, 300);
};
```

**Step 3: Enhance contentResizeObserver to collaborate with pendingScrollToBottom**

Replace the contentResizeObserver callback (lines 838-854) with:

```typescript
contentResizeObserver = new ResizeObserver(() => {
  const el = scrollListenEl;
  if (!el || switching.value) return;

  // Skip auto-scroll while loading older messages
  if (loadingMore.value || prefetching.value) {
    prevScrollHeight = el.scrollHeight;
    return;
  }

  const newHeight = el.scrollHeight;
  if (newHeight === prevScrollHeight) return;
  prevScrollHeight = newHeight;

  // Event-driven scroll: content just resized (image loaded, reply
  // preview rendered, reaction added). If we're in a pending scroll
  // or simply near the bottom, scroll down and reset the stability timer.
  if (pendingScrollToBottom || isNearBottom.value) {
    if (scrollStableRaf != null) cancelAnimationFrame(scrollStableRaf);
    scrollStableRaf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight + 9999;
      scrollStableRaf = undefined;
    });

    // If in pending mode, extend the stability window
    if (pendingScrollToBottom) {
      resetStableTimer();
    }
  }
});
```

**Step 4: Clean up timers in onUnmounted**

Find the existing `onUnmounted` block and ensure `scrollStableTimer` and `scrollStableRaf` are cleaned up. Add after existing cleanup:

```typescript
clearTimeout(scrollStableTimer);
if (scrollStableRaf != null) cancelAnimationFrame(scrollStableRaf);
pendingScrollToBottom = false;
```

**Step 5: Commit**

```bash
git add src/features/messaging/ui/MessageList.vue
git commit -m "fix: event-driven scrollToBottom replaces triple-rAF timing hack

Instead of guessing when content is ready (nextTick → rAF → rAF →
setTimeout 250ms), collaborate with contentResizeObserver: activate
pendingScrollToBottom flag, scroll on every content resize, stop
after 300ms of stability. Handles late image loads, reply preview
rendering, and reaction additions reliably."
```

---

### Task 3: Add image @load nudge in MessageBubble

**Files:**
- Modify: `src/features/messaging/ui/MessageBubble.vue:45-56` (defineEmits)
- Modify: `src/features/messaging/ui/MessageBubble.vue:394` (img tag)

**Step 1: Add `resize` event to defineEmits**

In MessageBubble.vue, line 45-56, add `resize` to the emit types:

```typescript
const emit = defineEmits<{
  reply: [message: Message];
  contextmenu: [payload: { message: Message; x: number; y: number }];
  openMedia: [message: Message];
  scrollToReply: [messageId: string];
  toggleReaction: [emoji: string, messageId: string];
  addReaction: [message: Message];
  pollVote: [messageId: string, optionId: string];
  pollEnd: [messageId: string];
  delete: [message: Message];
  forward: [message: Message];
  resize: [];
}>();
```

**Step 2: Add @load handler to img**

On line 394, add `@load` handler:

```html
<!-- Before -->
<img v-else-if="fileState.objectUrl" :src="fileState.objectUrl" :alt="message.fileInfo?.name" class="block max-h-[460px] max-w-full object-cover" :style="imageStyle" />

<!-- After -->
<img v-else-if="fileState.objectUrl" :src="fileState.objectUrl" :alt="message.fileInfo?.name" class="block max-h-[460px] max-w-full object-cover" :style="imageStyle" @load="emit('resize')" />
```

**Step 3: Commit**

```bash
git add src/features/messaging/ui/MessageBubble.vue
git commit -m "fix: emit resize on image load for virtua height recalculation

When an image finishes loading inside a message bubble, emit a resize
event so the parent can nudge virtua to recalculate offsets."
```

---

### Task 4: Handle resize event in MessageList

**Files:**
- Modify: `src/features/messaging/ui/MessageList.vue:1122-1142` (MessageBubble usage)

**Step 1: Add nudgeVirtua helper**

Add this function near `scrollToBottom` (after the `resetStableTimer` function):

```typescript
/** Micro-nudge scrollTop to force virtua to recalculate item offsets.
 *  Used when an individual item's height changes (image load, etc.)
 *  and we're NOT in a pendingScrollToBottom flow. */
const nudgeVirtua = () => {
  if (pendingScrollToBottom) return; // already handled by stable scroll
  const el = getScrollContainer();
  if (!el) return;
  // The contentResizeObserver will also fire, but this nudge ensures
  // virtua's internal ResizeObserver re-measures the affected item.
  // A 0.5px scroll jitter is invisible but forces layout recalc.
  el.scrollTop += 0.5;
  requestAnimationFrame(() => {
    if (el) el.scrollTop -= 0.5;
  });
};
```

**Step 2: Wire @resize on MessageBubble**

On line 1122-1142, add `@resize="nudgeVirtua"` to MessageBubble:

```html
<MessageBubble
  :key="((item.message as any)._key || item.message.id) + (item.message.deleted ? '-del' : '')"
  :message="item.message"
  :is-own="item.message.senderId === authStore.address"
  :my-address="authStore.address ?? undefined"
  :is-group="isGroup"
  :show-avatar="themeStore.messageGrouping ? !isConsecutiveMessage(item.message, chatStore.activeMessages[(item.index ?? 0) + 1]) : true"
  :is-first-in-group="themeStore.messageGrouping ? !isConsecutiveMessage(chatStore.activeMessages[(item.index ?? 0) - 1], item.message) : true"
  @contextmenu="openContextMenu"
  @reply="(msg) => { chatStore.replyingTo = { id: msg.id, senderId: msg.senderId, content: msg.content.slice(0, 150), type: msg.type }; }"
  @scroll-to-reply="scrollToMessage"
  @open-media="handleOpenMedia"
  @toggle-reaction="(emoji, messageId) => handleToggleReactionWithEffect(messageId, emoji)"
  @add-reaction="handleOpenEmojiPicker"
  @poll-vote="handlePollVote"
  @poll-end="handlePollEnd"
  @resize="nudgeVirtua"
>
```

**Step 3: Commit**

```bash
git add src/features/messaging/ui/MessageList.vue
git commit -m "fix: nudge virtua on MessageBubble resize to prevent overlap

When a message bubble reports a size change (image loaded), micro-nudge
scrollTop by 0.5px to force virtua to re-measure the affected item's
height and recalculate offsets for all items below it."
```

---

### Task 5: Manual testing

**Step 1: Test new message with reply preview**

1. Open a chat, scroll to bottom
2. Send a message that includes a reply/quote
3. Verify: no overlap between the new message and previous messages
4. Verify: auto-scroll lands at the correct position

**Step 2: Test image message**

1. Send an image in chat
2. Verify: while the image loads, no messages overlap
3. Verify: after image loads, scroll position adjusts correctly

**Step 3: Test rapid messages**

1. Have another user send 5+ messages rapidly
2. Verify: all messages render without overlap
3. Verify: if near bottom, auto-scroll keeps up

**Step 4: Test scroll-up stability**

1. Scroll up to read older messages
2. Have new messages arrive
3. Verify: scroll position stays stable (no jump)
4. Verify: "N new messages" badge appears

**Step 5: Final commit**

```bash
git add -A
git commit -m "fix: message overlap in virtualized chat list

- Increase VList item-size estimate from 72 to 100
- Replace triple-rAF scrollToBottom with event-driven approach
- Emit resize from MessageBubble on image load
- Nudge virtua on individual item resize"
```
