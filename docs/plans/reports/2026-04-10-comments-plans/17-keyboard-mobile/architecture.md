# Архитектура: Работа с клавиатурой на мобильных устройствах

## Связь с проблемой

Пользователи сообщают: «строка ввода скрыта клавиатурой (не видно текст)», поле ввода перекрывается при открытии клавиатуры на Android и других платформах. Иногда некоторые поля сдвигаются в два раза больше чем должны.

---

## Общая схема (end-to-end)

```
┌─ Android Native ──────────────────────────────────────────────────┐
│                                                                    │
│  AndroidManifest.xml: windowSoftInputMode="adjustNothing"          │
│  MainActivity.kt:     edge-to-edge + WindowInsetsCompat            │
│                                                                    │
│  IME открывается → WindowInsetsCompat.Type.ime().bottom            │
│  → вычитается nav bar → ограничение 60% экрана                    │
│  → CSS: --native-keyboard-height: Npx                              │
│  → JS: CustomEvent('native-keyboard-change', { height: N })       │
│                                                                    │
└────────────────────────────┬───────────────────────────────────────┘
                             │
┌─ JS (App.vue) ─────────────▼───────────────────────────────────────┐
│                                                                     │
│  Два источника:                                                     │
│    1. native-keyboard-change event (PRIMARY)                        │
│    2. visualViewport resize/scroll (FALLBACK)                       │
│                                                                     │
│  computeKeyboardHeight() → --keyboardheight: Npx                   │
│                                                                     │
│  focusin handler → scrollIntoView (кроме data-keyboard-aware)      │
│                                                                     │
└────────────────────────────┬───────────────────────────────────────┘
                             │
┌─ CSS (main.css) ───────────▼───────────────────────────────────────┐
│                                                                     │
│  .safe-bottom {                                                     │
│    padding-bottom: max(--keyboardheight, --safe-area-inset-bottom)  │
│  }                                                                  │
│                                                                     │
│  Компоненты с safe-bottom: ChatWindow, MainLayout, AuthLayout       │
│                                                                     │
└────────────────────────────┬───────────────────────────────────────┘
                             │
┌─ Layout ───────────────────▼───────────────────────────────────────┐
│                                                                     │
│  ChatWindow (safe-bottom)                                           │
│    ├── Header (shrink-0)                                            │
│    ├── MessageList (flex-1, min-h-0)                                │
│    │     └── ChatVirtualScroller (h-full, column-reverse)           │
│    └── MessageInput (shrink-0)                                      │
│                                                                     │
│  padding-bottom растёт → flex-1 сжимается → input остаётся видим   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1. Android Native: режим клавиатуры

### `windowSoftInputMode = "adjustNothing"`

**Файл:** `android/app/src/main/AndroidManifest.xml` (строка 19)

```xml
<activity
    android:windowSoftInputMode="adjustNothing"
    ...
    android:name=".MainActivity">
```

**Что это означает:**
- Система **НЕ ресайзит** окно WebView при появлении клавиатуры
- Система **НЕ сдвигает** контент вверх
- Всё управление отступами — **вручную через CSS**
- Это сознательный выбор: `adjustResize` на API 30+ с edge-to-edge не работает корректно

### Альтернативные режимы и почему НЕ используются

| Режим | Поведение | Проблема в Forta |
|-------|-----------|------------------|
| `adjustResize` | Система ресайзит окно | На API 30+ с edge-to-edge не ресайзит (баг Android); «двойной сдвиг» при ручном padding |
| `adjustPan` | Система сдвигает окно вверх | Непредсказуемый сдвиг, header уходит за экран |
| **`adjustNothing`** | Система ничего не делает | **Используется** — полный контроль через CSS |

### Edge-to-Edge

**Файл:** `android/app/src/main/java/com/forta/chat/MainActivity.kt` (строка 43)

```kotlin
WindowCompat.setDecorFitsSystemWindows(window, false)
```

Контент рисуется **под** системными панелями (status bar, nav bar). Отступы считаются вручную через `WindowInsetsCompat`.

### Прозрачные системные панели

**Файл:** `android/app/src/main/res/values/styles.xml` (строки 15–16)

```xml
<item name="android:statusBarColor">@android:color/transparent</item>
<item name="android:navigationBarColor">@android:color/transparent</item>
```

---

## 2. Вычисление высоты клавиатуры (Android Native)

### WindowInsetsCompat listener

**Файл:** `MainActivity.kt` (строки 48–70)

```kotlin
ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
    val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val density = resources.displayMetrics.density

    // System bars: status bar (top), nav bar (bottom), edges (left/right)
    insetTop = (systemBars.top / density).toInt()
    insetBottom = (systemBars.bottom / density).toInt()
    insetLeft = (systemBars.left / density).toInt()
    insetRight = (systemBars.right / density).toInt()

    // IME: ime.bottom включает nav bar → вычитаем для чистой высоты клавиатуры
    val rawKeyboard = (ime.bottom / density).toInt()
    val pureKeyboard = if (rawKeyboard > insetBottom) rawKeyboard - insetBottom else 0
    
    // Защита: ограничение 60% высоты экрана (от багов прошивок OEM)
    val screenHeightDp = (resources.displayMetrics.heightPixels / density).toInt()
    keyboardHeight = pureKeyboard.coerceAtMost((screenHeightDp * 0.6).toInt())

    injectSafeAreaInsets()
    injectKeyboardHeight()
    ViewCompat.onApplyWindowInsets(view, insets)
}
```

### Формула

```
rawKeyboard = ime.bottom / density          (пиксели → dp)
pureKeyboard = rawKeyboard - insetBottom    (минус nav bar)
keyboardHeight = min(pureKeyboard, screenHeight * 0.6)  (защита от OEM багов)
```

### Примеры значений

| Устройство | Nav bar (dp) | Клавиатура (dp) | ime.bottom (dp) | pureKeyboard |
|------------|-------------|-----------------|-----------------|--------------|
| Pixel 7 (gesture nav) | 24 | 280 | 304 | 280 |
| Samsung S23 (3-button) | 48 | 300 | 348 | 300 |
| Honor 10X | 48 | 260 | 308 | 260 |
| Samsung + toolbar | 48 | 340 | 388 | 340 |

---

## 3. Передача в WebView

### CSS переменные

**Файл:** `MainActivity.kt`, `injectSafeAreaInsets()` (строки 85–97)

```kotlin
val js = """
    (function() {
        var s = document.documentElement.style;
        s.setProperty('--safe-area-inset-top', '${insetTop}px');
        s.setProperty('--safe-area-inset-bottom', '${insetBottom}px');
        s.setProperty('--safe-area-inset-left', '${insetLeft}px');
        s.setProperty('--safe-area-inset-right', '${insetRight}px');
    })();
""".trimIndent()
webView.post { webView.evaluateJavascript(js, null) }
// Повторная инжекция через 1 секунду (страховка от перезаписи при загрузке)
webView.postDelayed({ webView.evaluateJavascript(js, null) }, 1000)
```

### Высота клавиатуры + JS event

**Файл:** `MainActivity.kt`, `injectKeyboardHeight()` (строки 101–109)

```kotlin
val js = """
    (function() {
        document.documentElement.style.setProperty(
            '--native-keyboard-height', '${keyboardHeight}px'
        );
        window.dispatchEvent(new CustomEvent('native-keyboard-change', {
            detail: { height: ${keyboardHeight} }
        }));
    })();
""".trimIndent()
webView.post { webView.evaluateJavascript(js, null) }
```

### Повторная инжекция при Resume

**Файл:** `MainActivity.kt`, `onResume()` (строки 77–83)

```kotlin
override fun onResume() {
    super.onResume()
    injectSafeAreaInsets()
    injectKeyboardHeight()
}
```

Необходимо потому что WebView мог быть перезагружен системой в фоне.

---

## 4. JS-слой: объединение источников

### `keyboard-height.ts`

**Файл:** `src/shared/lib/keyboard-height.ts`

```typescript
export function computeKeyboardHeight(input: KeyboardHeightInput): number {
  // Нативное событие — авторитетный источник
  if (input.isNativeEvent) return input.nativeKbh;
  // visualViewport fallback — берём максимум
  return Math.max(input.webKbh, input.nativeKbh);
}
```

**Логика приоритетов:**

| Событие | Источник nativeKbh | Источник webKbh | Результат |
|---------|--------------------|-----------------|-----------| 
| `native-keyboard-change` | `event.detail.height` | — | `nativeKbh` (авторитетно) |
| `visualViewport resize` | CSS `--native-keyboard-height` | `innerHeight - vv.height` | `max(webKbh, nativeKbh)` |
| `visualViewport scroll` | CSS `--native-keyboard-height` | `innerHeight - vv.height` | `max(webKbh, nativeKbh)` |

**Почему два источника:**
- `native-keyboard-change` не срабатывает на вебе (нет нативного кода)
- `visualViewport` может не fire на некоторых Android при закрытии клавиатуры через Back/gesture
- Samsung WebView иногда меняет размер toolbar без `resize`, но с `scroll`

### `App.vue` — обработчик

**Файл:** `src/app/App.vue` (строки 232–266)

```typescript
const updateKeyboardHeight = (e?: Event) => {
  const isNativeEvent = e?.type === "native-keyboard-change";
  
  // Native: из события. VisualViewport: из CSS переменной (последнее нативное значение)
  const nativeKbh = isNativeEvent
    ? (e as CustomEvent).detail?.height ?? 0
    : parseInt(
        getComputedStyle(document.documentElement)
          .getPropertyValue("--native-keyboard-height") || "0", 10);

  // Web: разница между window и viewport (клавиатура «съедает» viewport)
  const vv = window.visualViewport;
  const webKbh = vv ? Math.max(0, window.innerHeight - vv.height) : 0;

  const kbh = computeKeyboardHeight({ isNativeEvent, nativeKbh, webKbh });
  document.documentElement.style.setProperty("--keyboardheight", `${kbh}px`);
};
```

**Подписки:**

```typescript
// visualViewport — резервный источник
vv.addEventListener("resize", updateKeyboardHeight);
vv.addEventListener("scroll", updateKeyboardHeight);  // Samsung toolbar

// native — основной источник
window.addEventListener("native-keyboard-change", updateKeyboardHeight);
```

---

## 5. CSS переменные и утилиты

### Определения

**Файл:** `src/app/styles/main.css` (строки 35–51)

```css
:root {
  --native-keyboard-height: 0px;   /* Устанавливается из MainActivity.kt */
  --keyboardheight: 0px;           /* Устанавливается из App.vue JS */
  --safe-area-inset-top: 0px;      /* Устанавливается из MainActivity.kt */
  --safe-area-inset-right: 0px;
  --safe-area-inset-bottom: 0px;   /* Nav bar height */
  --safe-area-inset-left: 0px;
}

/* Фоллбэк для браузеров с env() поддержкой (iOS Safari, Chrome) */
@supports (padding-top: env(safe-area-inset-top)) {
  :root {
    --safe-area-inset-top: env(safe-area-inset-top, 0);
    --safe-area-inset-bottom: env(safe-area-inset-bottom, 0);
    /* ... */
  }
}
```

**Важно:** На Android-нативе `MainActivity` **перезаписывает** эти переменные реальными значениями. CSS `@supports` — фоллбэк для браузера/iOS.

### Утилитарные классы

**Файл:** `src/app/styles/main.css` (строки 5–30)

```css
@layer utilities {
  /* Верхний отступ: статус-бар / вырез */
  .safe-top {
    padding-top: var(--safe-area-inset-top, 0px);
  }
  
  /* Нижний отступ: клавиатура ИЛИ nav bar (что больше) */
  .safe-bottom {
    padding-bottom: max(var(--keyboardheight, 0px), var(--safe-area-inset-bottom, 0px));
  }
  
  /* Верх + низ — для полноэкранных панелей */
  .safe-y {
    padding-top: var(--safe-area-inset-top, 0px);
    padding-bottom: max(var(--keyboardheight, 0px), var(--safe-area-inset-bottom, 0px));
  }
  
  /* Все стороны — для модалок */
  .safe-all {
    padding-top: var(--safe-area-inset-top, 0px);
    padding-right: var(--safe-area-inset-right, 0px);
    padding-bottom: max(var(--keyboardheight, 0px), var(--safe-area-inset-bottom, 0px));
    padding-left: var(--safe-area-inset-left, 0px);
  }
  
  /* Только safe area без клавиатуры — для bottom sheets */
  .pb-safe {
    padding-bottom: var(--safe-area-inset-bottom, 0px);
  }
}
```

### Формула нижнего отступа

```
padding-bottom = max(keyboardHeight, navBarHeight)
```

| Состояние | --keyboardheight | --safe-area-inset-bottom | padding-bottom |
|-----------|-----------------|-------------------------|----------------|
| Клавиатура закрыта | 0px | 24px (gesture) | 24px |
| Клавиатура закрыта | 0px | 48px (3-button) | 48px |
| Клавиатура открыта | 280px | 24px | 280px |
| Клавиатура + toolbar | 340px | 24px | 340px |

---

## 6. Какие компоненты реагируют на клавиатуру

### Компоненты с `safe-bottom` (поднимаются над клавиатурой)

| Компонент | Файл | Что происходит |
|-----------|------|----------------|
| **ChatWindow** | `src/widgets/chat-window/ChatWindow.vue` | Весь экран чата сдвигается: header + список сообщений + поле ввода |
| **MainLayout** | `src/widgets/layouts/MainLayout.vue` | Общий layout для страниц настроек, профиля |
| **AuthLayout** | `src/widgets/layouts/AuthLayout.vue` | Layout для login/register — поля ввода поднимаются |

### Компоненты с `safe-y` (верх + низ)

| Компонент | Файл | Что происходит |
|-----------|------|----------------|
| **Drawer** (сайдбар) | `src/shared/ui/drawer/ui/Drawer.vue` | Боковая панель учитывает status bar и клавиатуру |
| **ChatInfoPanel** | `src/features/chat-info/ui/ChatInfoPanel.vue` | Информация о чате: отступы сверху и снизу |
| **UserProfilePanel** | `src/features/chat-info/ui/UserProfilePanel.vue` | Профиль пользователя |
| **ChannelInfoPanel** | `src/features/channels/ui/ChannelInfoPanel.vue` | Информация о канале |

### Компоненты с `safe-all` (все стороны)

| Компонент | Файл | Что происходит |
|-----------|------|----------------|
| **Modal** | `src/shared/ui/modal/Modal.vue` | Модальные окна: отступы со всех сторон |
| **IncomingCallModal** | `src/features/video-calls/ui/IncomingCallModal.vue` | Входящий звонок |
| **MediaViewer** | `src/features/messaging/ui/MediaViewer.vue` | Просмотр медиа на полный экран |

### Компоненты с `pb-safe` (только nav bar, без клавиатуры)

| Компонент | Файл | Что происходит |
|-----------|------|----------------|
| **BottomSheet** | `src/shared/ui/bottom-sheet/BottomSheet.vue` | Нижняя шторка: только nav bar |
| **CallWindow** (controls) | `src/features/video-calls/ui/CallWindow.vue` | Панель управления звонком |
| **ForwardPicker** | `src/features/messaging/ui/ForwardPicker.vue` | Выбор чата для пересылки (мобиль) |

### Компонент с inline calc (особый случай)

**MediaPreview** (`src/features/messaging/ui/MediaPreview.vue`, строка 101):

```html
<div style="padding-bottom: calc(max(var(--keyboardheight, 0px), var(--safe-area-inset-bottom, 0px)) + 12px)">
```

Панель подписи к медиа при отправке: отступ = клавиатура/nav bar + 12px дополнительного padding.

---

## 7. Поведение ChatWindow при открытии клавиатуры

### Layout чата (flex column)

```
ChatWindow (safe-bottom → padding-bottom увеличивается)
│
├── Header (shrink-0)           — фиксированная высота, НЕ сжимается
│
├── MessageList (flex-1 min-h-0) — СЖИМАЕТСЯ при росте padding-bottom
│   └── ChatVirtualScroller     — h-full, column-reverse
│       └── Сообщения...        — скролл автоматически
│
├── UnreadBanner               — между списком и input
│
└── MessageInput (shrink-0)    — фиксированная высота, НЕ сжимается
```

**Как работает:**

1. Клавиатура открывается → `--keyboardheight` увеличивается (напр. 0 → 280px)
2. `safe-bottom` на ChatWindow → `padding-bottom: 280px`
3. Flex-контейнер пересчитывает → `flex-1` у MessageList **уменьшается** на 280px
4. ChatVirtualScroller (`h-full`) → высота уменьшается
5. MessageInput **остаётся прижат** к нижнему краю доступной области (над padding)
6. Сообщения видны в уменьшенной области, скролл работает

**Ключевой момент:** Поле ввода **не сдвигается абсолютно** — оно «поднимается» потому что `padding-bottom` выталкивает его вверх в flex-колонке.

---

## 8. MessageInput: взаимодействие с клавиатурой

### `data-keyboard-aware` атрибут

**Файл:** `src/features/messaging/ui/MessageInput.vue` (строка 812)

```html
<textarea
  ref="textareaRef" v-model="text"
  data-keyboard-aware
  ...
/>
```

**Зачем:** Глобальный `focusin` в `App.vue` вызывает `scrollIntoView` для всех INPUT/TEXTAREA. Но MessageInput **уже позиционирован** через `safe-bottom` — дополнительный скролл не нужен и может вызвать дёрганье. `data-keyboard-aware` исключает элемент из глобального обработчика.

### Редактирование сообщения — свой scrollIntoView

**Файл:** `src/features/messaging/ui/MessageInput.vue` (строки 105–118)

```typescript
watch(() => chatStore.editingMessage, (editing) => {
  if (editing) {
    text.value = editing.content;
    nextTick(() => {
      autoGrowSync();
      textareaRef.value?.focus();
      // Скролл контейнера ввода в видимую область после анимации клавиатуры (~400ms)
      // block:"end" — чтобы input был внизу, а не по центру
      setTimeout(() => {
        inputRootRef.value?.scrollIntoView({ block: "end", behavior: "smooth" });
      }, 400);
    });
  }
}, { immediate: true });
```

**Задержка 400ms** — ожидание анимации клавиатуры Android (~300ms).

### Reply и Forward — только фокус

```typescript
watch(() => chatStore.replyingTo, (reply) => {
  if (reply) nextTick(() => textareaRef.value?.focus());
});
watch(() => chatStore.forwardingMessage, (fwd) => {
  if (fwd) nextTick(() => textareaRef.value?.focus());
});
```

Без `scrollIntoView` — полагаются на `safe-bottom` + flex layout.

---

## 9. Глобальный focusin (scrollIntoView для остальных полей)

**Файл:** `src/app/App.vue` (строки 270–281)

```typescript
if (isNative) {
  const handleFocusIn = (e: FocusEvent) => {
    const target = e.target as HTMLElement;
    if (shouldScrollIntoView(target)) {
      const scrollIt = () => target.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(scrollIt, 300);   // 1-й проход: клавиатура появляется
      setTimeout(scrollIt, 600);   // 2-й проход: toolbar клавиатуры раскрывается (Samsung)
    }
  };
  document.addEventListener("focusin", handleFocusIn);
}
```

**Два прохода:** некоторые клавиатуры (Samsung, SwiftKey) сначала показывают основную клавиатуру (~300ms), потом доп. toolbar (~600ms). Один `scrollIntoView` может не учесть вторую фазу.

### Какие элементы обрабатываются

```typescript
export function shouldScrollIntoView(target: HTMLElement): boolean {
  if (target.dataset?.keyboardAware !== undefined) return false;  // исключение
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}
```

| Элемент | Обработка |
|---------|-----------|
| MessageInput textarea | **НЕТ** (data-keyboard-aware) |
| Login/Register поля | **ДА** (scrollIntoView center) |
| Profile edit поля | **ДА** (scrollIntoView center) |
| Search input | **ДА** (scrollIntoView center) |
| MediaPreview caption | **ДА** (scrollIntoView center) |

---

## 10. ChatVirtualScroller и клавиатура

**Файл:** `src/shared/ui/ChatVirtualScroller.vue`

Скроллер **НЕ знает** о клавиатуре:

- Нет подписки на `--keyboardheight`
- Нет обработки keyboard events
- Размер контейнера меняется через flex layout (родительский `safe-bottom`)

```html
<div ref="containerRef"
     style="display: flex; flex-direction: column-reverse"
     class="overflow-y-auto overflow-x-hidden"
     @scroll.passive="onScroll">
```

**Как адаптируется:**
- `h-full` наследует высоту от родителя
- Родитель (`MessageList`) имеет `flex-1 min-h-0` → его высота уменьшается при `safe-bottom`
- `column-reverse` → новые сообщения всегда внизу
- При уменьшении контейнера `scrollTop = 0` остаётся «у новых»

---

## 11. use-read-tracker: пересканирование при клавиатуре

**Файл:** `src/features/messaging/model/use-read-tracker.ts`

### ResizeObserver на скролл-контейнере

```typescript
// Handles mobile keyboard show/hide, dynamic toolbar collapse/expand,
// and iOS safe-area changes that shift visible content.
function onContainerResize() {
  if (resizeScanTimer !== null) clearTimeout(resizeScanTimer);
  resizeScanTimer = setTimeout(() => {
    resizeScanTimer = null;
    scanViewport();
    flushBatch();
  }, RESIZE_SCAN_DEBOUNCE_MS);  // 200ms debounce
}

resizeObserver = new ResizeObserver(onContainerResize);
resizeObserver.observe(root);
```

**Зачем:** `IntersectionObserver` может не заметить что сообщения стали видимыми/невидимыми когда контейнер изменил размер из-за клавиатуры. `ResizeObserver` перезапускает сканирование видимости.

### Настройки под мобильные

```typescript
const VISIBILITY_THRESHOLD = 0.3;   // 30% видимости (был 50%, понижен для мобиле)
const RESIZE_SCAN_DEBOUNCE_MS = 200; // пересканирование через 200ms после resize
const DELAYED_SCAN_MS = 500;         // доп. сканирование для медленного mobile layout
```

---

## 12. Поведение на разных платформах

### Android Native (Capacitor)

```
Клавиатура открывается:
  1. WindowInsetsCompat → keyboardHeight = 280dp
  2. injectKeyboardHeight() → --native-keyboard-height: 280px
  3. CustomEvent('native-keyboard-change', { height: 280 })
  4. App.vue: --keyboardheight: 280px
  5. CSS: safe-bottom padding-bottom: 280px
  6. Flex layout: MessageList сжимается
  7. focusin: scrollIntoView для обычных полей (не chat)
  
Клавиатура закрывается:
  1. WindowInsetsCompat → keyboardHeight = 0
  2. --native-keyboard-height: 0px
  3. CustomEvent('native-keyboard-change', { height: 0 })
  4. --keyboardheight: 0px
  5. padding-bottom: max(0, navBar) = navBar
```

### Мобильный браузер (Web)

```
Клавиатура открывается:
  1. visualViewport resize → webKbh = innerHeight - vv.height
  2. nativeKbh = 0 (нет нативного кода)
  3. computeKeyboardHeight → max(webKbh, 0) = webKbh
  4. --keyboardheight: webKbh
  5. CSS safe-bottom работает аналогично
  
Клавиатура закрывается:
  1. visualViewport resize → webKbh = 0
  2. --keyboardheight: 0px
```

### iOS Safari (Web)

```
Клавиатура:
  - visualViewport.resize срабатывает
  - env(safe-area-inset-bottom) даёт home indicator
  - env(keyboard-inset-bottom) НЕ используется (нет поддержки)
  
Потенциальные проблемы:
  - iOS может скроллить viewport вместо resize
  - Bounce-эффект может мешать вычислению высоты
```

### Desktop (Electron / браузер)

```
Клавиатура отсутствует:
  - --keyboardheight: 0px
  - --safe-area-inset-*: 0px
  - safe-bottom = padding-bottom: 0px
  - Весь viewport под контент
```

---

## 13. Потенциальные проблемы (из жалоб пользователей)

### «Строка ввода скрыта клавиатурой»

**Возможные причины:**

1. **`WindowInsetsCompat` не срабатывает** на устройстве → `--native-keyboard-height: 0px` → `safe-bottom` даёт только nav bar отступ → MessageInput под клавиатурой
   - Некоторые OEM прошивки (Xiaomi MIUI, Huawei EMUI) некорректно сообщают IME insets

2. **`visualViewport` не fire** → web fallback не работает → `--keyboardheight: 0px`
   - Старые WebView (Android 7–8) могут не поддерживать visualViewport

3. **Race condition при открытии**: нативное событие приходит до рендера WebView → CSS переменная сбрасывается → дублирующая инжекция через 1s (`postDelayed`) может не успеть

4. **Samsung Keyboard toolbar**: высота меняется в два этапа → промежуточное состояние с неправильным padding

5. **Сторонние клавиатуры** (SwiftKey, Gboard с доп. строкой): могут сообщать нестандартную высоту → защита 60% экрана может обрезать

6. **CSS переменная перезаписана**: `@supports` блок или другой стиль может перезаписать `--safe-area-inset-bottom` → неправильный `max()`

### «Поле ввода дёргается»

**Возможная причина:** одновременное срабатывание `native-keyboard-change` и `visualViewport resize` с разными значениями → `--keyboardheight` меняется дважды за короткий промежуток.

---

## Полная карта CSS переменных

| Переменная | Кто устанавливает | Когда обновляется | Значение |
|------------|-------------------|-------------------|----------|
| `--safe-area-inset-top` | MainActivity.kt | Однократно + onResume | Status bar в dp (px) |
| `--safe-area-inset-bottom` | MainActivity.kt | Однократно + onResume | Nav bar в dp (px) |
| `--safe-area-inset-left` | MainActivity.kt | Однократно + onResume | Обычно 0 |
| `--safe-area-inset-right` | MainActivity.kt | Однократно + onResume | Обычно 0 |
| `--native-keyboard-height` | MainActivity.kt | При каждом изменении IME | Чистая высота клавиатуры в dp (px) |
| `--keyboardheight` | App.vue (JS) | При каждом keyboard event | Итоговая высота для CSS |

---

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `android/app/src/main/AndroidManifest.xml` | `windowSoftInputMode="adjustNothing"` |
| `android/app/src/main/java/com/forta/chat/MainActivity.kt` | Edge-to-edge, WindowInsetsCompat, inject CSS/JS |
| `android/app/src/main/res/values/styles.xml` | Прозрачные системные панели |
| `src/shared/lib/keyboard-height.ts` | `computeKeyboardHeight`, `shouldScrollIntoView` |
| `src/shared/lib/keyboard-height.test.ts` | Тесты логики |
| `src/app/App.vue` | `updateKeyboardHeight`, `focusin` handler |
| `src/app/styles/main.css` | CSS утилиты: `safe-bottom`, `safe-y`, `safe-all`, `pb-safe` |
| `src/features/messaging/ui/MessageInput.vue` | `data-keyboard-aware`, scrollIntoView при edit |
| `src/shared/ui/ChatVirtualScroller.vue` | Инвертированный скролл (не знает о клавиатуре) |
| `src/features/messaging/model/use-read-tracker.ts` | ResizeObserver для пересканирования |
| `src/widgets/chat-window/ChatWindow.vue` | `safe-bottom` на корневом контейнере чата |
| `src/widgets/layouts/MainLayout.vue` | `safe-bottom` на layout страниц |
| `src/widgets/layouts/AuthLayout.vue` | `safe-bottom` на login/register |
| `src/features/messaging/ui/MediaPreview.vue` | Inline calc с `--keyboardheight` |
| `src/shared/ui/modal/Modal.vue` | `safe-all` для модалок |
| `src/shared/ui/drawer/ui/Drawer.vue` | `safe-y` для сайдбара |
| `capacitor.config.ts` | Нет @capacitor/keyboard |
| `tailwind.config.js` | Spacing переменные для keyboard/safe-area |
