# Knowledge packs / RAG поверх Local AI

**Дата:** 2026-08-08  
**Статус:** research / отложен  
**Зависимость:** ⛔ **BLOCKED** — начинать только после реализации  
[`2026-08-08-local-ai-llama-cpp-plan.md`](./2026-08-08-local-ai-llama-cpp-plan.md)

Пока основной план (base + LoRA + download + вкладка AI + Settings) не закрыт, этот документ — только спецификация. Код RAG / knowledge packs не пишем.

## 1. Цель

Дать AI-комнатам второй слой знаний поверх (или вместо) LoRA:

- **LoRA** = «как» отвечать (стиль, роль: юрист, саппорт…);
- **Knowledge pack** = «из чего» отвечать (глоссарий, FAQ, правила, корпус текстов).

Типичный кейс: чат «Юрист» = LoRA «юрист» **+** knowledge pack с терминами/выписками → retrieve/stuff в контекст → `completion` на той же base.

В промпт всегда идут **тексты**. Embedding-веса нужны только для семантического поиска, не вместо корпуса.

## 2. Блокер и предпосылки из основного плана

Без этого RAG не стартует:

| Из основного плана | Зачем RAG |
|---|---|
| `llama-cpp-capacitor` + runtime wrapper | `completion`, `embedding`, `rerank` |
| On-demand download + registry | качать texts / embedding GGUF |
| AI-комната в UI (вкладка AI / All) | куда вешать `kind: knowledge` / `lora+knowledge` |
| Манифест + `contentRating` / channels | store vs sideload для packs |
| Eligibility / `n_ctx` | бюджет окна под retrieved chunks |

Non-goal основного MVP («без RAG/embeddings») остаётся в силе до снятия блокера.

## 3. LoRA vs Knowledge — слои

```text
base GGUF
  └─ optional LoRA adapter          → поведение / persona
       └─ optional Knowledge pack   → факты в контексте (RAG / stuff)
            └─ user message + history
```

| Вид AI-комнаты | LoRA | Knowledge |
|---|---|---|
| `lora` | да | нет |
| `knowledge` | нет | да |
| `lora+knowledge` | да | да (расширение адаптера) |

После смены base: LoRA удаляем (как в основном плане). **Knowledge texts обычно оставляем** (не привязаны к архитектуре base). Embedding-модель — общая на приложение; индекс пересобираем, если сменился embedding GGUF.

## 4. Что скачиваем (on-demand, не в APK)

Не кладём packs в бандл. Всё через тот же пайплайн download/registry (HF + sha256 + immutable filenames), что и модели:

| Артефакт | Обязателен? | Примечание |
|---|---|---|
| **Texts pack** (jsonl / markdown / chunk dump) | да | корпус знаний |
| **Embedding GGUF** | только для semantic RAG | одна модель на приложение, не на каждый pack |
| **Векторный индекс** | нет на HF по умолчанию | **строить на устройстве** после скачивания texts (+ embedding) |

Поток открытия `lora+knowledge` чата:

```text
1. base есть?            → download
2. LoRA есть?            → download
3. texts pack есть?      → download
4. если mode=embed:
     embedding GGUF есть? → download
     индекс для pack готов? иначе chunk → embedding() → Dexie
5. applyLoraAdapters
6. retrieve top-k texts (или stuff)
7. completion({ messages: [system+knowledge, ...history, user] })
```

## 5. Три режима retrieval

| Режим | Когда | Нужен embedding GGUF? |
|---|---|---|
| **`stuff`** | pack мал, влезает в `n_ctx` с запасом | нет |
| **`keyword`** | pack больше окна; простой поиск по чанкам (BM25/trigram) | нет |
| **`embed`** | большой корпус, нужен смысловой поиск | **да** |

Рекомендация по фазам: сначала `stuff` + `keyword`, `embed` — когда texts-only упрётся в качество.

Жёсткий лимит: сумма токенов (system + retrieved + history + user) < `n_ctx` (на mid обычно 1024–2048). Top-k и maxCharsPerChunk — в манифесте pack.

## 6. Манифест (расширение)

Дополняет каталог основного плана (те же `contentRating`, `channels`, `status`, HF `resolve` + pinned revision):

```json
{
  "embeddingModels": {
    "<embed-id>": {
      "hf": { "repo": "…", "revision": "<sha>", "file": "….Q4_K_M.gguf" },
      "filename": "embed__<embed-id>__v1.gguf",
      "sha256": "…",
      "sizeBytes": 0,
      "minRamGb": 2,
      "contentRating": "filtered",
      "channels": ["play", "appstore", "sideload"],
      "status": "active"
    }
  },
  "knowledgePacks": {
    "<pack-id>": {
      "title": "Legal glossary",
      "hf": { "repo": "…", "revision": "<sha>", "file": "pack.jsonl" },
      "filename": "pack__<pack-id>__v1.jsonl",
      "sha256": "…",
      "sizeBytes": 0,
      "defaultMode": "keyword",
      "embeddingModelId": "<embed-id>",
      "maxChunks": 6,
      "maxCharsPerChunk": 800,
      "contentRating": "filtered",
      "channels": ["play", "appstore", "sideload"],
      "status": "active"
    }
  },
  "aiRooms": [
    {
      "id": "lawyer",
      "title": "Lawyer",
      "kind": "lora+knowledge",
      "adapterId": "lawyer",
      "packId": "<pack-id>",
      "systemPrompt": "…"
    }
  ]
}
```

`aiRooms.kind`: `lora` | `knowledge` | `lora+knowledge`.

## 7. Runtime (поверх llama-cpp-capacitor)

Уже есть в плагине: `embedding(text)`, `rerank(query, documents)`, `completion(messages)`.

Правила:
- chat-context и embedding-context **разделять** (отдельный `initLlama({ embedding: true })` или отдельная маленькая embedding-модель);
- в `completion` класть только строки чанков, не векторы;
- опционально `rerank` после top-N по косинусу;
- `stopCompletion` / OOM / thermal — те же, что в основном плане.

Индекс в Dexie (отдельные таблицы local-ai, не Matrix):

```ts
{ packId, chunkId, text, embedding?: Float32Array | number[], updatedAt }
```

## 8. UI

Переиспользуем вкладку **AI** / **All** и Settings → **Local AI** из основного плана:

- AI-комната с pack выглядит как обычный AI-чат;
- при первом входе — progress скачивания texts (± embedding), как у модели;
- в Local AI Settings: размер packs / embedding, удалить pack, пересобрать индекс;
- store/sideload фильтры те же (`contentRating` / channels / unfiltered-тогл).

## 9. Обновления packs

| Событие | Действие |
|---|---|
| Новый texts (тот же `packId`, новый filename/sha) | скачать → пересобрать индекс → старый файл удалить |
| Новый embedding GGUF | скачать → **переиндексировать все** packs, завязанные на этот `embeddingModelId` |
| Смена chat-base | LoRA снести; packs и embedding **не** трогать |
| Pack `withdrawn` | предложить удалить texts + индекс |
| Orphan cleanup | как в основном плане: registry + текущий манифест |

Манифест packs тоже **не копится**: `active` + кратко `deprecated`.

## 10. Фазы (после снятия блокера)

| Фаза | Объём | Выход |
|---|---|---|
| **R0** | Снять блокер: основной local-ai план реализован и проверен | можно стартовать |
| **R1** | Манифест packs + download texts + `stuff` в `lora+knowledge` | юрист+глоссарий работает на stuffing |
| **R2** | Chunking + `keyword` retrieve + лимиты `n_ctx` | большие packs без embedding |
| **R3** | Общая embedding-модель on-demand + индекс в Dexie + `embed` mode | semantic RAG |
| **R4** | Опц. `rerank`, Storage UI для packs, patch texts/embedding | полировка |

## 11. Риски

| Риск | Митигация |
|---|---|
| Не начать до готовности base/LoRA | жёсткий блокер на этот документ |
| `n_ctx` переполнен retrieved текстом | `maxChunks` / `maxCharsPerChunk`, приоритет history |
| Два GGUF в RAM (chat + embed) | не держать embedding-context постоянно; load → index/query → release |
| Размер download | texts отдельно от embedding; keyword без embedding |
| Store policies | те же `contentRating` / два манифеста |
| Галлюцинации «не из pack» | system: отвечать только по предоставленным фрагментам; цитировать chunk id |

## 12. Принятые решения

| Вопрос | Решение |
|---|---|
| Когда делать | **только после** основного local-ai плана |
| LoRA + knowledge | **да**, knowledge = расширение адаптера (`lora+knowledge`) |
| Что в промпте | **тексты** чанков / stuffing |
| Texts / embedding | **скачивать on-demand** (не в APK) |
| Embedding модель | **одна на приложение**, опциональна до phase R3 |
| Индекс | строить **на устройстве**, не тащить с HF по умолчанию |
| После смены chat-base | packs оставляем; LoRA удаляем |

## 13. Открытые вопросы

- Формат texts pack: jsonl чанков сразу или сырой markdown + клиентский chunker?
- Нужен ли `rerank` в MVP RAG или хватит cosine top-k?
- Максимальный размер одного pack (MB) и предупреждение в UI до скачивания?
- Может ли один pack шариться между несколькими AI-комнатами (да по умолчанию)?
