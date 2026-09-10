# Анализ логов WebRTC: Mobile ↔ Mac

## Исходные данные

| Сценарий | Файл | Результат |
|----------|------|-----------|
| Мобилка → Мак (входящий на Мак) | `webrtc-mob-2-mac-success.log` | **Успех** (голос слышен) |
| Мобилка → Мак (входящий на Мак) | `webrtc-mob-2-mac-fail.log` | **Фейл** (connecting → ended) |
| Мак → Мобилка (исходящий с Мака) | `webrtc-mac-2-mob-fail.yaml` | **Фейл** (ICE failed + impolite) |

---

## 1. Успех: Mobile → Mac (`webrtc-mob-2-mac-success.log`)

- На **Маке** приходит входящий звонок, пользователь принимает.
- Цепочка состояний: `ringing → wait_local_media → create_answer → connecting → **connected**`.
- ICE собирает 11 кандидатов, ответ (answer) уходит, соединение устанавливается.

**Вывод:** при звонке **с мобилки на Мак** канал (сигнализация + ICE) может успешно подниматься. Роль Мака — **answerer** (отвечающий).

---

## 2. Фейл: Mobile → Mac (`webrtc-mob-2-mac-fail.log`)

- Та же схема: входящий на Мак, ответ, `create_answer → connecting`.
- Дальше: **connecting → ended** без перехода в `connected`.
- В логе нет сообщений про ICE restart или «impolite» — только обрыв соединения.

**Вывод:** либо ICE не установился (NAT/сеть), либо одна из сторон завершила звонок (таймаут/отмена). Детали ICE на стороне Мака в этом логе не видны.

---

## 3. Фейл: Mac → Mobile (`webrtc-mac-2-mob-fail.yaml`) — ключевой кейс

На **Маке** инициируется исходящий звонок на мобилку (Мак — **caller**, offerer).

### Что видно в логе

1. **Обычный старт:**  
   `wait_local_media → create_offer → invite_sent → connecting`  
   Локальный поток пушится, оффер отправлен, удалённый поток получен (`pushRemoteFeed()`).

2. **Падение ICE:**  
   `onIceConnectionStateChanged() ICE restarting because of ICE disconnected, (state=disconnected, conn=failed)`  
   ICE не смог установить соединение (типично при двух NAT без TURN).

3. **ICE restart на Маке:**  
   SDK на Маке делает перезапуск ICE и шлёт новый оффер:  
   `onNegotiationNeeded() negotiation is needed!`  
   `gotLocalOffer() discarding 11 candidates that will be sent in offer`

4. **Коллизия переговоров:**  
   С мобилки приходит событие переговоров (renegotiate/answer), а на Маке:  
   `onNegotiateReceived() **ignoring colliding negotiate event because we're impolite**`  
   То есть сторона Мака в роли **impolite** и **игнорирует** входящий negotiate от мобилки.

5. **Итог:**  
   Состояние так и остаётся `connecting`, затем `connecting → ended`. Соединение не восстанавливается.

### Почему так происходит

- В WebRTC «perfect negotiation» одна сторона — **polite**, другая — **impolite** при коллизии офферов.
- **Impolite**: при коллизии отбрасывает входящий оффер и «побеждает».
- **Polite**: откатывается и уступает.
- У нас **caller = Mac = impolite**. После ICE restart Мак шлёт новый оффер; мобилка, скорее всего, шлёт ответ или свой вариант переговоров. SDK на Маке считает это коллизией и **игнорирует** сообщение от мобилки → переговоры расходятся, соединение не устанавливается.

---

## Итоговая картина

| Направление | Роль Мака | Результат | Причина |
|-------------|-----------|-----------|---------|
| Mobile → Mac | answerer (polite) | иногда ок, иногда фейл | При успехе ICE проходит. При фейле — либо ICE, либо таймаут без деталей в логе. |
| Mac → Mobile | offerer (impolite) | стабильный фейл | 1) ICE падает (NAT). 2) После ICE restart Mac игнорирует negotiate от мобилки → deadlock. |

То есть:

- **Асимметрия по ролям:** когда Мак звонит (offerer/impolite), после падения ICE его поведение «impolite» мешает принять ответ/переговоры от мобилки.
- **ICE:** при двух NAT (WiFi + 4G) без TURN первый ICE часто не поднимается; дальше срабатывает ICE restart и обнажается проблема с «impolite».

---

## Рекомендации

### 1. Включить/настроить TURN (приоритетно)

- Чтобы ICE реже падал при Mac ↔ Mobile (WiFi ↔ 4G).
- Проверить, что `matrix.pocketnet.app` в `.well-known` отдаёт TURN и что клиент реально использует эти креды (в логах уже есть «current turn creds expire in …» — значит, TURN в принципе запрашивается).
- При необходимости поднять свой TURN (coturn и т.п.) и прописать его в конфиге сервера/клиента.

### 2. Разобраться с «impolite» в matrix-js-sdk-bastyon

- Сейчас при **исходящем** звонке (Mac = caller) SDK ведёт себя как impolite и после ICE restart отбрасывает входящий negotiate.
- Нужно в репозитории **matrix-js-sdk-bastyon** найти место с текстом `ignoring colliding negotiate event because we're impolite` (или аналог в коде perfect negotiation).
- Варианты:
  - Сделать caller **polite** (если по спецификации так допустимо для 1:1 звонков), чтобы после restart он мог принять оффер/negotiate от callee.
  - Или доработать логику: при состоянии `failed`/`disconnected` не считать входящий negotiate «коллизией» и обрабатывать его вместо отбрасывания.
- Это изменение только в SDK (форк), не в Forta Chat.

### 3. Доп. логирование (по желанию)

- На стороне **мобилки** при сценарии Mac → Mobile логировать: приходит ли новый offer после ICE restart, шлётся ли answer/negotiate и не приходит ли затем hangup/ended.
- На **Маке** при том же сценарии уже видно: ICE failed → restart → ignore colliding negotiate → ended.

---

## Кратко

- **Успех только Mobile → Mac:** роль Мака (answerer/polite) не приводит к отбрасыванию переговоров после ICE restart.
- **Фейл Mac → Mobile:** ICE падает, Mac делает ICE restart и из-за роли **impolite** игнорирует ответ/negotiate от мобилки — соединение не восстанавливается.
- **Что делать:** настроить TURN и в matrix-js-sdk-bastyon изменить поведение при коллизии переговоров (сделать caller polite или не игнорировать negotiate после ICE failure).
