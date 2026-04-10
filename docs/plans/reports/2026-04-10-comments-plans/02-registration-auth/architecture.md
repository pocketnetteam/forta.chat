# Архитектура: Регистрация и вход

## Связь с проблемой

Пользователи сообщают: зависание между шагами 2–3, «подготовка аккаунта висит», регистрация в блокчейне 1.5 часа, seed от Bastyon не подходит, «просит приватный ключ — где брать?».

## Регистрация: многошаговый процесс

### UI Flow

`RegisterPage.vue` → `RegisterForm.vue` (3 шага):

```
Шаг 1: ProfileStep.vue     — имя, аватар, согласие с Terms
Шаг 2: CaptchaStep.vue     — SVG-капча с прокси
Шаг 3: SaveMnemonicStep.vue — показ 12 слов, подтверждение
```

### Подробная последовательность

#### Шаг 1 — Профиль (`ProfileStep.vue`)

1. Валидация имени + `checkUsername` через RPC (`api.rpc("getuseraddress", [name])`)
2. `generateRegistrationKeys()` — генерация BIP39-мнемоники и ключевой пары
3. `findRegistrationProxy()` — поиск прокси-ноды с кошельком (`api.get.proxywithwallet()`)
4. При ошибках (нет прокси, сеть недоступна) — пользователь видит задержку на этом шаге

#### Шаг 2 — Капча (`CaptchaStep.vue`)

1. `fetchCaptcha()` → `api.fetchauth("captcha", ..., { proxy })` — SVG-изображение
2. `submitCaptcha(text)` → `api.fetchauth("makecaptcha", ..., { proxy })`

#### Шаг 3 — Мнемоника (`SaveMnemonicStep.vue`)

1. Показ 12 слов из `authStore.regMnemonic`
2. Чекбокс «Я сохранил» → кнопка «Завершить»
3. Вызов `authStore.register(profile)`

### Логика `register()` в `useAuthStore` (`src/entities/auth/model/stores.ts`)

```
1. requestFreeRegistration(address, captchaId, proxyId)
   → api.fetchauth("free/balance", { address, captcha, key: "registration" }, { proxy })
   
2. generateEncryptionKeys(regPrivateKeyHex)
   → BIP32: m/33'/0'/0'/{1..12}' → 12 публичных ключей для E2E

3. pendingRegProfile → localStorage("registration_profile")

4. login(mnemonic) — запуск сессии:
   → createKeyPair (BIP39 → m/44'/0'/0'/0')
   → setAuthData → SessionManager → localStorage
   → fetchUserInfo → initMatrix → Dexie

5. startRegistrationPoll():
   → checkUnspents (ждём PKOIN на адресе)
   → registerUserProfile (UserInfo + 12 ключей в блокчейн)
   → checkUserRegistered (поллинг getuserstate)
```

### Оверлей ожидания

`RegistrationStepper.vue` в `App.vue` — показывает прогресс пока `registrationPending === true`:
- Фаза 1: ожидание unspent'ов (PKOIN от прокси)
- Фаза 2: broadcast UserInfo
- Фаза 3: ожидание подтверждения в блокчейне

**Именно здесь возникает «зависание на 1.5 часа»** — при проблемах с блокчейном или прокси.

## Вход

### Единственный способ: крипто-credentials

`LoginForm.vue` → одно поле: BIP39-мнемоника ИЛИ приватный ключ (hex/WIF)

### Логика `login()` в `useAuthStore`

```
1. createKeyPair(credential) — src/entities/auth/model/key-pair.ts:
   - bip39.validateMnemonic → деривация m/44'/0'/0'/0'
   - иначе → ECPair.fromWIF или fromPrivateKey

2. getAddressFromPubKey → Bastyon-адрес

3. setAuthData → SessionManager:
   - localStorage("forta-chat:sessions") — массив до 5 аккаунтов
   - localStorage("forta-chat:activeAccount") — активный адрес

4. fetchUserInfo → appInitializer.initializeAndFetchUserData():
   - initApi → waitForApiReady
   - actions.addAccount(address)
   - psdk.userInfo.load → userInfo

5. verifyAndRepublishKeys():
   - Проверка: есть ли 12 ключей в профиле
   - Если нет → пересчёт + повторная публикация

6. initMatrix() → см. раздел "Matrix авторизация"
```

## Matrix авторизация

### Деривация учётных данных

`deriveMatrixCredentials(address, privateKey)` в `stores.ts`:

```
username = hexEncode(address).toLowerCase()
password = SHA256(SHA256(Buffer.from(privateKey)))  // UTF-8 encoding
```

### Подключение к Matrix Homeserver

`MatrixClientService.getClient()` в `src/entities/matrix/model/matrix-client.ts`:

```
1. client.login("m.login.password", { username, password })
2. При ошибке → проверка доступности имени → client.register(..., { type: "m.login.dummy" })
3. IndexedDB: "matrix-js-sdk-v6:{username}"
4. startClient({ pollTimeout: 60000, initialSyncLimit: 1, lazyLoadMembers: true })
```

Homeserver: `https://matrix.pocketnet.app` (константа `MATRIX_SERVER`)

## Хранение ключей

| Что | Где | Как |
|-----|-----|-----|
| Bastyon identity (address + privateKey) | `SessionManager` → `localStorage("forta-chat:sessions")` | JSON-массив сессий |
| Matrix access token | `localStorage` через SDK | Обновляется при login/register |
| Matrix crypto (device keys) | `IndexedDB("matrix-js-sdk-v6:...")` | Стандартное хранилище SDK |
| E2E ключи (12× secp256k1) | Память (Pcrypto), публичные — в блокчейне | Детерминированно из приватника |
| Мнемоника | Только в памяти (Pinia `regMnemonic`) | Очищается после `clearRegistrationState()` |
| Pcrypto storage | `IndexedDB("messages:{address}", "events:{address}")` | Кэш для расшифровки |

## Мультиаккаунт

- `SessionManager`: до 5 аккаунтов
- `BackgroundSyncManager` (`src/entities/auth/model/background-sync.ts`): фоновый polling `/sync` для неактивных аккаунтов
- При переключении: `switchAccount` → смена активного, `initMatrix`, демоция старого в background

## Роуты

| Маршрут | Имя | meta | Guard |
|---------|-----|------|-------|
| `/welcome` | `WelcomePage` | `requiresGuest` | → chat если залогинен |
| `/login` | `LoginPage` | `requiresGuest` | → chat если залогинен |
| `/register` | `RegisterPage` | `requiresGuest` | → chat если залогинен |
| `/chat` | `ChatPage` | `requiresAuth` | → welcome если гость |

Guard: `createRouteAuthGuardHandler` в `src/app/providers/router/handlers/auth-guard.ts`

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/entities/auth/model/stores.ts` | Основной auth store: login, register, initMatrix, polling |
| `src/entities/auth/model/session-manager.ts` | localStorage сессий |
| `src/entities/auth/model/key-pair.ts` | Мнемоника vs приватный ключ |
| `src/entities/auth/model/background-sync.ts` | Background sync для мультиаккаунта |
| `src/app/providers/initializers/app-initializer.ts` | Вызовы Api/Actions/pSDK к Bastyon |
| `src/entities/matrix/model/matrix-client.ts` | Login/register на homeserver |
| `src/entities/matrix/model/matrix-crypto.ts` | Pcrypto: E2E ключи, prepare |
| `src/features/auth/ui/register-form/RegisterForm.vue` | UI регистрации (3 шага) |
| `src/features/auth/ui/register-form/ProfileStep.vue` | Шаг 1: имя, аватар |
| `src/features/auth/ui/register-form/CaptchaStep.vue` | Шаг 2: капча |
| `src/features/auth/ui/register-form/SaveMnemonicStep.vue` | Шаг 3: мнемоника |
| `src/features/auth/ui/RegistrationStepper.vue` | Оверлей ожидания блокчейна |
| `src/features/auth/ui/login-form/LoginForm.vue` | UI входа |
| `src/app/providers/router/handlers/auth-guard.ts` | Защита маршрутов |
