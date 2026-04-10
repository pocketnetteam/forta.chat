# Архитектура: Ограничения функциональности

## Связь с проблемой

Пользователи сообщают: «нельзя создать группу без приглашений», «нет десктоп версии», «нет версии для iOS / Windows / Linux», «нет сортировки комментариев», «нет настройки уведомлений внутри приложения».

## Создание групп

### Текущая реализация

`src/features/group-creation/model/use-group-creation.ts` + `GroupCreationPanel.vue`:

**Двухшаговый мастер:**
1. Шаг 1: выбор участников (обязательно ≥ 1)
2. Шаг 2: имя группы, аватар

### Matrix createRoom

```typescript
matrixService.createRoom({
  name: groupName,
  visibility: "private",
  invite: selectedMemberIds,  // Matrix user IDs
  initial_state: [
    { type: "m.set.encrypted", ... },
    // опционально: m.room.avatar
  ],
  power_level_content_override: {
    // создатель: 100, invite: 0
  }
})
```

### Проблема «нельзя создать группу без приглашений»

**Подтверждено в коде:** валидация требует `selectedMembers.size >= 1`, массив `invite` всегда непустой. Создание пустой группы **не поддерживается через UI**.

На уровне Matrix API это возможно (пустой `invite`), но мастер это блокирует.

## Каналы

### Каналы в Forta ≠ публичные комнаты Matrix

`src/features/channels/` — это **лента подписок Bastyon**, не каталог Matrix-комнат:

- `useChannelStore` → `fetchChannels()` → `authStore.getSubscribesChannels()`
- Посты: `fetchPosts` → `authStore.getProfileFeed(channelAddress, ...)`
- UI: `ChannelList.vue`, `ChannelView.vue`, `ChannelPostBubble.vue`

Текст i18n: `channels.noChannelsHint` — *«подпишитесь на каналы в Bastyon»*.

### Публичные Matrix-комнаты

- `chatStore.isRoomPublic(roomId)` — проверка `join_rule === "public"`
- Админ: `setRoomPublic()` → state event `m.room.join_rules`
- Пригласительная ссылка: `APP_PUBLIC_URL + /#/join?room={roomId}`

**Room Directory (каталог публичных комнат) НЕ реализован** — нет UI для поиска/просмотра.

## Платформы

| Платформа | Статус | Реализация |
|-----------|--------|------------|
| **Web** | Работает | Vite → `dist/` → FTP deploy |
| **Android** | Работает | Capacitor, `minSdk: 24` (Android 7+) |
| **iOS** | НЕ реализована | Только `isIOS` детектор в `platform/index.ts`, каталог `ios/` отсутствует |
| **Windows** | Есть Electron | `electron-builder` → nsis/zip, **CI НЕ настроен** |
| **macOS** | Есть Electron | `electron-builder` → dmg/zip, **CI НЕ настроен** |
| **Linux** | Есть Electron | `electron-builder` → AppImage/deb, **CI НЕ настроен** |

### Electron

- Entry: `electron/main.cjs`
- Конфиг: `electron-builder.json`
- Скрипты: `electron:dev`, `electron:build:win|mac|linux`
- Особенности: кастомная схема `app://`, Tor в main process, IPC

**Проблема «нет десктоп версии»:** Electron-сборка существует в коде, но:
- CI для Electron НЕ настроен
- Нет автоматических релизов
- Нет ссылок на скачивание в приложении

## Настройки

### SettingsPage (`src/pages/settings/SettingsPage.vue`)

Работающие разделы:
- Переход на `AppearancePage`
- Тёмная тема (toggle)
- Tor proxy (натив/Electron)

**Заглушки (placeholder):**
- Уведомления — статический текст «enabled»
- Privacy — статический текст

### AppearancePage (`src/pages/settings/AppearancePage.vue`)

Полная кастомизация:
- Светлая/тёмная тема
- Акцентный цвет (пресеты + custom HEX)
- Фон чата (сплошные, градиенты, custom HEX)
- Размер шрифта
- Плотность сообщений
- Скругление пузырей
- Тумблеры: аватары, метки времени, группировка, анимации
- Быстрые реакции (emoji picker)
- Сброс к умолчанию

Персистенция: `useThemeStore` → `useLocalStorage` + CSS-переменные.

## Чего нет в приложении (по коду)

| Функция | Статус |
|---------|--------|
| Создание группы без участников | Заблокировано в UI |
| Room Directory (каталог комнат) | Нет |
| Настройки уведомлений | Placeholder |
| Настройки приватности | Placeholder |
| Сортировка комментариев/каналов | Нет в UI |
| iOS сборка | Нет |
| Автоматические релизы Desktop | Нет CI |
| Страница скачивания | Нет |
| FAQ / Help раздел | Только одна HTML-страница про ключ |

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/features/group-creation/model/use-group-creation.ts` | Создание группы |
| `src/features/group-creation/ui/GroupCreationPanel.vue` | UI мастера |
| `src/entities/matrix/model/matrix-client.ts` | Matrix createRoom |
| `src/entities/channel/model/channel-store.ts` | Каналы Bastyon |
| `src/features/channels/ui/*.vue` | UI каналов |
| `src/entities/chat/model/chat-store.ts` | Публичные комнаты, join |
| `src/pages/settings/SettingsPage.vue` | Настройки |
| `src/pages/settings/AppearancePage.vue` | Внешний вид |
| `src/entities/theme/model/stores.ts` | Тема, персистенция |
| `electron/main.cjs` | Electron main process |
| `electron-builder.json` | Desktop build config |
| `src/shared/lib/platform/index.ts` | Детекция платформы |
