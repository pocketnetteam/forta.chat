# "Invite a Friend" Feature Design

**Goal:** Aggressive invite UI (FAB + modal with referral link & share buttons) + referral flow that auto-creates a 1:1 chat after invited user registers.

**Architecture:** Client-only. FAB in sidebar opens modal with generated link. New `/invite` route captures `ref` param into localStorage. After auth + Matrix init, App.vue checks for stored ref and calls `getOrCreateRoom()`.

**Tech Stack:** Vue 3, vue-router (hash mode), existing Modal.vue, existing useContacts composable, localStorage, Web Share API fallback.
