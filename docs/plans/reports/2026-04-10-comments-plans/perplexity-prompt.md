# Введение

Мы построили приложение decentralized chat (Forta Chat). У нас есть Список всех проблем чата. Так же два раздела, описывающие архитектуру и код (обзор архитектуры конкретного проблемного места и общий обзор архитектуры). 

# Список всех проблем чата

🔴 1. Проблемы с установкой / скачиванием

Симптомы:

«нажимаю скачать — ничего не происходит»
«APK не фурычит»
«не получилось скачать / установить»
ссылка ведёт на Bastyon вместо Forta
GitHub: «непонятно куда нажимать», «нет ссылок»
iOS: «что делать — непонятно»
«открывается Google Play и предлагает Bastyon»
«в браузере открылось, а как приложение не установить»

Пользователи:
ANGELrus, Romwer, smallav, VIP3, Drug77777, Vidalocha, REGIS1, Neeka, ElinaKi, AnSal, Pa314PyC, Varya3, XYZit965

🔴 2. Проблемы с регистрацией / входом

Симптомы:

«регистрация зависла между шагами (2–3)»
«подготовка аккаунта — висит»
«регистрация в блокчейне тянулась 1.5 часа»
«не принимает кодовые слова (seed)»
«ключ от Bastyon не подходит»
«ошибка входа»
«имя не то ввёл / капча не проходит»
«просит приватный ключ — где брать?»

Пользователи:
ATMAH, 777Rusish, Elizavetiys, Godz, Ravil1970, Kamkurt, Yscog, firstName

🔴 3. Проблемы с загрузкой / доступом / сетью

Симптомы:

«не грузится»
«страница зависает на 2/3 загрузки»
«открывается только с VPN»
«без VPN не открывается вообще»
«ссылка тормозит»
«в “белых списках” (ограниченный интернет) не работает»
«иногда работает, иногда нет»

Пользователи:
VDT, ab3, Vidalocha, PinkiePie, apgru, Hvoevoda, Stihotvoreniya

🔴 4. Проблемы с UI / баги интерфейса

Симптомы:

«не листает»
«кнопка “сохранить” не активна»
«нельзя изменить имя / профиль / аватар»
«строка ввода скрыта клавиатурой (не видно текст)»
«кнопка возврата к новым сообщениям не работает»
«висит “New message”, хотя всё прочитано»

Пользователи:
Tanne1980, Ric0, Dmitriy7778, E_D, ATMAH

🔴 5. Проблемы с отправкой сообщений

Симптомы:

«сообщение становится серым и не отправляется»
«не отправляются вообще (и с ПК, и с телефона)»
«ошибка: получатель не предоставил ключи шифрования»
«иногда помогает перезапуск приложения»

Пользователи:
PinkiePie, Vladimir_Nikolaevich, Ric0

🔴 6. Проблемы со звонками (критично)

Симптомы:

«звонок идёт, но принять нельзя (бесконечное соединение)»
«связь односторонняя»
«вообще не работает аудио»
«работает только по громкой связи»
«если приложение закрыто — звонок не приходит»
«случайно запретил звонки — непонятно как вернуть»

Пользователи:
Pumpa, Probius, Pokrovski63, RittaMargaritta, Vadimich75, Veryuvsebya

🔴 7. Проблемы с уведомлениями

Симптомы:

«уведомления не приходят без Google Play Services»
«с Google — приходят, без — нет»
«в других мессенджерах всё работает»

Пользователи:
0xygenium

🔴 8. Ограничения функциональности

Симптомы:

«нельзя создать группу без приглашений»
«нет десктоп версии»
«нет версии для iOS / Windows / Linux»
«нет сортировки комментариев»
«нет настройки уведомлений внутри приложения»

Пользователи:
SBOGOMVPUT, TanyaNK, AGENT47, Vadivostok, art_shkumat, rezosim, Oliverconsult

🔴 9. Проблемы с языком (локализация)

Симптомы:

«всё на английском — непонятно»
«нужно переводить со словарём»
«нет переключения на русский»

Пользователи:
XYZit965, Tishya, Gneba, REGIS1

🔴 10. Проблемы с устройствами / совместимостью

Симптомы:

«не запускается на Honor 10X Lite»
«Android 16 — не работают чаты и профиль»
«ошибка на Cubot P80»

Пользователи:
Tanne1980, REGIS1, Dmitriy7778

🔴 11. UX / онбординг (очень важный блок)

Симптомы:

«не понимаю что делать дальше»
«непонятно как установить»
«где взять ключ?»
«как войти?»
«нужна видео-инструкция»
«что выбрать из нескольких вариантов?»
«это отдельное приложение или через браузер?»

Пользователи:
FlerDeLiz, XYZit965, Tishya, REGIS1, Elizavetiys, Pokrovski63

🔴 12. Иконка / доступ / запуск

Симптомы:

«как вывести иконку на экран телефона»
«установил, но как теперь открыть — непонятно»

Пользователи:
Pokrovski63, ElinaKi

🔴 13. Аккаунт / синхронизация

Симптомы:

«имя не сохраняется (остаётся “Аноним”)»
«не синхронизируется с Bastyon»
«ключи не подходят между сервисами»

Пользователи:
ATMAH, Yashka_cigan

🔴 14. Клавиатура

Симптомы:

Пользователи сообщают: «строка ввода скрыта клавиатурой (не видно текст)», поле ввода перекрывается при открытии клавиатуры на Android и других платформах. Иногда некоторые поля сдвигаются в два раза больше чем должны.

Пользователи:
maxim

🟡 Дополнительные технические сигналы
⚠️ VPN-зависимость

Симптомы:

«без VPN не работает»
«с VPN работает везде»
«иногда работает без VPN, иногда нет»

Пользователи:
Stihotvoreniya, ab3, 6ear

⚠️ Потеря соединения

Симптомы:

«во время переписки пропадает соединение»
«нужно перезапускать приложение»

Пользователи:
Yashka_cigan

⚠️ Путаница продуктов

Симптомы:

«Bastyon и Forta — это одно или нет?»
«зачем отдельное приложение?»

Пользователи:
ASTROVAL, FlerDeLiz, RUSSIAN_WARRIOR

---

# Forta Chat — обзор архитектуры конкретного проблемного места

---

# Forta Chat — общий обзор архитектуры

## Что такое Forta Chat

Forta Chat — гибридный мессенджер, объединяющий два независимых бэкенда:

- **Matrix** (homeserver `matrix.pocketnet.app`) — для обмена сообщениями, синхронизации, VoIP-звонков
- **Pocketnet/Bastyon blockchain** — для идентичности пользователей, хранения профилей, E2E-ключей и криптовалютных переводов (PKOIN)

Шифрование реализовано не через стандартный Matrix Olm/Megolm, а через кастомный **Pcrypto** (порт из bastyon-chat): secp256k1 ECDH + AES-SIV для 1:1 и AES-CBC + общий ключ для групп.

---

## Гибридное SPA-приложение

### Единая кодовая база — четыре целевых платформы

Forta Chat — это **один Vue 3 SPA**, который работает в четырёх разных средах выполнения:

```
                    ┌──────────────────────────────┐
                    │     Vue 3 SPA (Vite build)    │
                    │                                │
                    │  TypeScript + Composition API  │
                    │  Pinia stores + Dexie (IDB)   │
                    │  matrix-js-sdk-bastyon         │
                    └────────┬───────────────────────┘
                             │
        ┌────────────────────┼──────────────────────┐
        │                    │                       │
   ┌────▼────┐      ┌───────▼───────┐      ┌───────▼──────┐
   │  Web     │      │  Capacitor    │      │  Electron    │
   │ Browser  │      │  Android      │      │  Desktop     │
   │          │      │  (WebView)    │      │  (Chromium)  │
   └──────────┘      └───────────────┘      └──────────────┘
                             │
                    ┌────────▼────────┐
                    │ Нативные плагины │
                    │ (Kotlin/Java)   │
                    │ WebRTC, Calls,  │
                    │ Push, Tor, FS   │
                    └─────────────────┘
```

| Платформа | Среда выполнения | Особенности |
|-----------|-----------------|-------------|
| **Web** | Любой современный браузер | Нет нативных API, нет push, нет Tor |
| **Android** | Capacitor WebView (`androidScheme: 'https'`) | Нативные плагины, FCM push, edge-to-edge, Tor daemon |
| **Windows / macOS / Linux** | Electron BrowserWindow | Кастомная схема `app://`, Tor через main process, IPC для файлов |
| **iOS** | Заявлена в коде (`isIOS`), но не реализована | Нет `ios/` директории, нет Capacitor iOS |

### Детекция платформы

`src/shared/lib/platform/index.ts` экспортирует флаги, которые используются повсеместно для ветвления логики:

```typescript
isNative    // Capacitor.isNativePlatform() — Android/iOS
isAndroid   // Capacitor.getPlatform() === 'android'
isIOS       // Capacitor.getPlatform() === 'ios'
isElectron  // window.electronAPI?.isElectron
isWeb       // !isNative && !isElectron
isMobile    // mobile user-agent (включая мобильный браузер)
```

Ветвление происходит на каждом уровне:
- **UI:** клавиатура, навигация (back handler), status bar, safe area
- **Сеть:** Tor proxy (натив/Electron), push (только натив)
- **Медиа:** WebRTC через нативный стек или браузерный
- **Хранение:** Filesystem API (натив) vs download (web)

---

## Технологический стек

### Frontend (единый)

| Технология | Версия | Назначение |
|------------|--------|------------|
| **Vue 3** | ^3.4 | UI framework, Composition API |
| **Pinia** | ^2.2 | State management |
| **Vue Router** | 4 | Hash-based routing (`/#/...`) |
| **TypeScript** | ^5.5 | Типизация |
| **Vite** | ^5.3 | Сборка, dev server |
| **Tailwind CSS** | ^3.4 | Стили |
| **Dexie** | ^4.3 | IndexedDB ORM (local-first storage) |
| **matrix-js-sdk-bastyon** | ^23.2 | Matrix protocol client (fork) |
| **axios** | ^0.21 | HTTP transport для Matrix |

### Криптография

| Библиотека | Назначение |
|------------|------------|
| `@noble/secp256k1` | Эллиптические кривые для Pcrypto |
| `miscreant` | AES-SIV шифрование (1:1 чаты) |
| `pbkdf2`, `create-hash` | Ключи для файлов и групп |
| `bn.js`, `buffer` | BigNumber и Buffer полифиллы |
| `bitcoinjs-lib` (через window) | Адреса, транзакции Pocketnet |

### Мобильный (Android)

| Технология | Назначение |
|------------|------------|
| **Capacitor** ^8.2 | Мост JS ↔ Native |
| **WebRTC SDK** (io.github.webrtc-sdk) | Нативный WebRTC стек |
| **Firebase Messaging** 25.0.1 | Push уведомления |
| **AndroidX SplashScreen** | Нативный splash |
| Кастомные плагины | `NativeWebRTC`, `NativeCall`, `PushData`, `Tor`, `AppLocale` |

### Desktop

| Технология | Назначение |
|------------|------------|
| **Electron** ^40.6 | Desktop-оболочка |
| **electron-builder** ^26.8 | Сборка nsis/dmg/AppImage |
| Tor (встроенный) | Обход блокировок через main process |

---

## Архитектура: Feature-Sliced Design

```
src/
├── app/              # Точка входа, провайдеры, роутинг, стили
│   ├── providers/    # Boot pipeline, router, chat-scripts, initializers
│   └── styles/       # Tailwind + утилиты safe area
│
├── pages/            # Экраны (Welcome, Login, Register, Chat, Settings, Profile)
│
├── widgets/          # Составные блоки UI (ChatWindow, Sidebar, Layouts)
│
├── features/         # Бизнес-сценарии
│   ├── messaging/    # Отправка/получение сообщений, ввод, медиа
│   ├── video-calls/  # WebRTC звонки
│   ├── contacts/     # Контакты и поиск
│   ├── channels/     # Лента Bastyon-каналов
│   ├── auth/         # UI авторизации (формы, stepper)
│   ├── wallet/       # Криптовалютные переводы
│   └── ...
│
├── entities/         # Доменные сущности
│   ├── auth/         # Store авторизации, SessionManager, BackgroundSync
│   ├── chat/         # ChatStore — связка Matrix ↔ Dexie
│   ├── matrix/       # MatrixClientService, Pcrypto
│   ├── call/         # CallStore
│   ├── channel/      # ChannelStore (Bastyon лента)
│   ├── user/         # Профили пользователей
│   ├── theme/        # Тема оформления
│   └── locale/       # i18n (en/ru)
│
└── shared/           # Общие утилиты
    ├── ui/           # Компоненты (ChatVirtualScroller, Modal, Drawer, BottomSheet)
    ├── lib/
    │   ├── local-db/ # Dexie: SyncEngine, EventWriter, MessageRepository, schema
    │   ├── push/     # Push-уведомления (FCM)
    │   ├── tor/      # Tor-сервис
    │   ├── native-webrtc/  # WebRTC proxy для Android
    │   ├── native-calls/   # Мост звонков JS ↔ Android
    │   └── platform/ # Детекция платформы
    └── config/       # Константы (серверы, URL)
```

---

## Сетевые зависимости

Приложение зависит от нескольких внешних серверов:

| Сервер | Порт | Назначение | Критичность |
|--------|------|------------|-------------|
| `matrix.pocketnet.app` | 443 | Matrix homeserver + push gateway | **Критичный** — без него нет чатов |
| `1/2/6.pocketnet.app` | 8899 | Pocketnet RPC (блокчейн) | Критичный для регистрации, профилей, переводов |
| `*.pocketnet.app` | 8099 | WebSocket | Realtime blockchain events |
| `pocketnet.app` | 9090/9091 | WebRTC signaling | Критичный для звонков |
| `pocketnet.app` | 8092 | Upload (файлы, аватары) | Для медиа |

Все URL **хардкожены** в `src/shared/config/constants.ts`. Нет fallback-серверов, нет DNS-over-HTTPS, нет CDN.

---

## Интернет-соединение: как приложение держит связь

### Matrix Sync — основной канал

```
Приложение ──long-poll──▶ matrix.pocketnet.app/_matrix/client/v3/sync
                          (timeout: 60s, filter, since: nextBatch)
```

- SDK поддерживает постоянный long-poll к `/sync`
- При обрыве: встроенный exponential backoff
- `retryImmediately()` обходит backoff в критических случаях (возврат из фона, push)

### Состояния sync

| Состояние | Значение | Реакция приложения |
|-----------|----------|-----|
| `PREPARED` | Первичная синхронизация завершена | `roomsInitialized = true`, UI готов |
| `SYNCING` | Штатная работа | Обновление комнат, сообщений |
| `ERROR` | Ошибка подключения | `retryImmediately()`, UI: «Reconnecting...» |
| `RECONNECTING` | SDK пытается переподключиться | UI: индикатор |
| `STOPPED` | Sync остановлен | Логирование |

### Переходы при потере/восстановлении сети

```
Онлайн → Офлайн:
  1. window "offline" → SyncEngine.setOnline(false) → очередь паузится
  2. Matrix long-poll отваливается → sync "ERROR"
  3. SDK backoff начинает расти

Офлайн → Онлайн:
  1. window "online" → SyncEngine.setOnline(true) → processQueue()
  2. DecryptionWorker.retryAllWaiting()
  3. Matrix SDK retry → sync "SYNCING"
  4. Если был disconnect → chatStore.refreshRooms("PREPARED") — полное обновление

Фон → Передний план (Android):
  1. appStateChange(isActive: true)
  2. matrixService.client.retryImmediately() — обход backoff
  3. Обновление unread, комнат

Push при убитом приложении:
  1. FCM → нативное уведомление (без JS)
  2. Тап → холодный старт → полная инициализация
```

---

## Работа в офлайне: Local-First на Dexie

### Принцип

**Dexie (IndexedDB) = single source of truth для UI.** Все данные читаются через `useLiveQuery` — реактивные запросы к IndexedDB. Matrix и блокчейн — источники синхронизации, а не прямого чтения.

### Dexie Schema (на пользователя)

База: `bastyon-chat-{userId}`, 10 версий миграций.

| Таблица | Ключевые поля | Назначение |
|---------|---------------|------------|
| `rooms` | roomId, lastMessageTimestamp, unreadCount, tombstone | Комнаты + превью |
| `messages` | localId, eventId, clientId, roomId, status | Сообщения (local-first) |
| `users` | address | Кэш профилей |
| `pendingOps` | id, type, roomId, status, retries | Очередь исходящих |
| `syncState` | key, value | Sync token, флаги |
| `attachments` | id, roomId | Локальные файлы до upload |
| `decryptionQueue` | eventId, roomId | Повторы расшифровки |
| `listenedMessages` | eventId | Отметки прослушивания голосовых |

### SyncEngine — очередь исходящих

```
Пользователь отправляет сообщение:
  1. MessageRepository.createLocal() → Dexie (status: "pending")
  2. UI мгновенно показывает сообщение (оптимистичный рендер)
  3. SyncEngine.enqueue("send_message", roomId, payload, clientId)
  4. SyncEngine.processQueue():
     → шифрование через Pcrypto (если canBeEncrypt)
     → MatrixClientService.sendEvent()
     → MessageRepository.confirmSent() → status: "synced"
  
  При ошибке:
     → retry с exponential backoff + jitter
     → после maxRetries (5) → status: "failed" → UI: "Tap to retry"
  
  При офлайне:
     → SyncEngine.setOnline(false) → обработка приостановлена
     → Операции остаются в pendingOps
     → При online → processQueue() → отправка накопленного
```

### EventWriter — входящие

```
Matrix sync → timeline event:
  1. chat-store.handleTimelineEvent() → разбор типа, расшифровка
  2. EventWriter.writeMessage() / writeMessageBuffered()
     → WriteBuffer (delay: 150ms, batch: 50)
     → Dexie транзакция: upsert message + update room preview
  3. useLiveQuery → UI реактивно обновляется
  
  Дедупликация:
     → MessageRepository.upsertFromServer() матчит по clientId
     → Echo обновляет pending → synced (без дубля)
```

### Что доступно офлайн

| Функция | Офлайн | Примечание |
|---------|--------|------------|
| Просмотр чатов и сообщений | Да | Из Dexie через useLiveQuery |
| Отправка сообщений | Частично | Записывается в Dexie, отправка при online |
| Новые входящие | Нет | Требуется Matrix sync |
| Регистрация/вход | Нет | Требуется блокчейн + Matrix |
| Звонки | Нет | Требуется WebRTC + signaling |
| Push-уведомления | Нет | Требуется FCM |

---

## Неустойчивое соединение: что учитывать

### Многоуровневая устойчивость

```
                     Слой                    Механизм
                 ─────────────────────────────────────────
            1.   Matrix SDK              Long-poll + backoff
            2.   SyncEngine              FIFO queue + retry 5x
            3.   EventWriter             Buffered writes + dedup
            4.   DecryptionWorker        Retry queue для расшифровки
            5.   BackgroundSyncManager   Polling неактивных аккаунтов
            6.   Capacitor resume        retryImmediately при выходе из фона
            7.   Push fast-path          Оптимистичное обновление из push data
```

### Проблемные сценарии

| Сценарий | Поведение | Слабое место |
|----------|-----------|--------------|
| Потеря сети на 5 секунд | SDK retry, SyncEngine продолжает | Прозрачно |
| Потеря сети на 5 минут | Backoff растёт, сообщения в очереди | Может потребоваться ручной refresh |
| Android уходит в фон на час | WebView suspended, sync отваливается | При resume: `retryImmediately()`, но gap в сообщениях |
| Очень медленный интернет | Таймауты Matrix init (45s), boot timeout (60s) | Приложение не загрузится при первом запуске |
| Переключение WiFi ↔ Cellular | Browser fire online/offline | SDK может зависнуть в backoff |
| WebView убит системой | Потеря JS-состояния | Холодный старт, recoverStrandedOps |

### Таймауты

| Операция | Таймаут | Где |
|----------|---------|-----|
| Boot (общий) | 60s | `src/app/index.ts` |
| Chat scripts loading | 30s | `src/app/providers/index.ts` |
| Matrix init | 45s | `src/entities/auth/model/stores.ts` |
| IndexedDB startup | 10s | `src/entities/matrix/model/matrix-client.ts` |
| Matrix sync poll | 60s | `startClient({ pollTimeout })` |
| HTTP request (axios) | 30s | `MatrixClientService.request()` |
| SyncEngine max backoff | 30s | `sync-engine.ts` |
| Incoming call timeout | 30s | `call-service.ts` |

---

## Мультиаккаунт

- До **5 аккаунтов** в `SessionManager` (localStorage)
- Активный аккаунт: полный Matrix sync + Dexie
- Неактивные: `BackgroundSyncManager` — лёгкий HTTP polling каждые 30s (foreground) / 300s (background) для unread count
- Переключение: демоция текущего → активация нового → `initMatrix()` заново

---

## Что нужно учитывать для мультиплатформенной системы

### 1. Разные среды WebView

| Среда | Особенности |
|-------|-------------|
| Chrome Android WebView | Обновляется отдельно, может быть устаревшим |
| Huawei без GMS | WebView от Huawei, может не поддерживать API |
| Samsung Internet WebView | Особый `scroll` вместо `resize` для клавиатуры |
| Desktop Chrome (Electron) | Полный API, стабильный |
| Safari iOS (будущее) | Другая модель клавиатуры, env() safe-area, bounce |

### 2. Нативные различия Android

- **Клавиатура:** `adjustNothing` + ручное управление через `WindowInsetsCompat`
- **Edge-to-edge:** контент под системными панелями, CSS `--safe-area-inset-*`
- **Background:** WebView может быть убит, FCM push — единственный способ разбудить
- **Battery optimization:** OEM-специфичные ограничения (Xiaomi, Samsung, Huawei)
- **Permissions:** Runtime permissions для камеры, микрофона, уведомлений

### 3. Сетевые ограничения

- Все серверы на `pocketnet.app` → единая точка блокировки
- Нестандартные порты (8899, 8099, 9090, 9091) → корпоративные файрволлы
- Нет CDN/edge → задержки зависят от расстояния до серверов
- Tor — частичное решение (натив/Electron, не веб)

### 4. Хранилище

- **IndexedDB** ограничено на мобильных (quota varies by device)
- Две параллельные базы: Dexie (приложение) + matrix-js-sdk IndexedDB (SDK)
- При очистке кэша браузера — потеря данных
- Нет cloud backup для чатов

### 5. Криптография

- **Детерминированные ключи:** из одного приватника → адрес + 12 E2E ключей
- **Pcrypto:** не стандартный Matrix E2EE → несовместимость с другими Matrix-клиентами
- **Ключи в localStorage:** потеря данных при очистке → потеря access token
- **Мнемоника:** единственный способ восстановления → пользователь должен сохранить

---

## Ключевые файлы для понимания архитектуры

| Область | Файлы |
|---------|-------|
| Boot pipeline | `src/app/index.ts`, `src/app/providers/index.ts` |
| Platform detection | `src/shared/lib/platform/index.ts` |
| Matrix client | `src/entities/matrix/model/matrix-client.ts` |
| Auth + init | `src/entities/auth/model/stores.ts` |
| Chat store | `src/entities/chat/model/chat-store.ts` |
| Dexie schema | `src/shared/lib/local-db/schema.ts` |
| SyncEngine | `src/shared/lib/local-db/sync-engine.ts` |
| EventWriter | `src/shared/lib/local-db/event-writer.ts` |
| Pcrypto | `src/entities/matrix/model/matrix-crypto.ts` |
| Keyboard | `src/shared/lib/keyboard-height.ts`, `MainActivity.kt` |
| Constants | `src/shared/config/constants.ts` |
| Electron main | `electron/main.cjs` |
| Capacitor config | `capacitor.config.ts` |
| Android manifest | `android/app/src/main/AndroidManifest.xml` |


---
# Комментарий разработчика

---
# Задача
Текущая проблема - Работа с клавиатурой на мобильных устройствах
Проведи детальное исследование и дай инструкцию, как именно исправить текущую проблему и не сломать ничего.