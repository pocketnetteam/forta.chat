# Архитектура WebSocket и прокси в проекте PocketNet (Bastyon)

## Общая схема

Система реального времени в PocketNet построена по трёхзвенной архитектуре:

```
┌─────────────────┐       ┌──────────────────────┐       ┌─────────────────────┐
│  PocketNet Node  │◄─────►│    Proxy16 Server     │◄─────►│  Browser / Electron  │
│  (Blockchain)    │  WS   │  (proxy16/)           │ WSS   │  (satolist.js)       │
│  /ws endpoint    │       │  server/wss.js        │       │  ReconnectingWS      │
└─────────────────┘       │  node/wss.js          │       └─────────────────────┘
                          │  node/rpc.js (axios)  │
                          └──────────────────────┘
```

---

## 1. Подключение WebSocket на стороне клиента

### Выбор URL

URL WebSocket строится на основе метаданных текущего прокси. HTTPS-прокси работает на `port`, WSS — на отдельном `wss`-порту. Незащищённые варианты (`http`/`ws`) используют `port - 1` и `wss - 1` соответственно.

```js
// js/lib/client/api.js
self.url = {
    https : () => { return "https://" + self.host + ":" + self.port },
    wss   : () => { return "wss://"   + self.host + ":" + self.wss },
    http  : () => { return "http://"  + self.host + ":" + (self.port - 1) },
    ws    : () => { return "ws://"    + self.host + ":" + (self.wss - 1) }
}
```

### Выбор: настоящий WebSocket vs Electron IPC

```js
// js/lib/client/api.js
currentwss : function(){
    return getproxy().then(proxy => {
        if(proxy.direct){
            return {
                dummy : proxy.system.wssdummy,
                proxy : proxy
            }
        }
        return {
            url : proxy.url.wss(),
            proxy : proxy
        }
    })
},
```

- **Браузер / Cordova** — используется настоящий `ReconnectingWebSocket`.
- **Electron** — используется `WssDummy` (IPC-мост через `proxy16/ipc.js`), что исключает сетевой round-trip внутри десктоп-приложения.

### Инициализация соединения

```js
// js/satolist.js
var initconnection = function (clbk) {
    platform.app.api.get.currentwss().then(wss => {
        socket = wss.dummy || (new ReconnectingWebSocket(wss.url, null, {
            reconnectDecay: 1
        }));
```

`ReconnectingWebSocket` (вендорная библиотека `js/vendor/reconnectingwebsocket.js`) автоматически переподключается при обрыве с `reconnectDecay: 1` (линейная задержка).

---

## 2. Регистрация клиента на прокси

После `onopen` клиент отправляет JSON-сообщение с подписью, адресом, текущим блоком и идентификатором ноды:

```js
// js/satolist.js
var message = {
    signature: platform.app.user.signature(),
    address: address,
    device: platform.app.options.device,
    block: platform.currentBlock || 0,
    node: proxy.current ? proxy.current.key : null
}
self.send(JSON.stringify(message))
```

На стороне прокси (`proxy16/server/wss.js`) первое сообщение без поля `action` трактуется как **регистрация**: проверяется подпись, выбирается нода, устанавливается upstream-соединение к ноде через `connectNode`.

---

## 3. Прокси-сервер: два уровня WebSocket

### 3.1 Upstream: Proxy → Node (`proxy16/node/wss.js`)

Прокси устанавливает WebSocket-соединение к ноде PocketNet на endpoint `/ws`:

```js
// proxy16/node/wss.js
ws.onmessage = (e) => {
    var data = {};
    try { data = JSON.parse(e.data) } catch(e) {}

    if (_.isEmpty(data)) return

    if (data.msg == 'new block' && service) {
        emit('block', data)
        node.addblock(data)
        node.notification(data)
    }

    emit('message', data)
};
```

Ключевые события от ноды:

- **`new block`** — новый блок в цепочке; обновляет высоту, запускает обработку нотификаций.
- **`transaction`** — новая транзакция (в т.ч. социальные действия).
- Прочие сообщения пробрасываются через `emit('message', data)`.

### 3.2 Downstream: Proxy → Клиенты (`proxy16/server/wss.js`)

Прокси создаёт **два** серверных WebSocket-слушателя: WSS (TLS) и WS (plain HTTP):

```js
// proxy16/server/wss.js
var createWss = function(port, settings) {
    server = new https.createServer(settings.ssl);
    wss = new WebSocket.Server({ server: server });
    server.listen(port);
}

var createWs = function(port, settings) {
    httpserver = new http.createServer();
    ws = new WebSocket.Server({ server: httpserver });
    httpserver.listen(port);
}
```

### 3.3 Fan-out: рассылка всем клиентам

```js
// proxy16/server/wss.js
self.sendtoall = function(message) {
    _.each(allwss, function(ws) {
        sendMessage(message, ws).catch(e => {})
    })
    _.each(allws, function(ws) {
        sendMessage(message, ws).catch(e => {})
    })
    return Promise.resolve()
}
```

Сообщения от ноды пробрасываются каждому зарегистрированному клиенту:

```js
// proxy16/server/wss.js
ws.on('message', (data) => {
    data.node = node.instance.ckey

    _.each(node.ini, function(client) {
        if (client.type == 'firebase') {
            if (data.msg == 'new block') return
            // ...
        } else {
            sendMessage(data, client.ws).catch(e => {})
        }
    })
});
```

Firebase-клиенты (мобильные) получают только нотификации (без блоков). Браузерные клиенты получают всё.

---

## 4. Обработка сообщений на клиенте

### Маршрутизация входящих сообщений

```js
// js/satolist.js
socket.onmessage = function (message) {
    message = message.data ? message.data : message;
    var jm = message;
    try { jm = JSON.parse(message || "{}"); } catch (e) {}

    if (jm) {
        if (jm.type == 'proxy-message-tick')
            return wss.proxy.system.tick(jm.data)

        if (jm.type == 'changenode')
            return  // ... temp transactions, no auto changeNode ...

        if (jm.type == 'proxy-settings-changed')
            return wss.proxy.changed(jm.data)

        self.messageHandler(jm);
    }
}
```

### Типы сообщений

| Тип                        | Описание                                              |
|-----------------------------|-------------------------------------------------------|
| `proxy-message-tick`        | Служебный тик от прокси (heartbeat/статус)            |
| `changenode`                | Прокси сменил upstream-ноду                           |
| `proxy-settings-changed`    | Изменились настройки прокси (порты, SSL, домен)       |
| Всё остальное → `messageHandler` | Блоки, транзакции, социальные нотификации        |

### messageHandler: обновления блоков

При получении `new block` клиент обновляет `currentBlock` и **инкрементирует confirmations** у всех закешированных UTXO и транзакций:

```js
// js/satolist.js
var s = platform.sdk.node.transactions;

platform.currentBlock = data.height;

_.each(s.unspent, function (unspents, address) {
    _.each(unspents, function (txu) {
        txu.confirmations || (txu.confirmations = 0)
        txu.confirmations++
    })
})

_.each(platform.sdk.node.transactions.storage, (tx) => {
    if (tx.height && tx.height != platform.currentBlock) tx.confirmations++
})
```

Это позволяет UI мгновенно отражать подтверждения **без повторных RPC-запросов**.

---

## 5. Жизненный цикл транзакции

### 5.1 Создание и подписание

`actions.js` → `buildTransaction()` → `tx.toHex()`

### 5.2 Отправка

```js
// js/lib/client/actions.js
var method = 'sendrawtransaction'

if (self.object.serialize) {
    method = 'sendrawtransactionwithmessage'
}

sendPromise = account.parent.api.rpc(method, parameters)
```

Путь вызова:

```
Api.rpc()
  → Proxy16.rpc()
    → fetch(proxy_url/rpc/{method})
      → Прокси (proxy.js)
        → nodeManager.queue
          → node/rpc.js
            → axios POST к ноде (/post/)
```

Таймаут при отправке увеличен в 4 раза:

```js
// js/lib/client/api.js
if (data && (data.method == 'sendrawtransactionwithmessage'
          || data.method == 'sendrawtransaction')) {
    time = time * 4
}
```

### 5.3 Ожидание подтверждения

После отправки `Action` устанавливает окно ожидания (35 секунд), затем с интервалом **3 секунды** проверяет статус:

```js
// js/lib/client/actions.js
self.processing()

processInterval = setInterval(() => {
    self.processing()
}, 3000)
```

Проверка вызывает `getrawtransaction` и ждёт `confirmations > 0`:

```js
// js/lib/client/actions.js
if (data.confirmations > 0) {
    self.completed = true
    account.addUnspentFromTransaction(data)
    account.removeInputsFromTransaction(data)
    return resolve()
}
return reject('actions_waitConfirmation')
```

### 5.4 Catch-up при переподключении

При восстановлении WebSocket-соединения вызывается `getMissed()` — загрузка пропущенных блоков и нотификаций через HTTP API (`platform.sdk.missed.get(...)`), после чего они пропускаются через тот же `messageHandler`.

---

## 6. Оптимизации и кеширование

| Механизм                              | Где                         | Назначение                                                      |
|---------------------------------------|-----------------------------|-----------------------------------------------------------------|
| **RPC-кеш прокси** (`wait`/`get`/`set`) | `proxy16/proxy.js`          | Кешируются read-RPC; write-запросы проходят напрямую             |
| **Single-flight** (`rpcwt`)           | `js/lib/client/api.js`      | Дедупликация одинаковых in-flight RPC                           |
| **IndexedDB кеш** (`psdk loadone`)    | `js/lib/client/sdk.js`      | Локальное хранение `getrawtransaction` и других данных           |
| **Keep-alive HTTP agent**             | `proxy16/node/rpc.js`       | Переиспользование TCP-соединений к ноде                         |
| **Optimistic confirmations**          | `satolist.js`               | Инкремент `confirmations` при `new block` без RPC               |
| **Node affinity** (txid→node)         | `js/lib/client/api.js`      | Запоминает, какая нода приняла txid для последующих запросов     |
| **Unspent splitting**                 | `js/lib/client/actions.js`  | Оптимизация UTXO при малом количестве входов                    |
| **Firebase mirror**                   | `satolist.js`               | FCM push дублирует WS-payload на мобильных                      |

---

## 7. Управление прокси и устойчивость

- **`proxy-settings-changed`** — при изменении конфигурации прокси (домен, порты, SSL, Tor) сервер рассылает уведомление всем клиентам через `sendtoall`, клиент обновляет `Proxy16` и переподключается.

- **`rews()`** — перезапускает HTTPS-сервер, WSS-стек и Firebase:

```js
// proxy16/proxy.js
rews: function () {
    return self.server.re().then(r => {
        return self.wss.re()
    }).then(r => {
        return self.firebase.re()
    })
},
```

- **Failover** — при таймауте/429 `Proxy16.rpc` переключается на другую ноду (`canchange`); `Api.rpc` может сменить весь прокси через `changeProxyIfNeedWithDirect`.

- **Bot protection** — для `sendrawtransactionwithmessage` прокси проверяет `bots.check(U)`; если не проходит — возвращает фейковый txid с задержкой (транзакция не попадает в блокчейн).

---

## 8. Ключевые файлы

| Файл                                    | Роль                                                             |
|-----------------------------------------|------------------------------------------------------------------|
| `js/satolist.js`                        | Клиентский WS: подключение, `messageHandler`, обработка блоков, `getMissed` |
| `js/lib/client/api.js`                  | HTTP/WS URL, `Proxy16.rpc`, `Api.rpc`, single-flight, node affinity |
| `js/lib/client/actions.js`              | Построение, подпись, отправка tx, polling подтверждений (3с интервал) |
| `js/lib/client/sdk.js`                  | `psdk.transaction.load` → `getrawtransaction`, IndexedDB кеш     |
| `js/vendor/reconnectingwebsocket.js`    | Автореконнект-обёртка над `WebSocket`                             |
| `js/lib/client/system16.js`             | `WssDummy` для Electron IPC                                      |
| `proxy16/server/wss.js`                 | WS-сервер прокси: регистрация клиентов, fan-out, `sendtoall`     |
| `proxy16/node/wss.js`                   | WS-клиент прокси → нода: получение `new block`, `transaction`    |
| `proxy16/node/rpc.js`                   | HTTP RPC к ноде (axios), `/post/` для отправки транзакций        |
| `proxy16/node/manager.js`              | Пул нод, `requestprobnew`, вероятностный выбор                   |
| `proxy16/proxy.js`                      | Основной модуль прокси: `/rpc/*`, кеш, `rews`, bot-check         |
| `proxy16/ipc.js`                        | Electron IPC мост (renderer ↔ proxy)                              |

---

## 9. Вывод

Архитектура PocketNet использует **двухуровневую WebSocket-цепочку**: нода блокчейна пушит события (новые блоки, транзакции) в прокси-сервер, который в свою очередь fan-out'ит их всем зарегистрированным клиентам. Это даёт **push-модель** для обновления состояния (высота блока, confirmations) без поллинга.

Однако подтверждение конкретных транзакций по-прежнему опирается на **3-секундный polling** через `getrawtransaction`, хотя оптимистичный инкремент confirmations при `new block` снижает нагрузку.

Отправка транзакций идёт через **HTTP RPC** (не через WebSocket), прокси ретранслирует их к ноде по `/post/` endpoint.
