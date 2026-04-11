# Процесс регистрации в Forta.Chat

## Оглавление

1. [Обзор архитектуры](#1-обзор-архитектуры)
2. [Диаграмма потока](#2-диаграмма-потока)
3. [UI: трёхшаговый визард](#3-ui-трёхшаговый-визард)
4. [Генерация ключей](#4-генерация-ключей)
5. [Интеграция с блокчейном Bastyon](#5-интеграция-с-блокчейном-bastyon)
6. [Регистрация в Matrix](#6-регистрация-в-matrix)
7. [Асинхронный polling блокчейна](#7-асинхронный-polling-блокчейна)
8. [Персистентность и восстановление](#8-персистентность-и-восстановление)
9. [Обработка ошибок](#9-обработка-ошибок)
10. [Файловая структура](#10-файловая-структура)

---

## 1. Обзор архитектуры

Регистрация в Forta.Chat — **гибридный процесс**, затрагивающий три независимые системы:

```
┌─────────────────────────────────────────────────────────────────┐
│                         Forta.Chat UI                           │
│  RegisterForm (3 шага) → RegistrationStepper (overlay)          │
└────────────┬────────────────────┬───────────────────┬───────────┘
             │                    │                   │
             ▼                    ▼                   ▼
┌────────────────────┐ ┌──────────────────┐ ┌─────────────────────┐
│  Bastyon Blockchain │ │   Matrix Server   │ │  Local Storage      │
│                    │ │                   │ │  (Dexie + LS)       │
│ • PKOIN (free reg) │ │ • Homeserver acc  │ │ • Sessions          │
│ • UserInfo tx      │ │ • IndexedDB sync  │ │ • Pending profile   │
│ • 12 enc pub keys  │ │ • Pcrypto E2E     │ │ • Registration phase│
└────────────────────┘ └──────────────────┘ └─────────────────────┘
```

**Ключевой принцип**: единый BIP39 мнемоник порождает все криптоматериалы — Bitcoin-адрес (= идентификатор Pocketnet), Matrix-учётные данные и 12 ключей шифрования для Pcrypto E2E.

---

## 2. Диаграмма потока

```
Пользователь                   Forta.Chat                    Blockchain / Matrix
    │                              │                              │
    │  1. Заполняет профиль        │                              │
    │─────────────────────────────>│                              │
    │                              │  checkUsername (RPC)          │
    │                              │─────────────────────────────>│
    │                              │<─────────────────────────────│
    │                              │  generateRegistrationKeys()  │
    │                              │  (BIP39 mnemonic → keypair)  │
    │                              │  findRegistrationProxy()     │
    │                              │─────────────────────────────>│
    │                              │<─────────────────────────────│
    │  2. Решает CAPTCHA           │                              │
    │─────────────────────────────>│                              │
    │                              │  fetchCaptcha → solveCaptcha │
    │                              │─────────────────────────────>│
    │                              │<─────────────────────────────│
    │  3. Сохраняет мнемоник       │                              │
    │  Нажимает "Зарегистрироваться"│                             │
    │─────────────────────────────>│                              │
    │                              │  register(profile):          │
    │                              │    requestFreeRegistration   │
    │                              │──────────────────────────────>│
    │                              │    generateEncryptionKeys    │
    │                              │    login(mnemonic)           │
    │                              │      ├─ deriveMatrixCreds   │
    │                              │      ├─ Matrix login/register│
    │                              │      │──────────────────────>│
    │                              │      ├─ initChatDb (Dexie)  │
    │                              │      └─ initPcrypto         │
    │                              │    startRegistrationPoll()   │
    │                              │                              │
    │  (Overlay: "Ожидание...")    │  Phase 1: poll checkUnspents │
    │                              │──────────────────────────────>│
    │                              │  (PKOIN arrived)             │
    │                              │  registerUserProfile (tx)    │
    │                              │──────────────────────────────>│
    │                              │                              │
    │                              │  Phase 2: checkUserRegistered│
    │                              │──────────────────────────────>│
    │                              │  (confirmed)                 │
    │  Чат доступен!               │  onRegistrationConfirmed()   │
    │<─────────────────────────────│                              │
```

---

## 3. UI: трёхшаговый визард

### Маршрут

```typescript
// src/app/providers/router/routes/register.ts
export const route = {
  component: () => import("@/pages/register"),
  meta: { requiresGuest: true },
  name: "RegisterPage",
  path: "/register"
};
```

Гвард `requiresGuest` в `auth-guard.ts` редиректит авторизованных пользователей на `ChatPage`.

### RegisterForm — оркестратор шагов

Файл: `src/features/auth/ui/register-form/RegisterForm.vue`

```vue
<script setup lang="ts">
const currentStep = ref(1);
const totalSteps = 3;

const profileData = ref({
  name: "", language: "en", about: "",
  image: undefined as string | undefined
});

const handleProfileDone = (data) => {
  profileData.value = { ...data };
  currentStep.value = 2;
};

onUnmounted(() => {
  authStore.clearRegistrationState();
});
</script>

<template>
  <ProfileStep  v-if="currentStep === 1" @done="handleProfileDone" />
  <CaptchaStep  v-else-if="currentStep === 2" @done="currentStep = 3" />
  <SaveMnemonicStep v-else-if="currentStep === 3" :profile="profileData" />
</template>
```

### Шаг 1: ProfileStep

Файл: `src/features/auth/ui/register-form/steps/ProfileStep.vue`

Валидирует имя (regex Pocketnet, reserved names, debounced uniqueness-проверка через `checkUsername`). При сабмите:

```typescript
// Проверка уникальности имени на блокчейне
const ownerAddress = await authStore.checkUsername(name.value.trim());
if (ownerAddress) {
  nameError.value = t("register.nameTaken");
  return;
}

// Генерация мнемоника + поиск proxy-ноды (параллельно с UI)
authStore.generateRegistrationKeys();
await authStore.findRegistrationProxy();

emit("done", {
  name: name.value.trim(),
  language: localeStore.locale,
  about: about.value.trim(),
  ...(avatarUrl.value ? { image: avatarUrl.value } : {}),
});
```

### Шаг 2: CaptchaStep

Файл: `src/features/auth/ui/register-form/steps/CaptchaStep.vue`

Загружает SVG-captcha через `authStore.fetchCaptcha()`, отправляет решение через `authStore.submitCaptcha(text)`.

### Шаг 3: SaveMnemonicStep

Файл: `src/features/auth/ui/register-form/steps/SaveMnemonicStep.vue`

```typescript
const handleRegister = async () => {
  if (!confirmed.value) return;
  registering.value = true;
  try {
    await authStore.register(props.profile);
    router.push({ name: "ChatPage" });
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("register.registrationFailed");
    registering.value = false;
  }
};
```

Пользователь видит мнемоник, копирует его, подтверждает чекбоксом и нажимает "Зарегистрироваться".

### Overlay: RegistrationStepper

Файл: `src/features/auth/ui/RegistrationStepper.vue`

После вызова `register()` пользователь перенаправлен на `ChatPage`, а поверх отображается блокирующий overlay с прогрессом:

```
Phase init         → Шаг 1: "Подготовка аккаунта..."
Phase broadcasting → Шаг 2: "Отправка профиля в блокчейн..."
Phase confirming   → Шаг 2: "Ожидание подтверждения..."
Phase done         → Шаг 3: "Готово!"
Phase error        → Ошибка + поле для нового имени
```

В `App.vue`:

```vue
<RegistrationStepper
  v-if="authStore.registrationPending
        || authStore.registrationPhase === 'done'
        || authStore.registrationUsernameError"
  :phase="authStore.registrationPhase"
  :error-message="retryError"
  @back-to-name="handleRetryUsername"
/>
```

---

## 4. Генерация ключей

### 4.1 Мнемоник → Bitcoin-адрес

Файл: `src/entities/auth/model/key-pair.ts`

```typescript
class KeyPair {
  private getFromMnemonic(mnemonic: string) {
    const seed = bitcoin.bip39.mnemonicToSeedSync(mnemonic);
    const node = bitcoin.bip32.fromSeed(seed);
    const childNode = node.derivePath(`m/44'/0'/0'/0'`);
    const wif = childNode.toWIF();
    return bitcoin.ECPair.fromWIF(wif);
  }

  create(cryptoCredential: string): { privateKey: Buffer; publicKey: Buffer } {
    const keyPairSource = this.determineKeyPairSource(cryptoCredential);
    return keyPairSource === "mnemonic"
      ? this.getFromMnemonic(cryptoCredential)
      : this.getFromPrivateKey(cryptoCredential);
  }
}
```

Путь деривации: `m/44'/0'/0'/0'` (BIP44 Bitcoin). Из `publicKey` выводится P2PKH-адрес (`getAddressFromPubKey`) — это **идентификатор пользователя** в сети Pocketnet.

### 4.2 Генерация ключей регистрации

Файл: `src/entities/auth/model/stores.ts`

```typescript
const generateRegistrationKeys = () => {
  const mnemonic = bitcoin.bip39.generateMnemonic();
  const keyPair = createKeyPair(mnemonic);
  const addr = getAddressFromPubKey(keyPair.publicKey);

  regMnemonic.value = mnemonic;
  regAddress.value = addr;
  regPrivateKeyHex.value = convertToHexString(keyPair.privateKey);

  // Конфигурируем SDK для подписи запросов (captcha, free balance)
  PocketnetInstanceConfigurator.setUserAddress(addr);
  PocketnetInstanceConfigurator.setUserGetKeyPairFc(() => createKeyPair(mnemonic));
};
```

### 4.3 12 ключей шифрования (Pcrypto)

```typescript
function generateEncryptionKeys(privateKeyHex: string) {
  const key = Buffer.from(privateKeyHex, "hex");
  const root = bitcoin.bip32.fromSeed(key);

  const keys = [];
  for (let i = 1; i <= 12; i++) {
    const child = root.derivePath(`m/33'/0'/0'/${i}'`);
    keys.push({
      pair: bitcoin.ECPair.fromPrivateKey(child.privateKey),
      public: child.publicKey.toString("hex"),
      private: child.privateKey,
    });
  }
  return keys;
}
```

Путь: `m/33'/0'/0'/{1..12}'` — 12 дочерних ключей BIP32. **Публичные ключи** публикуются в блокчейне как часть `UserInfo`, чтобы другие пользователи могли шифровать сообщения для этого аккаунта.

### 4.4 Деривация Matrix-учётных данных

```typescript
function deriveMatrixCredentials(address: string, privateKey: string) {
  const passwordHash = bitcoin.crypto
    .sha256(bitcoin.crypto.sha256(Buffer.from(privateKey)))
    .toString("hex");
  return {
    username: hexEncode(address).toLowerCase(),
    password: passwordHash,
    address,
  };
}
```

| Параметр | Формула |
|----------|---------|
| **username** | `hexEncode(pocketnetAddress).toLowerCase()` |
| **password** | `SHA256(SHA256(UTF-8(privateKey)))` в hex |

Совместимо с оригинальным bastyon-chat.

### Иерархия ключей

```
BIP39 Mnemonic (12/24 слова)
  │
  ├─ m/44'/0'/0'/0' ──────────── Bitcoin KeyPair
  │    ├─ publicKey ─────────────── P2PKH Address (Pocketnet ID)
  │    └─ privateKey ────────────── Session auth + Matrix password derivation
  │
  └─ privateKey as seed
       └─ m/33'/0'/0'/{1..12}' ── 12 Pcrypto Encryption Keys
            ├─ publicKey[1..12] ── Published to blockchain (UserInfo.keys)
            └─ privateKey[1..12] ── Used locally for E2E decrypt
```

---

## 5. Интеграция с блокчейном Bastyon

Файл: `src/app/providers/initializers/app-initializer.ts`

### 5.1 Proxy-нода

```typescript
async getRegistrationProxy(): Promise<{ id: string } | null> {
  await this.initApi();
  await this.waitForApiReady();
  const proxy = await this.api.get.proxywithwallet();
  return proxy ? { id: proxy.id ?? proxy } : null;
}
```

Proxy-нода — промежуточный узел с wallet'ом, через который выполняются `fetchauth`-запросы (captcha, free balance).

### 5.2 CAPTCHA

```typescript
async getCaptcha(proxyId: string, currentCaptchaId?: string) {
  const payload = { captcha: currentCaptchaId || null };
  const raw = await this.api.fetchauth("captcha", payload, { proxy: proxyId });
  return raw?.data ?? raw; // { id, img (SVG), done }
}

async solveCaptcha(proxyId: string, captchaId: string, text: string) {
  const raw = await this.api.fetchauth(
    "makecaptcha",
    { captcha: captchaId, text, angles: null },
    { proxy: proxyId }
  );
  return raw?.data ?? raw; // { id, done: true }
}
```

### 5.3 Запрос бесплатных PKOIN

```typescript
async requestFreeRegistration(address: string, captchaId: string, proxyId: string) {
  const raw = await this.api.fetchauth(
    "free/balance",
    { address, captcha: captchaId, key: "registration" },
    { proxy: proxyId }
  );
  return raw?.data ?? raw;
}
```

Это аналог `free/balance` в Bastyon — после решения captcha, proxy-нода отправляет небольшое количество PKOIN на новый адрес для оплаты транзакции `UserInfo`.

### 5.4 Публикация UserInfo

```typescript
async registerUserProfile(
  address: string,
  profile: { name: string; language: string; about: string },
  encryptionPublicKeys?: string[],
  image?: string
) {
  const userInfo = new UserInfo();
  userInfo.name.set(superXSS(profile.name));
  userInfo.language.set(superXSS(profile.language));
  userInfo.about.set(superXSS(profile.about));
  userInfo.image.set(superXSS(image || ""));
  userInfo.site.set("");
  userInfo.addresses.set([]);
  userInfo.ref.set(null);
  userInfo.keys.set(encryptionPublicKeys ?? null);  // 12 публичных ключей Pcrypto
  return this.actions.addActionAndSendIfCan(userInfo, null, address);
}
```

`UserInfo` — блокчейн-транзакция Pocketnet, содержащая профиль + ключи шифрования. Поле `keys` — массив из 12 hex-строк публичных ключей.

---

## 6. Регистрация в Matrix

Файл: `src/entities/matrix/model/matrix-client.ts`

Matrix-аккаунт создаётся **автоматически** при первом `login()` — если пользователь не найден на homeserver, выполняется `register`:

```typescript
async getClient(): Promise<MatrixClient | null> {
  const client = this.createMtrxClient({ baseUrl: this.baseUrl, ... });

  let userData;
  try {
    // Попытка логина
    userData = await client.login("m.login.password", {
      user: this.credentials.username,
      password: this.credentials.password
    });
  } catch (e) {
    const errStr = (e as Error)?.message ?? "";
    if (errStr.indexOf("M_USER_DEACTIVATED") > -1) {
      this.error = "M_USER_DEACTIVATED";
      return null;
    }

    // Логин не удался → авто-регистрация
    if (await client.isUsernameAvailable(this.credentials.username)) {
      userData = await client.register(
        this.credentials.username,
        this.credentials.password,
        null,
        { type: "m.login.dummy" }
      );
    } else {
      throw new Error("Signup error, username is not available");
    }
  }

  // Сохраняем токен и инициализируем клиент
  localStorage.accessToken = userData.access_token;

  const indexedDBStore = new sdk.IndexedDBStore({
    indexedDB: window.indexedDB,
    dbName: "matrix-js-sdk-v6:" + this.credentials.username,
    localStorage: window.localStorage
  });

  // ... создание полноценного клиента с userId, accessToken, deviceId
}
```

### Инициализация Pcrypto после Matrix

```typescript
const initMatrix = async () => {
  // 1. Деривация Matrix-credentials
  const credentials = deriveMatrixCredentials(address.value, privateKey.value);
  matrixService.setCredentials(credentials);

  // 2. MatrixKit для работы с комнатами
  matrixKit.value = new MatrixKit(matrixService);

  // 3. Генерация 12 ключей шифрования
  const encKeys = generateEncryptionKeys(privateKey.value);

  // 4. Инициализация Pcrypto
  const cryptoInstance = new Pcrypto();
  const cryptoUser: UserWithPrivateKeys = {
    userinfo: {
      id: hexEncode(address.value),
      keys: encKeys.map(k => k.public),
    },
    private: encKeys,
  };
  cryptoInstance.init(cryptoUser);

  // 5. Инициализация Dexie (local-first база)
  await initChatDb(address.value, ...);

  // 6. Запуск Matrix sync
  await matrixService.init();
};
```

---

## 7. Асинхронный polling блокчейна

После `register()` запускается двухфазный polling с экспоненциальным backoff:

```typescript
const startRegistrationPoll = () => {
  let pollInterval = 3000;       // Начальный интервал
  const MAX_POLL_INTERVAL = 60000; // Максимальный интервал
  let attempt = 0;

  const poll = async () => {
    attempt++;

    // ═══ Phase 1: Ожидание PKOIN ═══
    if (pendingRegProfile.value) {
      const hasUnspents = await appInitializer.checkUnspents(address.value);

      if (hasUnspents) {
        setRegistrationPhase('broadcasting');
        await appInitializer.syncNodeTime();

        const { encPublicKeys, image, ...profile } = pendingRegProfile.value;
        await appInitializer.registerUserProfile(
          address.value, profile, encPublicKeys, image
        );

        setRegistrationPhase('confirming');
        setPendingRegProfile(null); // профиль отправлен
        pollInterval = 3000;        // сброс интервала
        attempt = 0;
      }
      schedulePoll();
      return;
    }

    // ═══ Phase 2: Подтверждение на блокчейне ═══
    const actionsStatus = appInitializer.getAccountRegistrationStatus();
    if (actionsStatus === 'registered') {
      await onRegistrationConfirmed();
      return;
    }

    const confirmed = await appInitializer.checkUserRegistered(address.value);
    if (confirmed) {
      await onRegistrationConfirmed();
      return;
    }

    schedulePoll();
  };

  const schedulePoll = () => {
    registrationPollTimer = setTimeout(poll, pollInterval);
    pollInterval = Math.min(pollInterval * 2, MAX_POLL_INTERVAL);
    // 3s → 6s → 12s → 24s → 48s → 60s (max)
  };

  poll();
};
```

### onRegistrationConfirmed

```typescript
async function onRegistrationConfirmed() {
  setRegistrationPhase('done');
  await new Promise(resolve => setTimeout(resolve, 1500)); // overlay "Готово!"

  // Загрузка подтверждённого профиля с блокчейна
  await appInitializer.initializeAndFetchUserData(address.value, (data) => {
    setUserInfo(data);
    useUserStore().setUser(address.value, { ... });
  });

  setRegistrationPending(false);
  stopRegistrationPoll();

  // Matrix может быть ещё не инициализирован (edge case)
  if (!matrixReady.value) {
    await initMatrix();
  }
}
```

---

## 8. Персистентность и восстановление

Регистрация может быть прервана (закрытие вкладки, перезагрузка). Состояние сохраняется в localStorage:

| localStorage ключ | Тип | Назначение |
|---|---|---|
| `registration_pending` | `boolean` | Регистрация в процессе |
| `registration_profile` | `PendingRegProfile \| null` | Профиль + `encPublicKeys` до отправки UserInfo |
| `registration_phase` | `RegistrationPhase` | Фаза для UI stepper |
| `forta-chat:sessions` | `StoredSession[]` | Активные сессии |
| `forta-chat:activeAccount` | `string` | Текущий адрес |

### Восстановление при перезагрузке

В `App.vue`:

```typescript
if (authStore.isAuthenticated && authStore.registrationPending) {
  authStore.resumeRegistrationPoll();
}
```

`resumeRegistrationPoll` проверяет, не устарело ли состояние:

```typescript
const resumeRegistrationPoll = async () => {
  if (!registrationPending.value || registrationPollTimer) return;

  // Настройка SDK-конфигурации
  PocketnetInstanceConfigurator.setUserAddress(address.value);
  PocketnetInstanceConfigurator.setUserGetKeyPairFc(() =>
    createKeyPair(privateKey.value!)
  );

  // Проверка: может, ключи уже на блокчейне?
  const rawProfiles = await appInitializer.loadUsersInfoRaw([address.value]);
  const rawProfile = rawProfiles[0];

  if (rawProfile) {
    const rawKeys = rawProfile.k ?? rawProfile.keys ?? "";
    let blockchainKeys = Array.isArray(rawKeys)
      ? rawKeys.filter(k => k)
      : rawKeys.split(",").filter(k => k);

    if (blockchainKeys.length >= 12) {
      // Регистрация уже завершена — очищаем состояние
      setRegistrationPending(false);
      setPendingRegProfile(null);
      return;
    }
  }

  // Продолжаем polling
  startRegistrationPoll();
};
```

---

## 9. Обработка ошибок

### Ошибка code 18: имя занято/недопустимо

При попытке broadcast `UserInfo` может вернуться ошибка с кодом 18 (имя уже зарегистрировано другим пользователем в промежутке между проверкой и отправкой):

```typescript
const errCode = extractErrorCode(broadcastErr);
if (errCode === 18) {
  setRegistrationPhase('error');
  registrationUsernameError.value = true;
  setRegistrationPending(false);
  stopRegistrationPoll();
  return;
}
```

UI показывает поле для ввода нового имени. Обработчик:

```typescript
const retryRegistrationWithNewName = async (newName: string) => {
  registrationUsernameError.value = false;

  // Перегенерация ключей из того же privateKey
  const encKeys = generateEncryptionKeys(privateKey.value);
  const encPublicKeys = encKeys.map(k => k.public);

  // Обновление pending-профиля с новым именем
  setPendingRegProfile({
    name: newName, language, about, image, encPublicKeys
  });

  setRegistrationPending(true);
  setRegistrationPhase('init');
  startRegistrationPoll(); // PKOIN уже на балансе — сразу phase 1
};
```

### Прочие ошибки

- **Нет proxy-ноды** → `findRegistrationProxy()` выбрасывает `"No registration proxy available"`
- **Captcha неверна** → `submitCaptcha()` выбрасывает `"Incorrect captcha solution"`, UI позволяет повторить
- **Matrix `M_USER_DEACTIVATED`** → `getClient()` возвращает `null`, отображается ошибка
- **Сетевые ошибки при polling** → exponential backoff, polling продолжается бесконечно до успеха или logout

---

## 10. Файловая структура

```
src/
├── app/
│   ├── App.vue                          # RegistrationStepper overlay, resumeRegistrationPoll
│   └── providers/
│       ├── initializers/
│       │   └── app-initializer.ts       # RPC: proxy, captcha, free PKOIN, UserInfo tx
│       ├── chat-scripts/config/
│       │   ├── pocketnetinstance.ts      # Статическая конфигурация SDK
│       │   └── configurator.ts          # Runtime: address, keys, signature
│       └── router/
│           ├── routes/register.ts       # Маршрут /register
│           └── handlers/auth-guard.ts   # requiresGuest guard
│
├── entities/
│   ├── auth/
│   │   ├── model/
│   │   │   ├── stores.ts               # useAuthStore: register(), login(), polling, Matrix init
│   │   │   ├── key-pair.ts             # BIP39 → ECPair (m/44'/0'/0'/0')
│   │   │   ├── session-manager.ts      # Multi-session persistence
│   │   │   ├── types.ts                # AuthData, UserData
│   │   │   └── storage-migration.ts    # Legacy storage migration
│   │   └── lib/
│   │       └── get-address-from-pub-key.ts  # PublicKey → P2PKH address
│   │
│   └── matrix/
│       └── model/
│           ├── matrix-client.ts         # Matrix login + auto-register
│           ├── matrix-crypto.ts         # Pcrypto E2E (secp256k1 + AES)
│           ├── matrix-kit.ts            # Room topology helpers
│           └── types.ts                 # MatrixCredentials, MatrixUserData
│
├── features/
│   └── auth/
│       ├── index.ts                     # Exports: RegisterForm, LoginForm, LogoutButton
│       └── ui/
│           ├── register-form/
│           │   ├── RegisterForm.vue     # 3-step wizard shell
│           │   └── steps/
│           │       ├── ProfileStep.vue  # Имя, аватар, язык + key gen
│           │       ├── CaptchaStep.vue  # SVG captcha
│           │       └── SaveMnemonicStep.vue  # Показ мнемоника + register()
│           └── RegistrationStepper.vue  # Post-submit blockchain overlay
│
├── pages/
│   └── register/
│       └── RegisterPage.vue             # AuthLayout + RegisterForm
│
└── shared/
    └── lib/
        └── local-db/
            └── index.ts                 # initChatDb — Dexie setup after login
```

---

## Сводная таблица: что происходит на каждом этапе

| Этап | UI | Store | Blockchain | Matrix | Local DB |
|------|-------|-------|------------|--------|----------|
| **ProfileStep submit** | → Step 2 | `generateRegistrationKeys()`, `findRegistrationProxy()` | `getuseraddress` (проверка имени) | — | — |
| **CaptchaStep submit** | → Step 3 | `fetchCaptcha()`, `submitCaptcha()` | `fetchauth("captcha")`, `fetchauth("makecaptcha")` | — | — |
| **SaveMnemonicStep submit** | → ChatPage + Overlay | `register(profile)` | `fetchauth("free/balance")` | — | — |
| **register() внутри** | — | `login(mnemonic)` | — | `login/register` + `startClient` | `initChatDb()` |
| **Poll Phase 1** | "Подготовка..." | `startRegistrationPoll()` | `txunspent` → `UserInfo` tx | — | — |
| **Poll Phase 2** | "Подтверждение..." | polling | `getuserstate` | — | — |
| **Confirmed** | "Готово!" → скрыть | `onRegistrationConfirmed()` | — | `initMatrix()` (если нужно) | — |
