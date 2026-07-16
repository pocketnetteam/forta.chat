# Tor в Android-приложении Bastyon/PocketNet

Документ описывает, как Tor интегрирован в Android-сборку (Cordova): нативный плагин, Service Worker, перехват сетевых запросов, настройки и статусы в интерфейсе.

> **Важно:** нативный код плагина `cordova.plugins.torRunner` в этом репозитории **отсутствует** — он подключается при сборке Android-приложения отдельным Cordova-плагином. В репозитории есть только JavaScript-слой интеграции. Orbot не используется.

---

## Обзор архитектуры

Android Tor состоит из трёх слоёв:

1. **Нативный плагин `torRunner`** — запускает Tor, хранит настройки, решает, нужен ли Tor для конкретного URL, поднимает локальный HTTP-прокси на порту `8181`.
2. **Service Worker** — перехватывает все `fetch()` в WebView и при необходимости перенаправляет запросы через `http://localhost:8181/...`.
3. **GUI-модули** — иконка «щита» в меню и экран настроек `transportsmanagement`.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Android WebView (Cordova)                                           │
│                                                                     │
│  JS-код приложения: fetch(url), XHR, загрузка ресурсов              │
│       │                                                             │
│       ▼                                                             │
│  Service Worker (service-worker.js?platform=cordova)                │
│       │                                                             │
│       ├─ destination=document → не перехватывается                  │
│       ├─ https://localhost → прямой fetch (локальные blob-URL)    │
│       │                                                             │
│       ├─ BroadcastChannel → AltTransportActive(url)                 │
│       │       │                                                     │
│       │       ▼                                                     │
│       │   app.js → torRunner.isUseWithTor(url)                      │
│       │       │                                                     │
│       │       ├─ redirect=false → прямой fetch()                  │
│       │       └─ redirect=true  → fetch(localhost:8181/encodedUrl)  │
│       │                                   │                         │
│       │                                   ▼                         │
│       │                          [Нативный torRunner → Tor/SOCKS]   │
│       │                                                             │
│       └─ кэширование image/script/style (Cache API)                 │
└─────────────────────────────────────────────────────────────────────┘
```

**proxy16** (встроенный Tor для Electron/desktop) на Android **не используется**. Мобильное приложение ходит к удалённым PocketNet proxy-серверам; Tor применяется точечно к HTTP(S)-запросам WebView через Service Worker.

---

## Условие доступности Tor

Флаг `app.hasTor` включает Tor UI и логику только на Android (не iOS) и Electron:

```javascript
// js/app.js
self.hasTor = (window.cordova && !isios()) || self.electronview || false
```

На iOS Tor отключён полностью.

---

## Нативный плагин `cordova.plugins.torRunner`

### API, используемые в GUI

| Метод | Назначение | Где вызывается |
|-------|-----------|----------------|
| `getSettings()` | Чтение текущих настроек и состояния Tor | `components/menu/index.js`, `components/transportsmanagement/index.js` |
| `configure(st)` | Применение настроек (`torMode`, `bridgeType`) | `components/menu/index.js`, `components/transportsmanagement/index.js` |
| `isUseWithTor(url, successCb, errorCb)` | Решение: маршрутизировать URL через Tor или нет | `js/app.js` (обработчик `AltTransportActive`) |

### Формат `getSettings()`

| Поле плагина | Значения | Смысл |
|--------------|----------|-------|
| `torMode` | `NEVER`, `AUTO`, `ALWAYS`, `UNDEFINED` | Режим использования Tor |
| `torState` | `STOPPED`, `STARTING`, `RUNNING`, `FAILED` | Состояние Tor-процесса |
| `bridgeType` | `NONE`, `SNOWFLAKE` | Тип моста (Snowflake) |

### Локальный HTTP-прокси

Когда Service Worker решает использовать Tor, запрос переписывается на:

```
http://localhost:8181/{encodeURIComponent(originalUrl)}
```

Нативный плагин принимает HTTP на порту **8181** и проксирует трафик через встроенный Tor/SOCKS. Реализация порта и SOCKS находится в нативном коде плагина (вне этого репозитория).

### `isUseWithTor(url)` — контракт

```javascript
// js/app.js
window.cordova.plugins.torRunner.isUseWithTor(url, (data = {}) => {
    if (!data.redirect) resolve(null);  // прямое соединение
    else resolve(data);                 // использовать Tor через localhost:8181
}, (error) => {
    resolve(null);  // при ошибке — прямое соединение
});
```

- Возврат **без** `data.redirect` → Service Worker делает обычный `fetch(url)`.
- Возврат **с** `data.redirect` → Service Worker проксирует через `localhost:8181`.
- Логика режима `AUTO` (проверка доступности хоста, выбор маршрута) реализована **в нативном плагине**.

---

## Service Worker — перехват запросов

### Регистрация

Файл `js/pwa-service-worker.js` регистрирует SW с параметром `platform=cordova`:

```javascript
navigator.serviceWorker.register(`./service-worker.js?${swArgs}`);
// swArgs: appVersion, platform=cordova
```

Шаблон SW: `tpls/service-worker.js.tpl` → собирается в `service-worker.js` через `minimize.js`.

### Условия перехвата

Обработчик `fetch` в SW (`onFetch`):

| Условие | Поведение |
|---------|-----------|
| URL не `http://` / `https://` | Игнорируется |
| Cordova + `request.destination === 'document'` | **Не перехватывается** (навигация страниц) |
| Cordova + URL содержит `https://localhost` | Прямой fetch (blob-URL для локальных ресурсов) |
| Cordova + остальные HTTP(S) | Проверка Tor через `torAnswerCordova()` |
| `destination`: image, script, style, worker | Кэширование + Tor-проверка |
| Прочие destination | Tor-проверка без кэша (или с кэшем для script/style) |

### Алгоритм `torAnswerCordova()`

```javascript
// tpls/service-worker.js.tpl
const isTorRequest = await swBroadcaster.invoke('AltTransportActive', request.url);

if (isTorRequest) {
    const proxyURL = `http://localhost:8181/${encodeURIComponent(request.url)}`;
    const fetchResponse = await fetch(proxyURL, {
        method, headers, redirect, credentials: "omit", mode: "cors", body
    });
    // ... статистика, return fetchResponse
}
// иначе — fallthrough к прямому fetch()
```

### Whitelist (всегда прямое соединение)

В `js/app.js` обработчик `AltTransportActive` **до** вызова плагина проверяет whitelist хостов:

- `*.youtube.com`
- `*.imgur.com`
- `*.cdn.jsdelivr.net`
- `*.vimeocdn.com`, `*.vimeo.com`
- `*.bitchute.com`
- `photos.brighteon.com`

Эти домены **никогда** не идут через Tor, независимо от режима.

### Workaround для blob-URL (Cordova)

В `js/pwa-service-worker.js` при наличии `torRunner` сообщения SW для blob-ресурсов обрабатываются через `fetch(event.data, { mode: 'no-cors' })` → `URL.createObjectURL(blob)` — обход ограничений WebView при работе с локальными URL.

---

## Broadcaster — связь SW ↔ главный поток

Класс `js/broadcaster.js` реализует RPC поверх `BroadcastChannel('ServiceWorker')`:

| Событие | Направление | Назначение |
|---------|-------------|------------|
| `AltTransportActive` | SW → main → SW | Запрос решения: Tor или direct |
| `AltTransportActive_result[id]` | main → SW | Ответ с решением |
| `network-stats` | SW → main | Статистика байт/успех/ошибка |

Инициализация в `js/app.js`:

```javascript
if (typeof Broadcaster != 'undefined' && window.cordova) {
    swBroadcaster = new Broadcaster('ServiceWorker');
    swBroadcaster.handle('AltTransportActive', async (url) => { ... });
}
```

SDK broadcaster в `js/satolist.js` подписывается на `network-stats` и рассылает данные подписчикам (`menu`, `transportsmanagement`).

---

## «Workers» — что есть и чего нет

| Компонент | Роль | Android Tor |
|-----------|------|-------------|
| **Service Worker** | Перехват `fetch`, прокси через 8181 | **Да — основной механизм** |
| **Broadcaster** | Канал SW ↔ UI | **Да** |
| `js/transports2/fetch/receiver.js` | Electron IPC fetch bridge | **Нет** (только Electron) |
| `js/transports2/fetch/retranslator.js` | Electron renderer relay | **Нет** |
| `js/transports2/fetch/handler.js` | Electron main-process fetch | **Нет** |
| Dedicated Web Worker для Tor | — | **Не существует** |

Отдельного «Tor worker» нет — вся маршрутизация идёт через Service Worker + нативный плагин.

---

## Настройки Tor

### Нативные настройки (через `torRunner.configure()`)

| Настройка | Ключ плагина | Значения | Описание |
|-----------|--------------|----------|----------|
| Режим Tor | `torMode` | `NEVER`, `AUTO`, `ALWAYS` | Никогда / автоматически / всегда |
| Мост Snowflake | `bridgeType` | `NONE`, `SNOWFLAKE` | Обход блокировок через Snowflake |

### Маппинг GUI ↔ плагин

Модуль `components/transportsmanagement/index.js`:

| UI (`enabled3`) | Плагин (`torMode`) |
|-----------------|-------------------|
| `neveruse` | `NEVER` |
| `auto` | `AUTO` |
| `always` | `ALWAYS` |

| UI (`useSnowFlake2`) | Плагин (`bridgeType`) |
|----------------------|----------------------|
| `false` | `NONE` |
| `true` | `SNOWFLAKE` |

Настройка Snowflake в UI доступна только когда режим Tor **не** `neveruse` (см. `settings.html`).

### Значения по умолчанию при первом запуске

При опросе меню (`components/menu/index.js`, интервал 2 с), если `torMode === 'UNDEFINED'`:

```javascript
const st = { torMode: 'AUTO' };
if (locale === 'ru-RU' || locale === 'fa-IR') {
    st.bridgeType = 'SNOWFLAKE';
} else {
    st.bridgeType = 'NONE';
}
window.cordova.plugins.torRunner.configure(st);
```

- Для всех: режим **Auto**.
- Для локалей `ru-RU` и `fa-IR`: мост **Snowflake** включён.
- Для остальных локалей: мост **None**.

### Сохранение настроек из UI

Экран `transportsmanagement` → кнопка Save:

1. Собирает `changes` (режим Tor, Snowflake).
2. Конвертирует в `{ torMode, bridgeType }`.
3. Вызывает `torRunner.configure(st)`.
4. Через 500 ms обновляет UI.

На Android **нет** настройки `customObfs4` (она есть только в proxy16 для desktop).

---

## Статусы в интерфейсе

### Иконка «щита» в меню

Элемент: `.control-tor-state` в `components/menu/templates/index.html` (только при `app.hasTor`, класс `platform-android`).

Опрос `torRunner.getSettings()` каждые **2 секунды** (`components/menu/index.js`):

| `torMode` / `torState` | CSS-класс | Tooltip (ключ локализации) | Текст под иконкой |
|------------------------|-----------|----------------------------|-------------------|
| `NEVER` или `STOPPED` | `off` | `torHintStateDisabled` | скрыт |
| `RUNNING` | `on` | `torHintStateRunning` | `torHintStateEnabled` |
| `STARTING` | `loading` | `torHintStateStarting` | `torHintStateLoading` |
| `FAILED` | `failed` | (пусто) | `torHintStateDisabled` |

Клик по щиту открывает окно `transportsmanagement`.

### Вспышка при сетевом запросе через Tor

При каждом успешном/неуспешном Tor-запросе SW шлёт `network-stats`. Меню на 300 ms добавляет класс `success` или `failed` к `.control-tor-state`:

```javascript
// components/menu/index.js — receiveNetworkStats
if (stats.torUsed && controlTorElem) {
    controlTorElem.addClass(stats.status);  // 'success' | 'failed'
    setTimeout(() => controlTorElem.removeClass(stats.status), 300);
}
```

### Экран «Networking» (`transportsmanagement`)

Маршрут: клик по щиту → модуль `transportsmanagement`.

**Секция настроек** (`templates/settings.html`):

- **Use Tor** — циклическое переключение: Never → Auto → Always.
- **Use SnowFlake** — Yes/No (видно только если Tor ≠ Never).

**Секция статистики** (`templates/stats.html`):

| Показатель | Ключ локализации | Источник |
|------------|------------------|----------|
| Текущий direct-трафик | `torusing_stat_currentbytesLength` | последний `network-stats` без Tor |
| Текущий Tor-трафик | `torusing_stat_torbytesLength` | последний `network-stats` с Tor |
| Всего direct | `torusing_stat_directBytes` | `totalStats.directBytes` |
| Всего Tor | `torusing_stat_totalTorBytes` | `totalStats.totalTorBytes` |

Счётчики «Current» сбрасываются через 2 с после события. При ошибке запроса блок подсвечивается классом `failed`.

На Android **не показывается** выбор built-in/external proxy (это только для Electron).

---

## Ключи локализации

Файлы: `localization/en.js`, `localization/ru.js`, `localization/zh.js`, `localization/sr.js`, `localization/it.js`, `localization/es.js` и др.

### Статусы щита

| Ключ | EN |
|------|-----|
| `torHintStateEnabled` | Tor network state - enabled |
| `torHintStateDisabled` | Tor network state - disabled |
| `torHintStateLoading` | Tor network state - loading |
| `torHintStateRunning` | The TOR module is working |
| `torHintStateStarting` | TOR module is starting |

### Настройки и статистика

| Ключ | EN |
|------|-----|
| `usetor` | Connection via Tor network |
| `torusing_useTor` | Use Tor |
| `torusing_useSnowflakeBridge` | Use SnowFlake |
| `torusing_neveruse` | Never |
| `torusing_auto` | Auto |
| `torusing_always` | Always |
| `torusing_settings` | TOR settings |
| `torusing_stats` | Networking statistics |
| `torusing_stat_currentbytesLength` | Current, direct |
| `torusing_stat_torbytesLength` | Current, TOR |
| `torusing_stat_directBytes` | Total, current |
| `torusing_stat_totalTorBytes` | Total, TOR |
| `torusing_Networking` | Networking |

---

## Полный жизненный цикл: от запуска до запроса

```
1. indexcordova.html загружает приложение
      │
2. js/pwa-service-worker.js
      └─ register service-worker.js?platform=cordova&appVersion=...
      │
3. js/app.js
      └─ swBroadcaster = new Broadcaster('ServiceWorker')
      └─ handle('AltTransportActive') → torRunner.isUseWithTor()
      └─ hasTor = true (Android, не iOS)
      │
4. deviceready (deviceReadyInit)
      └─ инициализация модулей, splash hide
      │
5. components/menu — events.controlApp
      └─ setInterval 2000ms: torRunner.getSettings()
      └─ torMode UNDEFINED → configure(AUTO + locale bridge)
      └─ обновление щита: off / loading / on / failed
      │
6. js/satolist.js — sdk.broadcaster.init()
      └─ подписка на network-stats от SW
      │
7. Пользователь / приложение вызывает fetch(https://example.com/...)
      │
8. Service Worker — onFetch
      ├─ document navigation → skip
      ├─ invoke AltTransportActive(url)
      │     ├─ whitelist → direct
      │     └─ torRunner.isUseWithTor(url)
      │           ├─ no redirect → direct fetch
      │           └─ redirect → fetch(localhost:8181/encodedUrl)
      └─ send network-stats → menu flash + transportsmanagement stats
      │
8. Пользователь меняет настройки в transportsmanagement
      └─ torRunner.configure({ torMode, bridgeType })
      └─ нативный плагин стартует/останавливает Tor, применяет мост
      └─ меню отражает новый torState через polling
```

---

## Сравнение: Android vs Electron (proxy16)

| Аспект | Android (Cordova) | Electron (direct proxy) |
|--------|-------------------|-------------------------|
| Tor daemon | `torRunner` (нативный плагин) | `proxy16/node/torcontrol.js` + `tor/` binary |
| HTTP-прокси | `localhost:8181` (HTTP wrapper) | SOCKS `127.0.0.1:9250` |
| Хранение настроек | Native prefs плагина | NeDB (`data/tor/`) |
| Решение о маршруте | `torRunner.isUseWithTor()` | `proxy16/transports.js` + host ping |
| UI настроек | `transportsmanagement` → `configure()` | `transportsmanagement` / `system16` → RPC |
| Перехват HTTP | Service Worker | Service Worker + Electron IPC fetch |

---

## Ключевые файлы в репозитории

| Файл | Назначение |
|------|-----------|
| `js/app.js` | `hasTor`, обработчик `AltTransportActive`, whitelist, делегирование в `torRunner` |
| `tpls/service-worker.js.tpl` | Перехват fetch, прокси `localhost:8181`, статистика |
| `js/pwa-service-worker.js` | Регистрация SW, Cordova blob workaround |
| `js/broadcaster.js` | BroadcastChannel RPC между SW и main thread |
| `components/menu/index.js` | Polling статуса Tor, first-run defaults, flash статистики |
| `components/menu/templates/index.html` | Разметка иконки щита (Android) |
| `components/transportsmanagement/index.js` | UI настроек, `getSettings`/`configure` |
| `components/transportsmanagement/templates/settings.html` | Переключатели Tor mode / Snowflake |
| `components/transportsmanagement/templates/stats.html` | Счётчики direct/Tor байт |
| `components/transportsmanagement/templates/state.html` | Контейнер настроек и статистики |
| `js/satolist.js` | SDK broadcaster: history + callbacks для menu/transportsmanagement |
| `localization/*.js` | Строки UI Tor |
| `proxy16/node/torcontrol.js` | Desktop Tor (не Android) |

---

## Ограничения и замечания

1. **Нативный код плагина** не в этом репозитории — для деталей SOCKS, bootstrap Tor, Snowflake смотреть Android Cordova-проект и зависимости сборки.
2. **Orbot не используется** — свой встроенный Tor через `torRunner`.
3. **iOS исключён** — `hasTor` явно false для iOS.
4. **Навигация document** не проксируется через Tor (только subresource fetch).
5. **Whitelist CDN/медиа** всегда идёт напрямую.
6. **Два независимых Tor-стека** — Android native plugin vs Electron proxy16; общей конфигурации нет.
