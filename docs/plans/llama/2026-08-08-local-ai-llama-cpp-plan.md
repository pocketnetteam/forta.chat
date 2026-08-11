# Local AI в Forta Chat: llama-cpp-capacitor, база + LoRA-адаптеры

**Дата:** 2026-08-08
**Статус:** research завершён, реализация не начата
**Пакет:** `llama-cpp-capacitor@0.1.5` (MIT, `arusatech/llama-cpp`)

## 1. Цель

Встроить оффлайн-инференс LLM в Forta Chat так, чтобы:

1. на устройстве лежала **одна базовая GGUF-модель**;
2. поверх неё применялись **LoRA-адаптеры**, каждый из которых в UI выглядит как отдельный чат (persona/домен);
3. база и адаптеры **скачивались по требованию**, а не входили в APK/AAB/IPA;
4. модели можно было **обновлять**, удаляя старые файлы, без потери истории переписки.

Non-goals для первой итерации: web/Electron инференс, multimodal, TTS, RAG/embeddings, синхронизация AI-чатов между устройствами.

> Knowledge packs / RAG вынесены в отдельный план  
> [`2026-08-08-local-ai-knowledge-rag-plan.md`](./2026-08-08-local-ai-knowledge-rag-plan.md)  
> и **заблокированы** до реализации этого документа.

## 2. Совместимость со стеком

| Forta Chat | `llama-cpp-capacitor` 0.1.5 |
|---|---|
| Capacitor **8.2.0** | peer `@capacitor/core >= 8.0.0` ✅ |
| Android `minSdk 24`, `compileSdk 36` | Android JNI, ABI `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` ✅ |
| iOS (`@capacitor/ios` 8.3.3) | iOS framework, Metal (`n_gpu_layers`) ✅ |
| Web (Vite) | ❌ Web не поддержан в README 0.1.5 |
| Electron 40 | ❌ (desktop есть только в отдельном `llama-cpp-pro`) |

**Вывод:** фича гейтится через `isNative` из `src/shared/lib/platform`. На web/Electron — скрытый UI либо явное «доступно в мобильном приложении».

## 3. Что даёт API плагина

### Runtime / инференс
- `initLlama(params, onProgress?)` → `LlamaContext`
- `context.completion({ messages | prompt, ... }, token => …)` — стриминг токенов
- `context.stopCompletion()`, `context.release()`, `releaseAllLlama()`
- `setContextLimit(limit)` — до 5 контекстов на native
- `context.bench(pp, tg, pl, nr)` → `BenchResult { tgAvg, ppAvg, … }`
- `loadLlamaModelInfo(path)` / `modelInfo({ path })` — метаданные GGUF без полной загрузки

### LoRA
- `initLlama({ lora, lora_scaled })` или `lora_list: [{ path, scaled }]`
- `context.applyLoraAdapters([{ path, scaled }])`
- `context.removeLoraAdapters()` — снимает **все**
- `context.getLoadedLoraAdapters()`

### Download / файлы (on-demand уже из коробки)
- `downloadModel(url, filename)`
- `getDownloadProgress(url)` → `{ progress, completed, failed, errorMessage?, localPath?, downloadedBytes, totalBytes }`
- `cancelDownload(url)`
- `getAvailableModels()` → `[{ name, path, size }]` (скан `.gguf/.ggml/.bin`)
- **`deleteModel` в плагине НЕТ** → удаление через `@capacitor/filesystem` по `path` из `getAvailableModels()`

### Session (KV-кэш)
- `context.saveSession(filepath, { tokenSize })` / `context.loadSession(filepath)`
- Это **не** история чата, а состояние контекста для быстрого продолжения.

### Ключевые `ContextParams` для мобилки
```ts
{
  model: string,
  n_ctx: 1024 | 2048,
  n_threads: 3 | 4,
  n_batch: 64,
  n_gpu_layers?: number,   // iOS/Metal — держим консервативно, см. §5
  use_mmap: true,
  use_mlock: false,
  ctx_shift?: boolean,
  lora_list?: Array<{ path: string; scaled?: number }>,
  draft_model?: string,    // speculative decoding
  mobile_speculative?: boolean,
  speculative_samples?: number,
}
```

## 4. Модель данных: адаптер ≠ чат-история

LoRA определяет **поведение** модели, а не переписку. Разделение:

```
1 base GGUF (скачивается один раз)
  ├─ adapter-coding.gguf  → AI-комната "Coding"
  ├─ adapter-legal.gguf   → AI-комната "Legal"
  └─ adapter-casual.gguf  → AI-комната "Casual"

История сообщений → Dexie (отдельные таблицы / отдельный тип room)
KV session файл    → опционально, ускоряет продолжение диалога
```

Что хранится где:

| Данные | Место |
|---|---|
| Список AI-комнат (`adapterId`, title, systemPrompt) | манифест + локальный registry |
| Сообщения AI-чата | Dexie (свои таблицы, **не** смешивать с Matrix rooms) |
| Файлы `.gguf` base/adapters | ФС устройства (`getAvailableModels()` их видит) |
| Указатели «что установлено и какой версии» | registry (Dexie или Preferences) |
| KV session | `session-<roomId>-<baseId>.bin` |

**AI-чаты не должны попадать в Matrix sync / E2EE-пайплайн** — это отдельный тип комнаты, иначе поедут SyncEngine и EventWriter.

## 5. Eligibility модели (без device tier)

**Решение: фиксированных тиров устройства (`low` / `mid` / `high`) нет.** Правила «4 GB = low» через пару лет устареют и потребуют релиза приложения. Вместо этого каждая модель декларирует требования, а клиент через `@capgo/capacitor-device-info` отвечает: **можно ли запустить именно эту модель на этом железе**.

### Сигналы с устройства

| Сигнал | Источник | Зачем |
|---|---|---|
| Total / free RAM | `@capgo/capacitor-device-info` (`MemoryInfo`) | влезет ли модель |
| Free disk | device-info `StorageInfo` (fallback — `Device.getInfo().realDiskFree`) | хватит ли места на download |
| Thermal / pressure / lowMemory | device-info | деградация / предупреждения |
| Реальная скорость | `context.bench()` → `tgAvg` после первой загрузки | локальный blacklist «too slow» |
| OOM / init failure | runtime | локальный blacklist «oom» |

`@capacitor/device` даёт только `memUsed` приложения — для eligibility недостаточно. **`@capgo/capacitor-device-info` — обязательная зависимость.**

### Требования модели (в манифесте)

Правило большого пальца при **наполнении** манифеста: `minRamGb ≈ 2 × sizeBytes` (веса + KV + ОС + Forta). Это число лежит в JSON и меняется без обновления клиента.

**Верхняя граница по продукту — 4B Q4_K_M.** Выше не идём.

```ts
type Eligibility = 'ok' | 'tight' | 'no';

type DeviceSnapshot = {
  totalRamGb: number;
  freeRamGb: number;
  freeDiskBytes: number;
  thermal?: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
  lowMemory?: boolean;
};

type LocalModelVerdict = 'tooSlow' | 'oom'; // кэш на устройстве после bench/crash

function canRun(
  model: { minRamGb: number; recommendedRamGb: number; sizeBytes: number },
  device: DeviceSnapshot,
  prior?: LocalModelVerdict,
): Eligibility {
  if (prior === 'oom') return 'no';
  if (device.totalRamGb < model.minRamGb) return 'no';
  if (device.freeDiskBytes < model.sizeBytes * 1.1) return 'no';
  if (prior === 'tooSlow') return 'tight'; // можно вручную, не рекомендуем
  if (device.freeRamGb < model.minRamGb * 0.5) return 'tight';
  if (device.totalRamGb < model.recommendedRamGb) return 'tight';
  return 'ok';
}
```

### Выбор recommended base

```text
candidates = bases
  .filter(channel + contentRating + status === 'active')
  .filter(canRun !== 'no')
  .sort(by qualityRank desc, then sizeBytes asc)

recommended = first where canRun === 'ok'
  else first where canRun === 'tight'  // с предупреждением в UI
```

UI не угадывает молча: «Рекомендуем X (~1.1 GB)» + Advanced-список всех `ok`/`tight` (с пометкой риска). Модели с `canRun === 'no'` в обычном каталоге скрыты (или disabled с причиной: мало RAM / мало места).

Калибровка после первой загрузки:
- `tgAvg < 3 tok/s` → локально `tooSlow` для этого `modelId`, предложить меньшую базу;
- `initLlama` OOM → локально `oom`, fallback на следующую по `qualityRank` среди `ok`;
- thermal `serious/critical` → предупреждение + меньший `n_ctx` / retry с `n_gpu_layers: 0`.

Через 2 года меняются только цифры в манифесте (`minRamGb`, `recommendedRamGb`, список моделей) — **без** релиза логики `pickTier`.

### GPU-политика (`n_gpu_layers`)

**Решение: консервативно.** Не подбираем оффлоад по устройству и не гонимся за максимумом слоёв:

- Android — `n_gpu_layers` в `ContextParams` документирован как iOS-only, поэтому фактически CPU (`n_threads: 3–4`);
- iOS/Metal — небольшое фиксированное значение из манифеста (`nGpuLayersDefault`, по умолчанию `0`), поднимаем точечно только после замеров на реальных устройствах;
- `flash_attn` не включаем (экспериментальный);
- при `initLlama` failure или thermal `serious/critical` — retry с `n_gpu_layers: 0`.

Причина: агрессивный Metal-оффлоад даёт нестабильную память на старых iPhone, а выигрыш на 1.5–4B моделях не окупает риск краша.

## 6. Манифест моделей

Каталог не хардкодим в UI — тянем JSON. База выбирается по **eligibility** (`canRun` + `qualityRank`), **адаптеры — по `baseId`**.

**Хостинг — Hugging Face.** Файлы отдаются по `https://huggingface.co/<repo>/resolve/<revision>/<file>.gguf`, где `<revision>` — **пиннутый commit SHA**, не `main`. Это даёт воспроизводимость и защищает от подмены содержимого под тем же URL.

> ⚠️ **Конкретный список моделей и адаптеров задаёт владелец продукта.** Ниже — структура манифеста с placeholder-значениями (`repo`, `revision`, `sha256`, `sizeBytes` подставляются при заполнении каталога).

```json
{
  "manifestVersion": 3,
  "bases": {
    "<base-id-small>": {
      "family": "<family-name>",
      "paramsB": 1.5,
      "qualityRank": 10,
      "status": "active",
      "hf": {
        "repo": "<org>/<repo>-GGUF",
        "revision": "<commit-sha>",
        "file": "<model>.Q4_K_M.gguf"
      },
      "filename": "base__<base-id-small>__v3.gguf",
      "sha256": "…",
      "sizeBytes": 0,
      "minRamGb": 4,
      "recommendedRamGb": 6,
      "nCtxDefault": 2048,
      "nGpuLayersDefault": 0,
      "contentRating": "filtered",
      "channels": ["play", "appstore", "sideload"]
    },
    "<base-id-large>": {
      "family": "<family-name>",
      "paramsB": 3,
      "qualityRank": 20,
      "status": "active",
      "replaces": ["<base-id-small-deprecated>"],
      "hf": {
        "repo": "<org>/<repo>-GGUF",
        "revision": "<commit-sha>",
        "file": "<model>.Q4_K_M.gguf"
      },
      "filename": "base__<base-id-large>__v3.gguf",
      "sha256": "…",
      "sizeBytes": 0,
      "minRamGb": 6,
      "recommendedRamGb": 8,
      "nCtxDefault": 2048,
      "nGpuLayersDefault": 0,
      "contentRating": "unfiltered",
      "channels": ["sideload"]
    }
  },
  "adapters": [
    {
      "id": "coding",
      "baseId": "<base-id-small>",
      "title": "Coding",
      "systemPrompt": "…",
      "status": "active",
      "hf": {
        "repo": "<org>/<adapters-repo>",
        "revision": "<commit-sha>",
        "file": "coding-<base-id-small>.gguf"
      },
      "filename": "adapter__coding__<base-id-small>__v3.gguf",
      "sha256": "…",
      "sizeBytes": 0,
      "contentRating": "filtered",
      "channels": ["play", "appstore", "sideload"]
    },
    {
      "id": "coding",
      "baseId": "<base-id-large>",
      "title": "Coding",
      "status": "active",
      "hf": {
        "repo": "<org>/<adapters-repo>",
        "revision": "<commit-sha>",
        "file": "coding-<base-id-large>.gguf"
      },
      "filename": "adapter__coding__<base-id-large>__v3.gguf",
      "sha256": "…",
      "sizeBytes": 0,
      "contentRating": "unfiltered",
      "channels": ["sideload"]
    }
  ]
}
```

Поля иерархии / жизненного цикла у base:

| Поле | Назначение |
|---|---|
| `family` | семейство (для upgrade внутри линейки) |
| `paramsB` | размер в миллиардах параметров (UI / сортировка) |
| `qualityRank` | чем больше — тем «лучше» в каталоге |
| `status` | `active` \| `deprecated` \| `withdrawn` (withdrawn в манифест не кладём) |
| `replaces` / `replacedBy` | явная связь «старое → новое» для replace-flow |
| `minRamGb` / `recommendedRamGb` | eligibility без device tier |
| *(нет `tier`)* | убрано намеренно |

URL собирается из `hf`, а не хранится строкой — так пиннинг ревизии нельзя случайно потерять:

```ts
const hfUrl = ({ repo, revision, file }: HfRef): string =>
  `https://huggingface.co/${repo}/resolve/${revision}/${file}?download=true`;
```

Правила:
- один логический чат (`coding`) имеет **запись на каждый `baseId`**;
- LoRA от большей базы не применяется к меньшей — архитектура должна совпадать, иначе `applyLoraAdapters` падает;
- адаптеры 10–200 MB → на eligibility почти не влияют, ограничивает только диск;
- filenames **immutable и версионированы** — это основа безопасного обновления;
- `revision` всегда commit SHA; `main` запрещён (содержимое может поменяться под тем же URL);
- модели должны быть **Q4_K_M** и не больше 4B параметров;
- у каждой записи (и base, и adapter) обязательны `contentRating` и `channels` — см. §6.1;
- поле `tier` у моделей **запрещено** — только eligibility-поля.

### 6.1 Каналы распространения и фильтрация моделей

Store-сборки должны видеть **только цензурируемые модели**, sideload APK может предлагать модели **без цензуры**. Каналы уже существуют в репозитории — переиспользуем их, ничего нового не изобретаем:

| Канал | Сборка | Модели | Флаг |
|---|---|---|---|
| **Google Play** | `npm run cap:aab:play` → `bundlePlayRelease` (flavor `play`) | только `filtered` | `ALLOW_UNFILTERED_MODELS=false` |
| **App Store (iOS)** | `npm run cap:build:ios` | только `filtered` | флейворов нет → hardcode `false` |
| **Sideload APK** | `npm run cap:apk` → `assembleSideloadRelease` (flavor `sideload`) | `filtered` + `unfiltered` по opt-in | `ALLOW_UNFILTERED_MODELS=true` |

#### Источник истины — нативный `BuildConfig`, не Vite env

`npm run cap:build` собирает web-бандл **один раз** и синкает его в оба флейвора, поэтому флаг уровня `import.meta.env` может разойтись с реально собранным APK (собрали play-AAB с sideload-бандлом — и цензура «протекла»). Флаг должен приходить из флейвора, как это уже сделано для апдейтера:

```gradle
// android/app/build.gradle — рядом с ENABLE_APP_UPDATER
sideload {
    buildConfigField "boolean", "ALLOW_UNFILTERED_MODELS", "true"
}
play {
    buildConfigField "boolean", "ALLOW_UNFILTERED_MODELS", "false"
}
```

JS-резолвер — по образцу `src/shared/lib/platform/resolve-app-updater-enabled.ts`:

```ts
export type DistributionChannel = 'play' | 'appstore' | 'sideload' | 'other';

/** Fail-closed: любая ошибка/неизвестная платформа → без unfiltered. */
export async function resolveAllowUnfilteredModels(): Promise<boolean>;
export async function resolveDistributionChannel(): Promise<DistributionChannel>;
```

Правила резолвера:
- iOS → `appstore`, `false` без вариантов;
- web/Electron → `other`, фича вообще скрыта (`isNative`);
- Android → читаем `BuildConfig` через нативный мост; **исключение или отсутствие значения = `false`**.

#### Два манифеста, а не только клиентский фильтр

Клиентская фильтрация — второй барьер, не первый. Основной — **раздельные манифесты**:

| Канал | Манифест |
|---|---|
| `play` / `appstore` | `manifest-filtered.json` — в нём физически нет unfiltered-записей |
| `sideload` | `manifest-full.json` |

Зачем: store-сборка не должна даже **перечислять** модели без цензуры. Если фильтровать только на клиенте, ревьюер (или любой, кто снимет трафик) увидит в ответе каталог uncensored-моделей, доступный из store-приложения — это ровно тот риск, который правила магазинов и ловят.

Клиентский фильтр всё равно применяем поверх:

```ts
const visible = entries.filter(
  (e) =>
    e.channels.includes(channel) &&
    (e.contentRating === 'filtered' || allowUnfiltered),
);
```

**Fail-closed по умолчанию:** запись без `contentRating` трактуется как `unfiltered` и в store-сборке скрывается. Отсутствие поля — ошибка наполнения каталога, а не «разрешено».

#### Opt-in на sideload

Даже там, где unfiltered разрешён, он не включён по умолчанию:

1. в Settings → Local AI переключатель «Модели без фильтрации», по умолчанию **off**;
2. **без** возрастной отсечки и без диалога 18+ — обычный тогл, как любая настройка;
3. включение **ничего не качает** — просто расширяет каталог;
4. выключение → предложить удалить уже скачанные unfiltered-файлы (история чатов при этом **не** удаляется, см. §8).

Адаптер с `contentRating: "unfiltered"` не предлагается, если канал/opt-in не разрешают — даже если его база уже установлена.

#### Верификация сборки

`scripts/verify-android-distribution.mjs` уже проверяет `ENABLE_APP_UPDATER` в `BuildConfig.java` обоих флейворов — расширяем его на `ALLOW_UNFILTERED_MODELS` (`true` для sideload, `false` для play) плюс кейсы в `scripts/verify-android-distribution.test.ts`. Так «play-сборка с разрешёнными uncensored-моделями» падает в CI, а не в ревью магазина.

## 7. Поток «пользователь открыл AI-чат»

```text
open AI room (adapterId)
  → resolve channel + allowUnfiltered (BuildConfig / fail-closed)
  → entry видима по contentRating+channels+opt-in?  нет → не открываем (не должно быть в UI)
  → resolve baseId из registry (что установлено)
  → base файл есть?      нет → downloadModel(base.url, base.filename) + progress UI
  → adapter файл есть?   нет → downloadModel(adapter.url, adapter.filename) + progress UI
  → verify sha256 / sizeBytes
  → context есть?
       нет → initLlama({ model: basePath, n_ctx, use_mmap: true, lora_list: [{ path, scaled: 1.0 }] })
       да  → removeLoraAdapters() → applyLoraAdapters([{ path, scaled: 1.0 }])
  → (опц.) loadSession(`session-${roomId}-${baseId}.bin`)
  → completion({ messages: [systemPrompt, ...historyFromDexie, userMsg] }, token => appendToUi)
  → записать ответ в Dexie
  → (опц.) saveSession(...)
```

Скелет `ensureDownloaded`:

```ts
import {
  downloadModel,
  getDownloadProgress,
  getAvailableModels,
} from 'llama-cpp-capacitor';

async function ensureDownloaded(url: string, filename: string): Promise<string> {
  const onDisk = await getAvailableModels();
  const hit = onDisk.find((m) => m.name === filename);
  if (hit) return hit.path;

  await downloadModel(url, filename);
  // poll getDownloadProgress(url) до completed / failed, прокидывая progress в UI
  const { localPath, failed, errorMessage } = await getDownloadProgress(url);
  if (failed || !localPath) throw new Error(errorMessage ?? 'model download failed');
  return localPath;
}
```

## 8. Обновление моделей, иерархия предложений и жизненный цикл манифеста

### 8.1 Три разных сигнала (не путать)

| Сигнал | Когда | UX | Что на диске |
|---|---|---|---|
| **Patch** | тот же `baseId`, другой `filename` / `sha256` (vN→vN+1) | «Обновить модель» | скачать новое → удалить старое → снести адаптеры этой базы |
| **Upgrade** | та же `family` (или явный `upgradePath`), больший `qualityRank`, `canRun === 'ok'` | «Доступна более сильная модель (3B, +1.2 GB)» — только opt-in | как смена базы: старые adapters удалить, новые — лениво |
| **Replace / deprecated** | installed отсутствует в манифесте, `status: deprecated`, или есть `replacedBy` | «Текущая модель устарела, рекомендуем X» | то же + orphan cleanup |

Автоматически базу **не меняем** — только баннер / Settings. История чатов не трогается.

Upgrade показываем только если:
- `candidate.family === installed.family` (или явно в `upgradePath` / `replaces`);
- `candidate.qualityRank > installed.qualityRank`;
- `canRun(candidate) === 'ok'`;
- пользователь ещё не отклонил предложение для этого `candidate.id`.

### 8.2 Манифест не копится

**Remote manifest = текущий каталог предложения, не архив.** Через год в JSON не 80 мёртвых баз, а ~3–6 `active` + опционально 1–2 `deprecated` с `replacedBy`.

| `status` | В манифесте? | Поведение клиента |
|---|---|---|
| `active` | да | в каталоге, можно ставить |
| `deprecated` | да, **1–2 релиза** | у кого установлена — «замените на X»; новым не предлагать как recommended |
| `withdrawn` | **нет** (вычёркиваем) | id нет в манифесте → orphan / «модель больше не поддерживается, удалить?» |

Три слоя хранения:

| Слой | Что хранит | Живёт сколько |
|---|---|---|
| **Remote manifest** (`filtered` / `full`) | только актуальные + кратко deprecated | чистите при публикации на HF |
| **Local registry** | что установлено (`baseId`, path, version, verdicts) | пока юзер не удалит / не заменит |
| **Диск (`.gguf`)** | файлы | orphan cleanup относительно registry + **текущего** манифеста |

### 8.3 Алгоритм после fetch манифеста

```text
1. обновить кэш манифеста
2. если installed.baseId отсутствует или status ≠ active
     → предложить Replace (replacedBy / лучший active с canRun=ok)
3. если есть active с тем же id и другим filename/sha
     → предложить Patch-update
4. если есть active с большим qualityRank, той же family, canRun=ok
     → предложить Upgrade (если не dismissed)
5. orphan cleanup: файлы не из registry и не из current manifest → удалить
6. (store-сборка) если на диске unfiltered при allowUnfiltered=false → предложить/удалить
```

### 8.4 Алгоритм смены / патча базы (безопасный порядок)

```text
1. fetch remote manifest
2. сравнить installed ↔ манифест (patch / upgrade / replace)
3. если пользователь подтвердил смену/патч:
   a. releaseAllLlama()                       // обязательно выгрузить из RAM
   b. downloadModel(new base, filename vN+1)  // новое имя, старое пока живо
   c. verify sha256 + sizeBytes
   d. переключить pointer в registry на новый path / baseId
   e. Filesystem.deleteFile(старый base)
   f. удалить session-*.bin старой базы (KV несовместим)
   g. удалить ВСЕ локальные adapters с прежним baseId
4. adapters докачиваются лениво — при следующем входе в соответствующий AI-чат
```

Правило: **сначала скачать и проверить новое, только потом удалять старое.** Иначе оборванная закачка оставит пользователя без модели.

### 8.5 Что чистить и когда

| Событие | Что удалять | История чатов |
|---|---|---|
| Patch той же базы (v3 → v4) | старый base + его sessions + адаптеры этой базы | сохраняется |
| Upgrade / Replace (другой `baseId`) | старый base + **все** его adapters + sessions | сохраняется |
| «Очистить AI» в настройках | всё из registry + orphan `.gguf` | по решению пользователя |
| Мало места | orphan / прошлые версии; активный base не трогать | сохраняется |
| Модель `withdrawn` / нет в манифесте | предложить удалить файл + adapters | сохраняется |
| Выключение unfiltered-тогла / переход на store | unfiltered-файлы | сохраняется |

**История чатов не зависит от файлов моделей.** Удаление `.gguf` = только повторная докачка при следующем открытии чата; сообщения в Dexie остаются. Максимум — сброшенный KV session (первый ответ после апдейта чуть медленнее).

### 8.6 Orphan cleanup

```ts
const known = new Set([
  ...registryFilenames(),
  ...currentManifestFilenames(), // active + deprecated still listed
]);
const onDisk = await getAvailableModels();
for (const f of onDisk) {
  if (!known.has(f.name)) {
    await Filesystem.deleteFile({ path: f.path });
  }
}
```

⚠️ Точный вызов `deleteFile` зависит от того, абсолютный ли `path` или нужен `Directory` — отладить один раз на Android и iOS (в 0.1.5 сканируются Documents/Downloads на iOS и internal+external storage на Android).

## 9. UI: навигация и настройки

### 9.1 Список чатов — вкладка AI

В сайдбаре Chats уже есть фильтры `All` / `Personal` / `Groups` (+ условные `Invites` / `Channels`):

- `ChatSidebar.vue` → `visibleTabValues`: `["all", "personal", "groups", …]`
- `filterRoomsForTab` / тип `ContactListTab` в `src/entities/chat/lib/room-visibility.ts`
- i18n: `tabs.all` / `tabs.personal` / `tabs.groups`

**Решение:** добавить вкладку **`AI`** рядом с ними.

| Вкладка | Что показывает |
|---|---|
| **All** | обычные чаты **и** AI-чаты (как invites уже попадают в All) |
| **Personal** | только 1:1 Matrix, **без** AI |
| **Groups** | только группы Matrix, **без** AI |
| **AI** | только локальные AI-комнаты (адаптеры) |

Правила:
- вкладка `AI` видна только при `isNative` (и когда фича включена); на web/Electron её нет;
- AI-чаты **не** Matrix rooms — отдельный источник списка (Dexie local-ai), в `All` мержатся с Matrix-списком по `updatedAt` / активности;
- `filterRoomsForTab` / `ContactListTab` расширяются значением `"ai"` (плюс тесты в `room-visibility.test.ts`);
- ForwardPicker (`all`/`personal`/`groups`) AI не трогаем в MVP — пересылка в/из AI out of scope.

Открытие пункта из вкладки AI → `LocalAiRoom` (стриминг, download progress при первом заходе в адаптер).

### 9.2 Настройки — отдельная группа Local AI

В `SettingsPanel` / `SettingsContentPanel` — **отдельная группа/секция** (не внутри Storage), наравне с Appearance / Notifications / Storage:

**Local AI** (только `isNative`):
- рекомендуемая / установленная база, размер на диске;
- скачать / обновить (patch) / сменить модель (upgrade/replace);
- баннер предложений апдейта (или тот же контент, что `ModelUpdateBanner`);
- Storage AI: удалить базу / адаптеры / orphan cleanup;
- sideload: тогл «Модели без фильтрации» (off по умолчанию, без 18+);
- опц. сброс локальных verdicts (`tooSlow` / `oom`).

На web/Electron секция либо скрыта, либо показывает «доступно в мобильном приложении».

### 9.3 Компоненты UI (сводка)

| Компонент | Где |
|---|---|
| Вкладка `AI` в фильтрах чатов | `ChatSidebar` + `filterRoomsForTab` |
| AI-чаты в `All` | merge local-ai rooms в общий список |
| `LocalAiRoom.vue` | окно чата с адаптером |
| `ModelDownloadCard.vue` | progress / cancel скачивания |
| `ModelUpdateBanner.vue` | patch / upgrade / replace CTA |
| Секция Settings → Local AI | `SettingsPanel` + content panel |
| `ModelStorageSettings.vue` | подсекция Storage внутри Local AI |

## 10. Структура кода (FSD)

```
src/shared/lib/platform/
  resolve-unfiltered-models.ts  # DistributionChannel + resolveAllowUnfilteredModels() (fail-closed)

src/shared/lib/llama/
  llama-runtime.ts          # обёртка initLlama/release, единый shared context, isNative guard
  llama-download.ts         # downloadModel + polling progress + cancel + verify
  llama-files.ts            # getAvailableModels + Filesystem.deleteFile + orphan cleanup
  types.ts

src/features/local-ai/
  model/
    use-model-catalog.ts       # fetch манифеста (filtered|full), content filter
    model-content-filter.ts    # channel + contentRating + opt-in → visible (юнит-тесты)
    model-eligibility.ts       # canRun(device, model, priorVerdict) → ok|tight|no
    model-recommendations.ts   # patch / upgrade / replace proposals из манифеста + registry
    use-device-snapshot.ts     # device-info → DeviceSnapshot
    use-model-registry.ts      # installed paths/versions + local verdicts (tooSlow/oom)
    use-adapter-session.ts     # apply/remove LoRA, save/loadSession
    use-ai-chat.ts             # completion + стриминг + запись в Dexie
  ui/
    LocalAiRoom.vue
    ModelDownloadCard.vue
    ModelUpdateBanner.vue      # patch / upgrade / replace CTA
    ModelStorageSettings.vue   # размер, обновить, удалить, unfiltered toggle
    LocalAiSettingsSection.vue # группа в Settings
  index.ts
```

Гейт везде: `isNative` из `src/shared/lib/platform`. Расширения существующего UI: `ChatSidebar.vue` (вкладка `ai`), `room-visibility.ts` (`ContactListTab` + `filterRoomsForTab`), i18n `tabs.ai`, `SettingsPanel.vue` / `SettingsContentPanel.vue`.

## 11. Фазы реализации

| Фаза | Объём | Выход |
|---|---|---|
| **1. Нативная интеграция** | `npm i llama-cpp-capacitor @capgo/capacitor-device-info`, `cap sync android/ios`, замер прироста APK/AAB, проверка `cap:apk` и iOS pipeline | сборка проходит, размер известен |
| **2. Runtime wrapper** | `shared/lib/llama/*`, `DeviceSnapshot` + `canRun`, `initLlama` + `bench` на устройстве | загрузка 1.5B работает, есть tok/s и eligibility |
| **3. On-demand download** | манифест (HF `resolve` + pinned revision), `ensureDownloaded`, progress/cancel UI, sha256, follow-redirect | base качается с прогрессом, cancel работает |
| **3.5. Каналы и фильтрация** | `ALLOW_UNFILTERED_MODELS`, `resolveAllowUnfilteredModels()`, два манифеста, Settings-тогл, `verify-android-distribution` | play/appstore видят только `filtered`, CI проверяет |
| **4. Адаптер-как-чат + UI навигация** | Dexie AI-чаты, вкладка `AI` + merge в `All`, секция Settings → Local AI, apply/remove LoRA, стриминг | AI видны во вкладке AI и в All; настройки — отдельная группа |
| **5. Обновления / иерархия / cleanup** | registry, patch/upgrade/replace, `status`/`replaces`/`qualityRank`, orphan cleanup, Storage UI | предложения апдейта работают; манифест не копит withdrawn |
| **6. UX / полировка** | OOM/tooSlow blacklist, thermal, `stopCompletion`, i18n (`tabs.ai`), dismissed-upgrade | стабильный UX на слабых устройствах |

Каждая фаза — с тестами (юнит на `canRun`, recommendations, content-filter, cleanup, `filterRoomsForTab` + `"ai"`; регрессии «история не теряется»). Перед коммитом: `npm run build`, `npm run lint`, `npx vue-tsc --noEmit`, `npm run test`, code review.

## 12. Риски и ограничения

| Риск | Митигация |
|---|---|
| **Только native** — web/Electron без инференса | `isNative` гейт, честное сообщение в UI; вкладка AI и секция Settings скрыты |
| **Размер билда** — `.so` под 4 ABI | ограничить ABI (`arm64-v8a` + `armeabi-v7a`), проверить `cap:verify-dist` |
| **RAM/OOM на mid-range Android 7** | жёсткий `minRamGb`, потолок 4B, fallback при OOM, локальный verdict, `use_mlock: false` |
| **Медленная генерация** | `stopCompletion`, стриминг, `tooSlow` blacklist, честный индикатор |
| **Устаревшие правила железа** | нет device tier в клиенте — только поля манифеста + device-info |
| **Раздутый манифест** | `withdrawn` вычёркивать; `deprecated` держать 1–2 релиза с `replacedBy` |
| **Hugging Face** — CDN/rate-limit/регионы | пиннинг `revision`, sha256, retry/resume, опц. `HF_MIRROR`, понятная ошибка в UI |
| **HF `resolve` → 302** | проверить follow-redirect на Android/iOS в фазе 3; иначе свой download |
| **Tor** — `downloadModel` мимо SOCKS | предупредить или свой download через `file-transfer` |
| **Приватность / целостность** | pinned repo+revision, sha256, никакого исполнения кода из моделей |
| **Смешение с Matrix** | отдельный тип комнаты и таблицы, вне SyncEngine/EventWriter; в UI — отдельная вкладка AI |
| **Политики магазинов** | раздельные манифесты, `BuildConfig`, fail-closed, `verify-android-distribution` |
| **Рассинхрон web-бандла и флейвора** | флаг только из `BuildConfig`, не из `import.meta.env` |
| **Unfiltered на sideload** | тогл off по умолчанию (без 18+), удаление unfiltered одним действием |
| **CI** | нативная сборка llama.cpp — отдельный job/кэш |
| **Несовместимый LoRA** | `baseId` + проверка перед `applyLoraAdapters` |

## 13. MVP-срез

0. Заполненный манифест: 1–2 base + 1–2 адаптера с HF repo/revision/sha256, `minRamGb`/`qualityRank`/`status` (от владельца продукта).
1. Один recommended base (eligibility=`ok`) + 1–2 адаптера (`contentRating: "filtered"` для store).
2. Экран «Скачать AI» с прогрессом и cancel.
3. Вкладка **AI** в Chats + AI-чаты также в **All**; Personal/Groups без AI.
4. Список AI-комнат = адаптеры под установленный `baseId`, отфильтрованные по каналу.
5. Стриминг ответа в чат-UI.
6. История в Dexie; KV sessions — позже.
7. Settings → **отдельная группа Local AI** (база, storage, unfiltered-тогл на sideload).
8. Feature-flag + `isNative`.
9. Sideload: unfiltered-тогл (off, без 18+) + `verify-android-distribution`.
10. Баннер patch/replace (upgrade можно во второй итерации фазы 5).

## 14. Принятые решения

| Вопрос | Решение |
|---|---|
| Хостинг моделей | **Hugging Face**, `resolve/<commit-sha>/<file>`, `main` запрещён |
| `@capgo/capacitor-device-info` | **добавляем** — total/free RAM, storage, thermal |
| Device tier (`low/mid/high`) | **нет** — eligibility через `canRun(model, device)` |
| Как рекомендуем базу | `qualityRank` + `canRun === 'ok'` (иначе `tight` с предупреждением) |
| Иерархия апдейтов | **patch / upgrade / replace** — разные UX; автосмены базы нет |
| Жизненный цикл манифеста | **не копится**: `active` + кратко `deprecated`; `withdrawn` вычёркиваем |
| `n_gpu_layers` | **консервативно**: default `0`; Android — CPU |
| Верхняя граница модели | **4B Q4_K_M** |
| Список моделей и адаптеров | **задаёт владелец продукта**, в манифесте placeholder'ы |
| Цензура по каналу | **store — только `filtered`; sideload — `unfiltered` по Settings-тоглу (без 18+)** |
| Источник флага цензуры | **`BuildConfig.ALLOW_UNFILTERED_MODELS`**, не Vite env; fail-closed |
| Как фильтруем | **два манифеста** + клиентский фильтр |
| 18+ | **нет** |
| После смены базы | адаптеры удалить; история чатов остаётся; докачка адаптеров лениво |
| UI: список чатов | вкладка **AI** рядом с All/Personal/Groups; AI также в **All**; не в Personal/Groups |
| UI: настройки | **отдельная группа Local AI** в Settings (не внутри Storage) |

## 15. Открытые вопросы

- Нужно ли зеркало HF (`HF_MIRROR`) на своём хосте для регионов с блокировками, и кто его держит?
- Разрешаем ли в Advanced ставить модель с `canRun === 'tight'` / даже `'no'` под свою ответственность?
- Нужна ли выгрузка контекста при уходе приложения в фон (память Android) — вероятно да, через `@capacitor/app` state.
- Приватный HF-репозиторий (нужен ли токен) или публичный?
- Кто и как генерирует LoRA-адаптеры под каждую базу при обновлении базовой модели?
- Что именно считаем `filtered` — готовые safety-tuned или своя проверка перед каталогом?
- Если пользователь перешёл со sideload на Play — удалять unfiltered при первом запуске store-сборки? (по умолчанию — да, fail-closed)
- Сколько релизов держать `deprecated` в манифесте перед `withdrawn` (предложение: 1–2)?
- Нужен ли явный `upgradePath[]` в манифесте или достаточно `family` + `qualityRank`?
- Вкладка AI всегда видна (пустой стейт «скачайте модель») или только после первой установки базы / появления AI-комнат (как Channels)?
