# Архитектура: UI и баги интерфейса

## Связь с проблемой

Пользователи сообщают: «не листает», кнопка «сохранить» не активна, нельзя изменить имя/профиль/аватар, строка ввода скрыта клавиатурой, кнопка возврата к новым сообщениям не работает, висит «New message» хотя всё прочитано.

## Виртуальный скролл: `ChatVirtualScroller`

**Файл:** `src/shared/ui/ChatVirtualScroller.vue`

### Механизм

- **НЕ использует windowing/recycling** — обычный `v-for` по всем элементам
- Окно сообщений уже ограничено в store (50–200 сообщений)
- **Инвертированная вёрстка:** `flex-direction: column-reverse`
  - Индекс 0 = самое новое сообщение = визуально внизу
  - `scrollTop === 0` означает «внизу у новых»

### Якорение при новых сообщениях

- `MutationObserver` + `checkAnchor()`:
  - Если пользователь **не у низа** (`|scrollTop| > 50`) и добавились новые элементы
  - Подсчитывается высота новых строк → корректируется `scrollTop`
  - Предотвращает «прыжок» контента

### API

- `scrollToBottom()` → `scrollTop = 0` (из-за column-reverse)
- `scrollToIndex(id)` → поиск по `[data-virtual-id]`, скролл с учётом reverse
- `getContainerEl()` — ссылка на контейнер

### Пагинация

Управляется в `MessageList.vue`, не в скроллере:
- `expandMessageWindow` / `prefetchNextBatch` — увеличение `messageWindowSize` в store
- `loadMoreMessages` → Dexie `.limit()` + при необходимости Matrix API

## FAB «К новым сообщениям»

**Файл:** `src/features/messaging/ui/MessageList.vue`

### Логика показа

```
checkScroll():
  |scrollTop| < 100  → "у низа" (isNearBottom)
  |scrollTop| > 300  → показать FAB
```

### Счётчик новых сообщений

- `watch(lastMessageIdentity)`: если пришло **не своё** сообщение и пользователь **не у низа** → `newMessageCount++`
- `fabBadgeCount`: замороженный счётчик unread-баннера или `newMessageCount`

### Поведение клика

```
handleFabClick():
  1. Если есть замороженный unread-баннер → скролл к нему
  2. Если isDetachedFromLatest → выход из detached + scrollToBottom
  3. Иначе → scrollToBottom
```

### `ResizeObserver`

На контенте при «у низу» удерживает `scrollTop = 0` при подгрузке картинок.

## Клавиатура на мобиле

### Общая схема

Высота клавиатуры → CSS-переменная `--keyboardheight` → safe padding.

### Веб (visualViewport)

`src/app/App.vue`:
- `visualViewport.addEventListener("resize")` + `"scroll"` (Samsung toolbar)
- Вычисление: `window.innerHeight - visualViewport.height - visualViewport.offsetTop`

### Android Native

`android/app/src/main/java/com/forta/chat/MainActivity.kt`:
- Edge-to-edge layout
- `WindowInsetsCompat.Type.ime()` → чистая высота клавиатуры
- Инжекция CSS: `--native-keyboard-height`, `--safe-area-inset-*`
- JS-событие: `dispatchEvent('native-keyboard-change', { detail: { height } })`

### Объединение

`src/shared/lib/keyboard-height.ts` (`computeKeyboardHeight`):
- Слияние native и web inset → единая `--keyboardheight`

### CSS

`src/app/styles/main.css`:
- Утилиты `safe-bottom`, `safe-y`, `safe-all`
- Нижний отступ: `max(--keyboardheight, safe-area-inset-bottom)`

### MessageInput

- Атрибут `data-keyboard-aware` на textarea — глобальный `focusin` не дублирует `scrollIntoView`
- При редактировании: локальный `scrollIntoView` с задержкой ~400ms

**Важно:** `@capacitor/keyboard` **НЕ используется** — обработка через MainActivity + visualViewport.

## Редактирование профиля

### Свой профиль

```
ProfileEditPage.vue → UserEditForm.vue (src/features/user-management/ui/)
```

- Поля: имя, about, website, язык (select) → `v-model` на локальный `form`
- Аватар: `<input type="file">` → `fileToBase64` → `uploadImage` → URL в `avatarUrl`
- **Кнопка «Сохранить»:** `type="submit"`, `disabled` если **`!hasChanges`**
- `hasChanges`: сравнение формы/аватара с `authStore.userInfo`
- `handleSave()` → `authStore.editUserData(...)` → `userStore.setUser` (мгновенный UI)
- Состояния: `authStore.isEditingUserData` (loading), `saveSuccess` (flash)

### Проблема «кнопка не активна»

Скорее всего `hasChanges === false` потому что:
- `userInfo` ещё не загружен (медленная сеть)
- Или сравнение не обнаруживает разницу (edge case)

## Непрочитанные сообщения

### Баннер «N unread messages»

**Файлы:**
- `src/features/messaging/ui/UnreadBanner.vue` — визуал
- `src/features/messaging/model/use-unread-banner.ts` — логика

### Логика баннера

1. При открытии комнаты: `freezeBanner(lastReadId, count)` — фиксирует позицию
2. **Grace period 2 секунды** — не сбрасывать баннер слишком быстро
3. При скролле к низу: `dismissBanner()` → сброс

### Вставка в список

`MessageList.vue` → `virtualItems`:
- Ищет сообщение по `frozenLastReadId`
- Вставляет `type: 'unread-banner'` **перед первым входящим** после маркера

### Прочитанность (Read Tracker)

`src/features/messaging/model/use-read-tracker.ts`:
- `IntersectionObserver` + fallback `getBoundingClientRect` + scroll/resize events
- `advanceInboundWatermark` → коалесинг 100ms → `commitReadWatermark`
- `ResizeObserver` на скролл-контейнере для повторного сканирования при клавиатуре

### Очистка unread

При `setActiveRoom`:
1. `clearUnread` в EventWriter
2. Обнуление `unreadCount` в памяти/Dexie
3. **`lastReadInboundTs` НЕ сдвигается** — баннер в ленте сохраняется

### Проблема «висит New message»

Возможные причины:
- `dismissBanner()` не вызывается если пользователь не скроллит до низа
- Grace period 2s может мешать при быстром переключении комнат
- `advanceInboundWatermark` не срабатывает без IntersectionObserver

## Навигация

### Мобильный чат (список ↔ переписка)

`src/pages/chat/ChatPage.vue`:
- Локальное состояние `showSidebar` / CSS transitions `slide-left` / `slide-right`
- Кнопка «назад» в `ChatWindow` → `emit('back')` → `chatStore.setActiveRoom(null)` + `showSidebar = true`

### Android System Back

`src/shared/lib/composables/use-android-back-handler.ts`:
- Цепочка обработчиков с **приоритетами**: модалки > поиск > info panel > настройки > **chat-back-to-sidebar (60)** > ...
- Если никто не обработал → `App.minimizeApp()`

### Роутер

- `createWebHashHistory` — URL вида `/#/...`
- Переходы между страницами: `router.push`, без `history.back()` для чата

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/shared/ui/ChatVirtualScroller.vue` | Инвертированный скролл + якорение |
| `src/features/messaging/ui/MessageList.vue` | Список, FAB, пагинация, unread banner |
| `src/features/messaging/model/use-unread-banner.ts` | Логика unread-баннера |
| `src/features/messaging/model/use-read-tracker.ts` | Прочитанность по viewport |
| `src/features/messaging/ui/MessageInput.vue` | Ввод + клавиатура |
| `src/entities/chat/model/chat-store.ts` | Unread, watermark, receipts |
| `src/app/App.vue` | Клавиатура, scroll into view |
| `src/shared/lib/keyboard-height.ts` | Объединение native/web keyboard height |
| `src/app/styles/main.css` | Safe area утилиты |
| `src/features/user-management/ui/UserEditForm.vue` | Форма редактирования профиля |
| `src/pages/chat/ChatPage.vue` | Мобильная навигация sidebar ↔ chat |
| `src/shared/lib/composables/use-android-back-handler.ts` | Android system back |
| `android/app/src/main/java/com/forta/chat/MainActivity.kt` | Native keyboard/safe area |
