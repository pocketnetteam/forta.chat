# Invite a Friend — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add "Invite a Friend" feature with aggressive FAB UI, referral link modal with share buttons, and post-registration auto-chat creation flow.

**Architecture:** Client-only feature. FAB button in ChatSidebar opens InviteModal with generated referral link. New `/invite` route saves `ref` to localStorage and redirects to `/welcome`. After successful auth + Matrix init in App.vue, stored ref triggers `getOrCreateRoom()` and navigates to the new chat.

**Tech Stack:** Vue 3, vue-router hash mode, existing Modal.vue, existing `useContacts` composable, localStorage, standard share URL schemes.

---

### Task 1: Add i18n keys for invite feature

**Files:**
- Modify: `src/shared/lib/i18n/locales/en.ts:446` (before closing `} as const`)
- Modify: `src/shared/lib/i18n/locales/ru.ts:448` (before closing `}`)

**Step 1: Add English translations**

Add before the closing `} as const;` in `en.ts`:

```typescript
  // -- Invite friend --
  "invite.title": "Invite a Friend",
  "invite.subtitle": "Share this link and start chatting right away",
  "invite.copyLink": "Copy Link",
  "invite.copied": "Copied!",
  "invite.shareOn": "Share on",
  "invite.fab": "Invite",
```

**Step 2: Add Russian translations**

Add before the closing `};` in `ru.ts`:

```typescript
  // -- Invite friend --
  "invite.title": "Пригласить друга",
  "invite.subtitle": "Поделитесь ссылкой и начните общение сразу",
  "invite.copyLink": "Копировать ссылку",
  "invite.copied": "Скопировано!",
  "invite.shareOn": "Поделиться в",
  "invite.fab": "Пригласить",
```

**Step 3: Verify types compile**

Run: `npx vue-tsc --noEmit 2>&1 | head -20`
Expected: No errors related to invite keys (ru.ts type-checks against en.ts TranslationKey).

**Step 4: Commit**

```bash
git add src/shared/lib/i18n/locales/en.ts src/shared/lib/i18n/locales/ru.ts
git commit -m "feat(invite): add i18n keys for invite friend feature"
```

---

### Task 2: Create `/invite` route with ref param handling

**Files:**
- Create: `src/app/providers/router/routes/invite.ts`
- Modify: `src/app/providers/router/routes/index.ts:12-25`
- Modify: `src/app/providers/router/pages.ts:1-17`

**Step 1: Create invite route file**

Create `src/app/providers/router/routes/invite.ts`:

```typescript
import type { RouteRecordRaw } from "vue-router";

export const routeName = "InvitePage";

export const route: RouteRecordRaw = {
  path: "/invite",
  name: routeName,
  beforeEnter: (to, _from, next) => {
    const ref = to.query.ref as string | undefined;
    if (ref) {
      localStorage.setItem("bastyon-chat-referral", ref);
    }
    next({ name: "WelcomePage", replace: true });
  },
};
```

**Step 2: Register the route in routes/index.ts**

Add import and include in array. Modified `src/app/providers/router/routes/index.ts`:

```typescript
import type { RouteRecordRaw } from "vue-router";

import { route as chatRoute } from "./chat";
import { route as inviteRoute } from "./invite";
import { route as loginRoute } from "./login";
import { route as profileRoute } from "./profile";
import { route as profileEditRoute } from "./profile-edit";
import { route as settingsRoute } from "./settings";
import { route as appearanceRoute } from "./appearance";
import { route as registerRoute } from "./register";
import { route as welcomeRoute } from "./welcome";

export const routes: RouteRecordRaw[] = [
  inviteRoute,
  loginRoute,
  chatRoute,
  registerRoute,
  welcomeRoute,
  profileRoute,
  profileEditRoute,
  settingsRoute,
  appearanceRoute,
  {
    path: "/:pathMatch(.*)*",
    redirect: "/welcome"
  }
];
```

Note: `inviteRoute` is placed first so `/invite` is matched before the catch-all.

**Step 3: Add invite to pages.ts**

Modified `src/app/providers/router/pages.ts`:

```typescript
import { routeName as chat } from "./routes/chat";
import { routeName as invite } from "./routes/invite";
import { routeName as login } from "./routes/login";
import { routeName as profile } from "./routes/profile";
import { routeName as profileEdit } from "./routes/profile-edit";
import { routeName as settings } from "./routes/settings";
import { routeName as appearance } from "./routes/appearance";
import { routeName as welcome } from "./routes/welcome";

export const pages = {
  appearance,
  chat,
  invite,
  login,
  profile,
  profileEdit,
  settings,
  welcome
} as const;
```

**Step 4: Verify route works**

Run: `npx vue-tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

**Step 5: Commit**

```bash
git add src/app/providers/router/routes/invite.ts src/app/providers/router/routes/index.ts src/app/providers/router/pages.ts
git commit -m "feat(invite): add /invite route with ref param persistence"
```

---

### Task 3: Create InviteModal component

**Files:**
- Create: `src/features/invite/ui/InviteModal.vue`
- Create: `src/features/invite/index.ts`

**Step 1: Create the barrel export**

Create `src/features/invite/index.ts`:

```typescript
export { default as InviteModal } from "./ui/InviteModal.vue";
```

**Step 2: Create InviteModal.vue**

Create `src/features/invite/ui/InviteModal.vue`:

```vue
<script setup lang="ts">
import Modal from "@/shared/ui/modal/Modal.vue";
import { useAuthStore } from "@/entities/auth";

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const authStore = useAuthStore();

const copied = ref(false);

const inviteLink = computed(() => {
  const base = window.location.origin + window.location.pathname;
  return `${base}#/invite?ref=${authStore.address}`;
});

const copyLink = async () => {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    // Fallback: select text in input
  }
};

const shareUrl = (platform: string) => {
  const text = encodeURIComponent("Join me on Bastyon Chat!");
  const url = encodeURIComponent(inviteLink.value);

  const urls: Record<string, string> = {
    telegram: `https://t.me/share/url?url=${url}&text=${text}`,
    whatsapp: `https://wa.me/?text=${text}%20${url}`,
    twitter: `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
    email: `mailto:?subject=${text}&body=${text}%20${url}`,
  };

  window.open(urls[platform], "_blank", "noopener,noreferrer");
};
</script>

<template>
  <Modal :show="props.show" :aria-label="t('invite.title')" @close="emit('close')">
    <div class="flex flex-col items-center gap-5">
      <!-- Header -->
      <div class="flex flex-col items-center gap-2 text-center">
        <!-- Icon -->
        <div class="flex h-14 w-14 items-center justify-center rounded-full bg-text-accent/15">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-txt-ac))" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="19" y1="8" x2="19" y2="14" />
            <line x1="22" y1="11" x2="16" y2="11" />
          </svg>
        </div>
        <h2 class="text-lg font-semibold text-text-color">{{ t("invite.title") }}</h2>
        <p class="text-sm text-text-secondary">{{ t("invite.subtitle") }}</p>
      </div>

      <!-- Link field -->
      <div class="flex w-full items-center gap-2 rounded-lg border border-neutral-grad-0 bg-background-chat-theme p-2">
        <input
          :value="inviteLink"
          readonly
          class="min-w-0 flex-1 bg-transparent text-sm text-text-color outline-none"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <button
          class="btn-press shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          :class="copied
            ? 'bg-green-500/15 text-green-600 dark:text-green-400'
            : 'bg-text-accent/15 text-text-accent hover:bg-text-accent/25'"
          @click="copyLink"
        >
          {{ copied ? t("invite.copied") : t("invite.copyLink") }}
        </button>
      </div>

      <!-- Share buttons -->
      <div class="flex w-full flex-col gap-2">
        <span class="text-xs font-medium uppercase tracking-wider text-text-secondary">
          {{ t("invite.shareOn") }}
        </span>
        <div class="grid grid-cols-5 gap-2">
          <!-- Telegram -->
          <button
            class="btn-press flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-neutral-grad-0"
            @click="shareUrl('telegram')"
          >
            <div class="flex h-10 w-10 items-center justify-center rounded-full" style="background: #2AABEE">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
              </svg>
            </div>
            <span class="text-[10px] text-text-secondary">Telegram</span>
          </button>

          <!-- WhatsApp -->
          <button
            class="btn-press flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-neutral-grad-0"
            @click="shareUrl('whatsapp')"
          >
            <div class="flex h-10 w-10 items-center justify-center rounded-full" style="background: #25D366">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
              </svg>
            </div>
            <span class="text-[10px] text-text-secondary">WhatsApp</span>
          </button>

          <!-- Twitter/X -->
          <button
            class="btn-press flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-neutral-grad-0"
            @click="shareUrl('twitter')"
          >
            <div class="flex h-10 w-10 items-center justify-center rounded-full bg-black dark:bg-white">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="white" class="dark:fill-black">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </div>
            <span class="text-[10px] text-text-secondary">X</span>
          </button>

          <!-- Facebook -->
          <button
            class="btn-press flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-neutral-grad-0"
            @click="shareUrl('facebook')"
          >
            <div class="flex h-10 w-10 items-center justify-center rounded-full" style="background: #1877F2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
            </div>
            <span class="text-[10px] text-text-secondary">Facebook</span>
          </button>

          <!-- Email -->
          <button
            class="btn-press flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-neutral-grad-0"
            @click="shareUrl('email')"
          >
            <div class="flex h-10 w-10 items-center justify-center rounded-full bg-gray-500">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M22 7l-10 7L2 7" />
              </svg>
            </div>
            <span class="text-[10px] text-text-secondary">Email</span>
          </button>
        </div>
      </div>
    </div>
  </Modal>
</template>
```

**Step 3: Verify types compile**

Run: `npx vue-tsc --noEmit 2>&1 | head -20`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/features/invite/
git commit -m "feat(invite): create InviteModal with referral link and share buttons"
```

---

### Task 4: Add FAB button to ChatSidebar

**Files:**
- Modify: `src/widgets/sidebar/ChatSidebar.vue`

**Step 1: Add FAB to the sidebar**

In `ChatSidebar.vue`, add the import and state at the top of `<script setup>`, and the FAB + modal in the template.

Add to `<script setup>` (after existing imports):

```typescript
import { InviteModal } from "@/features/invite";

const showInviteModal = ref(false);
```

Add in `<template>`, right before `<BottomTabBar ...>` (line 195), insert the FAB and modal:

```html
    <!-- Invite FAB -->
    <button
      class="invite-fab btn-press absolute bottom-16 right-3 z-10 flex items-center gap-2 rounded-full bg-text-accent px-4 py-2.5 font-medium text-white shadow-lg transition-all hover:shadow-xl active:scale-95"
      :title="t('invite.fab')"
      @click="showInviteModal = true"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" />
        <line x1="22" y1="11" x2="16" y2="11" />
      </svg>
      <span class="text-sm">{{ t("invite.fab") }}</span>
    </button>

    <InviteModal :show="showInviteModal" @close="showInviteModal = false" />
```

Add to `<style scoped>` (before `@media (prefers-reduced-motion)`):

```css
/* Invite FAB pulse animation */
.invite-fab {
  animation: invite-pulse 3s ease-in-out infinite;
}
@keyframes invite-pulse {
  0%, 100% { box-shadow: 0 4px 14px rgba(var(--color-txt-ac), 0.3); }
  50% { box-shadow: 0 4px 24px rgba(var(--color-txt-ac), 0.6); }
}
```

**Step 2: Verify types compile**

Run: `npx vue-tsc --noEmit 2>&1 | head -20`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/widgets/sidebar/ChatSidebar.vue
git commit -m "feat(invite): add pulsing FAB invite button to sidebar"
```

---

### Task 5: Add referral processing hook in App.vue

**Files:**
- Modify: `src/app/App.vue`

**Step 1: Add referral processing after Matrix init**

In `App.vue`, add the referral handling logic. Import `useContacts` and `useRouter`, then add the processing function.

Add imports at top of `<script setup>` (after existing imports):

```typescript
import { useContacts } from "@/features/contacts";
import { useRouter } from "vue-router";
```

Add the referral processing function after the `onMounted` block's existing code. Inside `onMounted`, after the Matrix initialization block (after line 58), add:

```typescript
  // Process referral link after Matrix is ready
  await processReferral();
```

Add this function before `onMounted` (after imports):

```typescript
const router = useRouter();

const processReferral = async () => {
  if (!authStore.isAuthenticated || !authStore.matrixReady) return;

  const ref = localStorage.getItem("bastyon-chat-referral");
  if (!ref) return;

  // Remove immediately to prevent duplicate processing
  localStorage.removeItem("bastyon-chat-referral");

  // Don't create chat with yourself
  if (ref === authStore.address) return;

  try {
    const { getOrCreateRoom } = useContacts();
    const roomId = await getOrCreateRoom(ref);
    if (roomId) {
      router.push({ name: "ChatPage" });
    }
  } catch (e) {
    console.error("[App] referral processing error:", e);
  }
};
```

The full modified `onMounted` will look like:

```typescript
onMounted(async () => {
  window.addEventListener("resize", onResize);

  if ((window as any).electronAPI?.isElectron) {
    document.documentElement.classList.add("is-electron");
    if ((window as any).electronAPI?.platform === "darwin") {
      document.documentElement.classList.add("is-electron-mac");
    }
  }

  if (window.visualViewport) {
    const vv = window.visualViewport;
    const updateKeyboardHeight = () => {
      const kbh = window.innerHeight - vv.height;
      document.documentElement.style.setProperty("--keyboardheight", `${Math.max(0, kbh)}px`);
    };
    vv.addEventListener("resize", updateKeyboardHeight);
    onUnmounted(() => vv.removeEventListener("resize", updateKeyboardHeight));
  }

  try {
    await authStore.fetchUserInfo();
  } catch (e) {
    console.error("[App] fetchUserInfo error:", e);
  }

  if (authStore.isAuthenticated && authStore.registrationPending) {
    authStore.resumeRegistrationPoll();
  } else if (authStore.isAuthenticated && !authStore.matrixReady) {
    await authStore.initMatrix();
  }

  // Process referral link after Matrix is ready
  await processReferral();
});
```

**Step 2: Handle edge case — registration poll completes, then process referral**

The `resumeRegistrationPoll()` is async and eventually sets `matrixReady`. We need a watcher for the case where Matrix isn't ready yet during `onMounted` but becomes ready later (after registration poll completes).

Add after the `processReferral` function definition:

```typescript
// Watch for Matrix becoming ready (e.g., after registration poll completes)
watch(
  () => authStore.matrixReady,
  (ready) => {
    if (ready && localStorage.getItem("bastyon-chat-referral")) {
      processReferral();
    }
  },
);
```

**Step 3: Verify types compile**

Run: `npx vue-tsc --noEmit 2>&1 | head -20`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/app/App.vue
git commit -m "feat(invite): process referral link after auth and create 1:1 chat"
```

---

### Task 6: Handle referral in auth guard (redirect preservation)

**Files:**
- Modify: `src/app/providers/router/handlers/auth-guard.ts`

**Step 1: Preserve ref query param through auth redirects**

The auth guard redirects unauthenticated users to `/welcome` with a `redirect` query param. The `/invite` route already saves `ref` to localStorage before redirecting to `/welcome`, so the auth guard doesn't need changes for the invite flow itself.

However, if a user is already authenticated and visits `/invite?ref=...`, the `beforeEnter` guard on the invite route handles it and redirects to `/welcome`, which then redirects to `/chat` (since user is authenticated). The referral is already in localStorage and will be picked up by `processReferral()` in App.vue.

**No changes needed** — the existing auth guard + invite route `beforeEnter` handle all cases:
1. New user: `/invite?ref=X` → localStorage + redirect to `/welcome` → registers → Matrix init → `processReferral()`
2. Existing user: `/invite?ref=X` → localStorage + redirect to `/welcome` → auth guard redirects to `/chat` → `processReferral()` via watcher

**Step 2: Commit** (skip — no changes)

---

### Task 7: Manual E2E verification

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Test invite UI flow**

1. Log in to the app
2. Verify the pulsing "Invite" FAB button appears at bottom-right of sidebar
3. Click it — modal should open with:
   - Person+ icon and "Invite a Friend" title
   - Referral link containing your address
   - Copy button (click → text changes to "Copied!")
   - 5 share buttons: Telegram, WhatsApp, X, Facebook, Email
4. Click each share button — should open correct URL in new tab
5. Close modal via overlay click or Escape key

**Step 3: Test referral flow (new user)**

1. Copy the referral link
2. Log out
3. Paste the link in browser
4. Verify localStorage contains `bastyon-chat-referral` key
5. Verify redirect to `/welcome`
6. Log in / register
7. After Matrix initializes, verify:
   - A 1:1 chat room is created with the inviter
   - You're navigated to the chat page
   - `bastyon-chat-referral` is removed from localStorage

**Step 4: Test edge cases**

1. Visit `/invite?ref=YOUR_OWN_ADDRESS` — should NOT create a self-chat
2. Visit `/invite` without `ref` param — should just redirect to `/welcome`, no localStorage entry
3. Visit `/invite?ref=X`, close tab, reopen app, log in — ref should still be in localStorage and processed

**Step 5: Commit all if not done**

```bash
git add -A
git commit -m "feat(invite): invite a friend feature complete"
```
