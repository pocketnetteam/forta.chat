# Звонки: передача работы — 2026-09-18

Документ для новой сессии: что сделано, где лежат результаты, как поднять стенд и что осталось. Начинать с него.

## Как начать новую сессию

Вставить в первое сообщение:

> Продолжаем работу по звонкам. Прочитай `docs/plans/2026-09-18-calls-handoff.md` — там состояние, стенд и список
> задач. Работаем в ветке `fix/calls-2026-09`. Начни с задачи «…» из раздела «Открытые задачи».

Всё, что ниже, дополняет `AGENTS.md`: правила сборки, тестов и ревью там.

## Состояние кода

- Ветка `fix/calls-2026-09`. Владелец запушил её 2026-09-21; что не запушено, показывает
  `git log origin/fix/calls-2026-09..HEAD`.
- Локальный `master` на 35 коммитов впереди `origin/master` — это та же работа по звонкам до ветки; `master` в ветку
  влит, отставаний нет.
- Проверки на последнем коммите: `npm run build`, `npm run test` (4388), Kotlin
  `:app:testSideloadDebugUnitTest --rerun-tasks` (586) — зелёные (2026-09-24).

## Где что лежит

- `docs/manual-verification.md` — все починки, которым нужна проверка на аппарате. Раздел «Ожидают проверки» (6
  записей) — открытые; «Проверено» — закрытые, с логами и замерами. У каждой записи шаги, «Раньше/Ожидается» и статус.
- `docs/call-bugs-needing-you.md` — отчёты пользователей по группам (B–H) и что по каждой группе нужно от владельца.
  Раздел E — итог по Bastyon.
- `docs/call-fix-checklist.md`, `docs/call-bug-reproduction-matrix.md` — исходный разбор отчётов (кластеры O01–O16).
- Память агента `~/.claude/projects/-Users-Alexandr-Sites-host-forta-chat/memory/` — по файлу на найденный дефект и на
  стенд; индекс `MEMORY.md` грузится в новую сессию сам. Главные: `forta-chat-samsung-bench.md` (стенд),
  `forta-chat-swipe-hangup-native.md`, `forta-chat-audio-stream-leak-freeze.md`,
  `forta-chat-native-webrtc-proxy-semantics.md`, `forta-chat-webview-page-freeze-during-calls.md`.
- Отчёты пользователей: публичный репозиторий `greenShirtMystery/forta-bugs` (открытые issues). `gh` с токеном
  j-bitmaker не работает; читать через `api.github.com` без авторизации.

## Стенд

Скрипты стенда живут во временной папке сессии (`scratchpad`) и **стираются ночной очисткой** — вместе с профилем
браузера, в котором выполнен вход. В новой сессии их придётся создать заново; их устройство описано в
`forta-chat-samsung-bench.md` и в записях `manual-verification.md` («Скрипт …»).

- **Samsung SM-A528B**, serial `R5CT316HB2T`, Android 14. Forta — с 2026-09-23 аккаунт **TEST2** (`test3232883282`,
  адрес `P8dNk3RL…`): сессию `Testtest11223344` стёр прогон E2E (`clearState` на первом попавшемся устройстве). Комната
  с TEST1 — `!KchsUDqhsdPwFUXfwd:matrix.pocketnet.app`, оба правила пушей на TEST2 встали, первый звонок TEST1 → TEST2
  прошёл (`bench-test2-1`: ответ, `select_answer … answered on this device`, отбой). Bastyon 1.8.124 на нём по-прежнему
  под `Testtest11223344` — для сценариев группы E Forta надо вернуть в тот же аккаунт (вход — владелец).
- **Pixel 9**, serial `57150DLAQ001B6`, Android 17. Forta — аккаунт `test1122334455667788`. Сейчас отключён.
- **Веб**: headless Chrome через Playwright (`channel: 'chrome'`) с постоянным профилем. Звонящий — TEST1
  (`test3823818`); третий аккаунт — `test23438111`. **Вход в веб делает владелец**: `web/open-login.mjs` открывает
  видимое окно forta.chat и ждёт `matrixReady`, ключ вводит человек. Профиль и `node_modules` живут в scratchpad
  **старой** сессии (`c0c9244b…/scratchpad/web/`); ночная очистка стирает файлы старше ~3 дней — 2026-09-23 она
  выбила и сессию, и Playwright (переустановлен `npm install playwright@1`), профиль восстановлен входом владельца.
- Звонящий ищет собеседника по имени в списке: для Samsung в TEST2 это `PEER_NAME=test3232883282`
  (`web/call-peer.mjs`); настройки стенда — `scratchpad/bench.env`.
- Общие комнаты: Samsung ↔ TEST1 `!XfcsFwyJkEXLRTnPzc:matrix.pocketnet.app`; Samsung ↔ Pixel
  `!YJTutyRoEKqcowPZRk:matrix.pocketnet.app`. Комнату открывать через `chatStore.setActiveRoom(id)` по CDP, а не
  кликом по имени: список Samsung имя Pixel не показывает.
- Управление телефоном — `adb` и CDP к WebView (`adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`,
  `phone-eval.mjs`). Кнопки нативного экрана звонка на Samsung — по `uiautomator dump` и id (`btn_accept`,
  `btn_decline`, `btn_hangup`); на Pixel uiautomator экран звонка не читает — нажимать по доле экрана.
- Подводные камни: пока телефон заблокирован, экран звонка лежит поверх блокировки и «Домой»/«Недавние» не работают;
  Pixel поворачивается горизонтально на столе; всплывающее уведомление Forta перекрывает карточку звонка Bastyon; на
  Mac может кончиться диск из-за подкачки при полном прогоне тестов (`npm run test -- --maxWorkers=4`).

## Принятые решения владельца

- Ускорение ответа на входящий (0,5–1 с) — вернуться после пересчёта отчётов («Б»).
- Смена сети Wi-Fi → LTE и повтор отправки при ней — не проверять, записи закрыты.
- Второй входящий во время разговора — оставить «занято», ожидания вызова не делать.
- Убитый процесс (`kill -9`) посреди разговора — собеседник ждёт ~35 с; оставить как есть.
- Правило пушей `select_answer` и старые сборки Android на том же аккаунте (рвут принятые звонки, пока не
  обновятся) — риск принят, выпускать одним релизом (2026-09-19).
- #809 п. 1 (уведомление Forta поверх карточки звонка Bastyon) — оставить как есть (2026-09-18).
- Три записи о push-путях с несравнимыми id закрыты как недостижимые на этом homeserver.

## iPhone — с чего продолжать (2026-09-23)

Состояние на конец сессии, чтобы не проверять заново. Читать вместе с памятью `forta-chat-ios-bench.md`.

**Аппарат.** iPhone XR (iPhone11,8), iOS 17.3.1, coredevice `8C0187A2-3F6F-5733-93F7-DF8B044FE947`, udid
`00008020-001104C43A88003A`, спарен, Developer Mode **включён** (проверять `xcrun devicectl device info details
--device <id>` — поле `developerModeStatus`; отвечает устройство, не память). Forta на нём не стоит. В Safari вошёл
TEST3 (`test23438111`). `libimobiledevice` на Mac стоит (`ideviceinfo`, `idevicesyslog` — фильтр `-m` без
альтернатив, писать сырой лог и grep'ать).

**Trek А (Safari, отчёты #538/#1276) — закрыт.** Звонок веб TEST1 → Safari: входящий показан, «Принять», микрофон,
звук в обе стороны, владелец слышал. Особенность: спящая вкладка Safari (≈3 мин без экрана) звонки не принимает.
Подробности — `docs/call-bugs-needing-you.md`, раздел «iPhone, веб-версия в Safari».

**Trek Б (нативная запись «iOS: метка получает возраст…») — не начат, до устройства не хватает только подписи.**
Днём 2026-09-23: стена 4 закрыта (plist на месте), сборка под **симулятор iPhone 16 проходит целиком** (`xcodebuild
-project ios/App/App.xcodeproj -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' build`, подписи не
надо), приложение стартует в симуляторе, Firebase Messaging поднимается. Попутно найден и исправлен дефект, который
ломал шаг «убить приложение → звонок → принять на CallKit» (`6f79bccc`): нативный VoIP-обработчик не сообщал CallKit о
звонке до `completion()` — запись «iOS: VoIP-push сообщает CallKit о звонке до `completion()`» в
`manual-verification.md`, проверяется только на XR. `xcrun simctl` / `devicectl` из песочницы Bash не работают
(CoreSimulator/CoreDevice XPC) — запускать вне её. Что сделано и что осталось, по порядку стен:
1. Xcode 16.4 стоит в `/Applications/Xcode.app` (15.4 → `/Applications/Xcode-15.4.app`), `xcode-select` на нём,
   лицензия принята, iOS 18.5 SDK скачан. Xcode 15.4 проект не собирает (SQLCipher.swift 4.14+ требует Swift 6).
2. Разрешение пакетов починено в репо (`74993ced`): `scripts/fix-ios-spm-products.mjs` после `cap sync ios`
   подставляет реальное имя продукта форка `llama-cpp-pro` (`LlamaCppCapacitor` вместо `LlamaCppPro`). Lock-файл
   пересобран Xcode 16.4 и закоммичен. Реальную ошибку SPM xcodebuild прячет — смотреть `swift package resolve` в
   `ios/App/CapApp-SPM` или `-verbose`.
3. ~~Форк не компилируется~~ — **закрыто 2026-09-23.** `LlamaCpp.swift:459` в `maxgithubprofile/llama-cpp-pro` звал
   `queryGpuInfo(nativeContextId)` без метки `contextId:` (Xcode 16.4 не собирает). По решению владельца сделан свой
   форк `j-bitmaker/llama-cpp-pro`: тег `v0.2.4-local-ai.2` = `v0.2.4-local-ai.1` + один коммит `70c9e217` с меткой
   (автор — `j-bitmaker`, как в forta.chat; ветка для PR в исходный форк — `fix/ios-query-gpu-info-label`);
   `package.json` и оба lock-файла указывают на него (коммит в этом репо — `chore(ios): take llama-cpp-pro…`).
   `npm install` теперь ставит рабочую копию, локальных правок в `node_modules` больше нет. Второй пакет с того же
   аккаунта, `local-ai`, не трогали.
4. ~~`GoogleService-Info.plist`~~ — **положен 2026-09-23** (`BUNDLE_ID` = `com.forta.chat`, `PROJECT_ID` =
   `forta-chat`, git игнорирует). Источник на будущее: 1Password «Forta» → `Forta iOS Firebase Config`; заглушку не
   класть — `FirebaseApp.configure()` в `AppDelegate` без условий.
5. ~~Нет сертификата подписи~~ — **закрыто вечером 2026-09-23, Forta 1.13.2 стоит на XR.** Что сработало:
   сертификат `Apple Development: Max Grishkov (9M84393HW3)` (до 5 авг 2027) экспортирован `.p12` из Keychain Access
   старого Mac Максима, импортирован в связку login здесь; Максим пригласил Apple ID владельца в команду через
   App Store Connect → Users and Access (роль Developer); после принятия приглашения
   `xcodebuild … -destination 'id=00008020-001104C43A88003A' -allowProvisioningUpdates
   -allowProvisioningDeviceRegistration build` сам зарегистрировал XR и выпустил `iOS Team Provisioning Profile:
   com.forta.chat` (до 2027-09-23); установка — `xcrun devicectl device install app --device 8C0187A2-… <App.app>`,
   запуск — `devicectl device process launch … com.forta.chat`. Ловушки: `find-identity -v -p codesigning` пишет
   «0 valid» из-за просроченного WWDR-корня 2023 г. в System keychain — реальная подпись работает (`codesign` даёт
   `TeamIdentifier=Y5JW9JU787`); `defaults read com.apple.dt.Xcode IDEProvisioningTeams` пуст, аккаунт Xcode 16 хранит
   в связке. Соглашение Apple Developer Program должен принять Daniel Satchkov **до 2026-10-02**, иначе выпуск
   профилей остановится. Ниже — старое описание стены:
   `security find-identity -v -p codesigning` → 0. Проект —
   автоподпись, Team `Y5JW9JU787`. Владельцу: Xcode → Settings → Accounts → «+» Apple ID → Manage Certificates →
   «+» Apple Development. Профили для App и двух расширений (NotificationService, ShareExtension) Xcode создаст при
   первой сборке на устройство.

**Вечер 2026-09-23, звонки на XR (8 входящих с веба TEST1 → TEST3 в Forta).** Найдено и исправлено:
`af8e3e5d` — четыре плагина таргета App не регистрировались в Capacitor 8 (`UNIMPLEMENTED`; микрофон не
запрашивался, принятый на CallKit звонок тут же отклонялся); категория аудиосессии теперь выставляется при загрузке и
`.mixWithOthers` (активация CallKit прерывала сессию WebKit GPU). После этого: CallKit показывает вызов, «Принять»
→ запрос микрофона → `m.call.answer` → ICE connected, звук с веба на iPhone идёт (70–80 КБ за 25 с).
**Открыто — микрофон iPhone молчит:** `[WebRTC-Diag] audio:0B/0pkt up` весь звонок, на вебе нет inbound-rtp.
Доказательство в `idevicesyslog`: `App(WebKit)[pid] … captureStateChanged … state was: 2048, is now: 0` и
`updateReportedMediaCaptureState: from 2048 to 8192` через 0,4 с после старта захвата (2048 =
HasActiveAudioCaptureDevice, 8192 = HasMutedAudioCaptureDevice), обратно не переходит до конца звонка. Не зависит от
нашей `setActive(true)` (проверено без неё, звонок 8), не совпадает с потерей видимости (RunningBoard:
`running-active-Visible`). В Safari на том же XR микрофон работал (трек А). Что проверять дальше, по порядку:
1. Исходящий звонок с iPhone (без CallKit): веб-автоответ `answer-loop.mjs` (RUN_S=150), владелец звонит `test3823818`
   из Forta. Если байты пойдут — виноват путь CallKit; попытка 2026-09-23 не состоялась (владелец не набрал).
2. В консоли приложения после `pushLocalFeed` вывести `track.muted / enabled / readyState` и повесить `onmute` на
   локальный трек — точное время и WebKit-причина мьюта (нужен `cap:build:ios`).
3. Настройки WKWebView через `MainViewController.webViewConfiguration(for:)` / `WKPreferences` — искать флаги про
   capture/visibility/interruption (перечисление `_experimentalFeatures`/`_internalDebugFeatures` на Mac).
4. Сравнить с Safari: там захват в том же WebKit GPU-процессе не мьютится.
**Ночь 24.09, что дал шаг 1:** исходящий звонок с iPhone (Forta открыта, CallKit не участвует) — **микрофон работает**,
веб получил 39 КБ за 27 с (`runs-ios10-answer.jsonl`). Значит захват WKWebView исправен, мьют — только на пути
ответа через CallKit. Попробован возврат захвата из нативного кода: `bridge?.webView?.setMicrophoneCaptureState(.active)`
из `IOSCallAudio.start()` с повторами 0/0,5/1,5/3/6 с — `microphoneCaptureState` был `.muted`, вызов прошёл и
дальше состояние читалось как активное, **но RTP по-прежнему 0 байт** (звонок 12, консоль `xr-console-6.log`). Код не
закоммичен (не помогает). Попутно: один звонок сорвался на `PUT m.call.answer` → `fetch failed: Load failed`
(сетевой процесс WebKit в момент переключения на экран вызова; SDK ответ не повторяет — отдельная задача);
`voipTokenReceived` в консоли ни разу не появился — VoIP-пуш и пробуждение свёрнутого приложения не проверены;
без открытого приложения входящий вызов до iPhone не доходит. Что дальше по микрофону, по порядку: (а) после
«Принять» на CallKit сразу открыть Forta (иконка на экране вызова) — если байты пойдут, WebKit ждёт активности
приложения, и лечить надо тем, чтобы CallKit-ответ выводил приложение на передний план; (б) в JS после
`pushLocalFeed` логировать `track.muted/enabled/readyState` и `onmute/onunmute`, и по `appStateChange → active`
делать `getUserMedia` заново + `sender.replaceTrack` — обходной путь, если (а) подтвердится; (в) сравнить
`WKPreferences` (`_experimentalFeatures`/`_internalDebugFeatures`, ключи про capture/visibility) — перечисление на Mac
через `swiftc` не собралось, доделать. `idevicesyslog` умирает вместе с обрывом соединения `devicectl` — проверять
`tail -1` файла перед каждым звонком и перезапускать.

**02:00 24.09 — уточнение, меняющее диагноз.** В звонках через CallKit владелец **не слышит и Mac**, хотя RTP с веба
приходит (91 КБ за 30 с в звонке 16), и Forta при этом была открыта (шаг (а) выше снят: видимость ни при чём). То есть
под CallKit **не работает ни воспроизведение, ни захват** в WebKit, а RTP и сигналинг живы; в исходящем звонке без
CallKit микрофон работал. Вывод: аудиосессия приложения, активированная CallKit с приоритетом PhoneCall, не даёт
работать отдельной сессии процесса WebKit GPU (он и играет, и пишет звук). Эксперимент на следующий раз, без
правки Swift: в `native-call-bridge.ios.ts` сразу после `answerCall` (или в `startAudioRouting`) вызвать
`IncomingCallKit.endCall({callId})` — CallKit отпустит сессию, разговор в WebRTC продолжится; если звук появится в
обе стороны — лечение в том, чтобы CallKit держал только экран вызова, а аудио отдавал WebKit (например,
`CXProviderConfiguration` без аудио/`reportCall(endedAt:)` после ответа, либо `didActivate` → `setActive(false)`).
Если не появится — искать в WebKit (`WKWebViewConfiguration`, ключи про audio session / capture). Проверять
`down`-байты **и** слышимость: RTP-счётчик здесь не показатель звука. На XR сейчас стоит сборка с
`setMicrophoneCaptureState` (не закоммичена, безвредна) — пересобрать из репо перед следующей серией.

**02:10 24.09 — РЕШЕНО, звук в обе стороны (звонок 19).** Эксперимент подтвердился: `native-call-bridge.ios.ts`
завершает CallKit-запись (`IncomingCallKit.endCall`, reason `audio-handoff`) в обработчике `callAccepted` **до**
передачи ответа в JS (до `getUserMedia`); `callEnded` с `source: "api"` для этого id глотается; `audio-watchdog`
игнорирует прерывание аудиосессии в первые 5 с после нашего отпускания (`isRecentCallKitRelease`). Отпускание
*после* ответа (звонок 17) не помогало. Замечание владельца: в части «глухих» звонков звук на iPhone мог быть просто
выключен переключателем — но 0 байт исходящего было объективно. CallKit теперь только рингер; открытые следствия —
шаги 2–4 записи «iOS: звук в обе стороны…» в `manual-verification.md` (блокировка экрана и сворачивание посреди
разговора, завершение с обеих сторон). Раздел выше (02:00) — история диагноза.

**02:50 24.09 — итог ночи и что осталось по iPhone.** Закрыто: запись «iOS: звук в обе стороны…» целиком (шаги 1–4,
звонки 19–21), «метка получает возраст» шаги 1–2 (звонки 22–23). Найден и исправлен пятый дефект (`1089e068`):
`push-service` звал Android-метод `PushData.isFcmAvailable()`, на iOS получал `UNIMPLEMENTED` и не регистрировал ни
APNs-, ни VoIP-пушер; теперь токен получен, два `POST /pushers/set` → 200. Холодный старт: отпускание CallKit
добавлено и в `getPendingAnswer` (тот же коммит), не проверено. **Всё оставшееся по iPhone упирается в сервер:** при
убитом приложении звонок не доставляет на XR ни одного пуша (лог `xr-syslog-3.log`, 02:46–02:50) — шлюз пушей
homeserver'а не настроен для `fortaios`/`fortaios.voip`. Действие владельца: отправить админам `matrix.pocketnet.app`
`docs/plans/ios/SYGNAL-CONFIG-REQUEST.md` и APNs-ключ (.p8) команды Dvm Analytics LLC (создаёт Admin на
developer.apple.com → Keys; хранить по `SECRETS-MANIFEST.md`). После настройки: записи «VoIP-push до `completion()`»,
«метка» шаг 3, холодный старт — одной серией (убить Forta → звонок → принять на CallKit; лог — `idevicesyslog`,
консоль после перезапуска пушем недоступна). Мелочь без сервера: `launchCallUI`/`dismissCallUI`/`closeAllPeerConnections`
зовутся из `call-service`/`finalize-call` напрямую в Android-плагин и на iOS шумят `UNIMPLEMENTED` (перехвачено,
безвредно) — обернуть в `isAndroid`. Pixel по-прежнему в TEST3 и звонит — отдельная задача владельца «Pixel звонит
после логаута».

**03:55 24.09 — VoIP-пуш: сервер обойдён, дефект найден, устройство в бане. План следующей сессии.**
Без админов: скрипт `scratchpad/apns-voip.mjs` (ES256-JWT по `.p8`, HTTP/2 в `api.sandbox.push.apple.com`, VoIP-класс,
topic `com.forta.chat.voip`, срок 90 с) шлёт пуш на VoIP-токен XR сам; `run-voip-test.sh` ставит звонок с веба, ждёт
`call_id` из `call-peer.mjs` (дописан: `{"ev":"call_id"}`) и шлёт пуш. Ключ `.p8` — у владельца (`~/Downloads`, удалить
после), Key ID/Team ID в `apns.env` (scratchpad, не в git). Результаты: пуш доходит (apsd → callservicesd → запуск
Forta 03:27:46 и 03:40:11), и оба раза iOS **убивает приложение через 0,5 с**: «Killing app because it never posted an
incoming call» — на холодном старте наш отчёт в CallKit не доходит до `callservicesd` (в 03:40 ни одного
`reportNewIncomingCall`). Плагин `@capgo/capacitor-incoming-call-kit` откладывал `reportNewIncomingCall` через
`DispatchQueue.main.async` — форк `j-bitmaker/capacitor-incoming-call-kit`, тег `8.2.1-forta.1` (inline на main thread,
`dist/` закоммичен для git-install), `package.json` на нём; это необходимо, но не хватило. После третьего прогона
`callservicesd`: «will not be launched because it failed to report an incoming call too many times… dropped on the
floor» — **XR в бане для VoIP-пробуждений**, переустановка не снимает. Заблокированный телефон обрывает `idevicesyslog`
— прогоны делать с разблокированным. Форк плагина как патч можно было бы держать через `patch-package` (есть в
`postinstall`) — форк оставлен.

План (по порядку):
1. Снять бан: удалить Forta с XR (не поверх), перезагрузить XR, поставить сборку, вход владельца (TEST3).
2. Прогон с диагностикой: в сборке `NSLog`-точки в `IOSVoIPPushPlugin` (`push received`, `no bridge`, `plugin not
   registered`, `no showIncomingCall:`, `performed`, `failed`) — читать `idevicesyslog` по `IOSVoIPPush`. Убить
   приложение можно без владельца (`xcrun devicectl device process launch/terminate`), вызов и пуш — `run-voip-test.sh`.
3. Вероятная причина и правильная архитектура (делать независимо от п. 2): на PushKit-старте отчёт нельзя вешать на
   Capacitor-мост — `PKPushRegistry` создавать в `AppDelegate.didFinishLaunching`, а отчёт делать через **публичный**
   метод форка (`IncomingCallKit.shared.reportIncomingCall(callId:callerName:roomId:hasVideo:)`, добавить в форк, тег
   `8.2.1-forta.2`), синхронно, до `completion()`. `IOSVoIPPushPlugin` оставить только для токена (реестр брать из
   AppDelegate). Каждая неудача = новый бан → п. 1 заново, поэтому сначала п. 3, потом прогон.
4. После успеха: записи «VoIP-push до `completion()`», «метка» шаг 3, холодный старт (`getPendingAnswer` отпускает
   CallKit) — одной серией; затем запрос админам (`SYGNAL-CONFIG-REQUEST.md`, Key ID/Team ID, `.p8` через 1Password).

**04:30 24.09 — п. 3 плана сделан, ждёт п. 1–2.** `ios/App/App/VoIPPushCoordinator.swift`: `PKPushRegistry` с
`didFinishLaunching`, отчёт синхронно через `IncomingCallKit.shared.reportIncomingCall` (форк `8.2.1-forta.2`, публичный
метод; `import IncomingCallKitPlugin` в таргете App компилируется), `NSLog`-точки `[VoIPPush] push received / reported
call / CallKit displayed|rejected`; `IOSVoIPPushPlugin` — тонкая JS-обёртка (`getToken`, события через
`retainUntilConsumed`, очередь до `load()`). Сборки под симулятор и XR зелёные, на XR **не установлено**: сначала владелец
удаляет Forta и перезагружает XR (снять бан), затем `devicectl device install app …`, вход TEST3, и прогон
`run-voip-test.sh` (убить приложение — `xcrun devicectl device process launch --terminate-existing` + terminate, без
владельца). Если снова «never posted» — читать `[VoIPPush]` в syslog: теперь видно, дошёл ли пуш до обработчика и что
ответил CallKit.

**14:08 24.09 — ЗАКРЫТО.** После удаления Forta + перезагрузки XR (бан снят) новая архитектура прошла четыре прогона до
экрана CallKit и один полный: пуш → запуск с нуля 0,3 с → CallKit → «Принять» → ответ на вебе через 5 с → звук в обе
стороны. Записи «VoIP-push до `completion()`», «метка» шаг 3 и холодный старт — проверены. Уроки: `SIGKILL` через
`devicectl` для «убить» подходит (`device process signal --signal SIGKILL`, pid из `device info processes`, в строке
процесса хвостовые пробелы); связь iPhone с APNs на этом Wi-Fi рвётся каждые ~25 с (`apsd: Connection closed`) — пуш
со сроком 55–90 с иногда не доходит, это сеть, не приложение; «Фокус» на XR включается сам по расписанию — проверять
перед серией. **По iPhone без сервера больше делать нечего.** Для продакшена: письмо админам по
`SYGNAL-CONFIG-REQUEST.md` (Key ID/Team ID, `.p8` через 1Password); PR из форков в Cap-go — по желанию.

Инструменты: консоль JS — `xcrun devicectl device process launch --console --terminate-existing --device <id>
com.forta.chat > файл &` (Capacitor выводит `⚡️ [log]`), системный лог — `idevicesyslog -u <udid> > файл &` (очень
шумный, grep по `App(WebKit)`, `audiomxd(MediaExperience)`, `callservicesd`). Режим «Не беспокоить» на XR должен
быть выключен — иначе `callservicesd` отбрасывает `reportNewIncomingCall` (`CallKit.error.incomingcall Code=3`).
Pixel вышел из TEST3 (2026-09-24).

Когда 5 будет: `npm run cap:build:ios`, затем сборка на XR
`xcodebuild -project ios/App/App.xcodeproj -scheme App -destination 'id=00008020-001104C43A88003A' -allowProvisioningUpdates build`
и установка `xcrun devicectl device install app --device <coredevice id> <путь .app>`. Вход в аккаунт на iPhone —
владелец (TEST3 свободен, если выйти из него в Safari; TEST1 — веб на Mac, TEST2 — Samsung). Шаги записи: звонок с
Samsung → отклонить на CallKit → через >60 с позвонить из той же комнаты → должен зазвонить; убить приложение → звонок →
принять на CallKit. Логи — `idevicesyslog`.

**Прочее.** На Pixel остался вход в TEST3 — выйти, иначе два клиента делят аккаунт. Стенд звонков: Samsung = TEST2
(`test3232883282`), веб-профиль TEST1 в scratchpad старой сессии `c0c9244b…/scratchpad/web/` (ночная очистка
убивает его раз в ~3 дня; вход через `open-login.mjs`, ключ вводит владелец; там же `call-peer.mjs`,
`reject-probe.mjs`, `probe-login.mjs`).

## Сессия 2026-09-24, день — хвосты после iPhone

- `b9fdc963` — `m.call.answer` повторяется при `ConnectionError` (3 отправки, паузы 0,5 и 1 с) в
  `voip-send-retry.ts`: на iPhone WebKit ронял PUT ответа (`fetch failed: Load failed`) и звонок умирал с
  `send_answer`. Проверено тестами; на устройстве сбой по заказу не воспроизводится.
- `e6e15a08` — выход из аккаунта останавливает пуши (Android): метка сессии в нативной части
  (`PushSessionPolicy`, FCM-сервис отбрасывает пуши после выхода), удаление пушеров `kind: null` и FCM-токена;
  запуск без сессии делает то же для установок, вышедших старой сборкой. Проверено на Pixel, запись
  «Выход из аккаунта останавливает пуши и звонки (Android)» в «Проверено». iOS (2026-09-25): метка сессии в
  `UserDefaults`; VoIP-пуш на вышедший аккаунт сообщается через отдельный `CXProvider` и сразу завершается
  (`SignedOutCallSink` в `VoIPPushCoordinator.swift`), проверено на XR — запись «iOS: VoIP-звонок на вышедший
  аккаунт…». Черновики PR из форков — `scratchpad/pr-drafts.md` сессии 3e75da45 (не опубликованы).
- `f1449c3e` — второй нестабильный тест `sync-engine-failed-room-status` ждёт `onChange` движка, а не только
  статус операции (гонка с `markMessageFailed`).
- Стенд: `idevicesyslog` без фильтра пишет ~25 МБ/мин — 2026-09-25 он заполнил диск Mac (7 ГБ старых логов удалены).
  Писать только через `| grep --line-buffered -E "\[VoIPPush\]|never posted|Killing app|…"`.
- `11199863` — `launchCallUI`/`dismissCallUI`/`closeAllPeerConnections` зовутся только на Android (на iOS плагина
  `NativeWebRTC` нет, было 3 `UNIMPLEMENTED` на звонок).
- `496d6a3a` — тест `sync-engine` «respects maxRetries» больше не ждёт реальный backoff (2,8 с → 30 мс).
- Пять iOS-записей `manual-verification.md` перенесены в «Проверено».
- **Для серии с Sygnal (задача после админов):** 2026-09-24 15:15 у TEST3 на сервере не было iOS-пушеров XR
  (`fortaios`, `fortaios.voip`), хотя ночью оба `pushers/set` вернули 200. Вероятно, Synapse удалил их после
  отказа шлюза (app_id не настроен). После настройки Sygnal — перезапустить Forta на XR (регистрация заново) и
  проверить `getPushers()` перед звонками.
- Стенд: Pixel — новая сборка, **вышел из TEST3** (пушера на сервере нет); TEST3 теперь только у XR.
  CDP к Pixel: `adb forward tcp:9224 localabstract:webview_devtools_remote_<pid>`; клиент Matrix со страницы
  доступен только во время звонка (`$pinia._s` → store `call` → `matrixCall.client`); страница в фоне заморожена и
  на CDP не отвечает.

## Сессия 2026-09-26 — работа без владельца

- `a2fa1eeb` — клиент Matrix следит за прокси Tor весь сеанс (`syncMatrixTorProxy`): включение/выключение Tor в
  настройках доходит до него без перезапуска. Проверено на Samsung (`Matrix proxy applied` / `cleared`).
- `96ed405d` — прогресс отправки файлов без Tor: загрузка с прогрессом идёт через XMLHttpRequest; на Android и в
  Electron страница помечает прямую загрузку `forta_direct=1`, service worker отдаёт её сети статическим маршрутом
  (Chromium 123+; без маршрута событий прогресса нет вовсе). Проверено на Samsung (20 МБ, 5 → 100 %). На iOS
  загрузки тоже идут через XHR (service worker'а там нет) — на XR не проверено.
- `888317bd` — `docs/plans/TURN-443-REQUEST.md`: просьба к админам homeserver'а о TURN по TLS на 443.
- `dbed4bb4` — **#1388**: Настройки → Уведомления → «Входящие звонки». Выключено — Forta не звонит и не отклоняет
  (Bastyon и другие устройства звонят). JS, FCM-сервис (`IncomingCallsStore`) и PushKit (сообщить и завершить).
  Android проверен (живое и убитое приложение); iOS компилируется, проверка на XR ждёт подключения.
- `a4276c7c` — **#1091**: у карточки звонка меню «Удалить» (долгое нажатие / правый клик); удаляются все события
  звонка, «у всех» — только свои; удалённая карточка не рисуется. Проверено на Samsung по CDP.
- Упёрлось: таймаут 120 с обратного прокси Tor зашит в `libreverseproxy.so` (Go, исходник у разработчика pocketnet,
  флагов таймаута нет) — нужен исходник или новая сборка. Бинарник Tor — выбор источника за владельцем.
- Стенд: Samsung заблокирован (PIN) — страница в фоне замерзает через ~1 мин, CDP отвечает только сразу после
  запуска приложения (`monkey`). Для FCM-проверок убивать процесс `run-as com.forta.chat kill <pid>`, не
  `am force-stop` (после него FCM не будит приложение). Звонок с веба TEST1: `.bench/web/call-out.mjs`
  (профиль `test1-prod`, прод forta.chat, фейковый микрофон).

## 2026-09-29 — клавиатура и меню (отзыв разработчика)

- **Регрессия клавиатуры — моя, `fb0e6650` (09-03).** Удалённый как «неиспользуемый» `@capacitor-community/safe-area`
  нативно отступал окно на высоту клавиатуры (edge-to-edge, `adjustResize` не работает). Без него клавиатура
  закрывала поле ввода. `9b140e0f` (отступ в `MainActivity`) отменён после слияния upstream: там та же регрессия
  уже закрыта CSS-правкой `de40a1c0` (pocketnetteam/forta.chat#252), вместе они поднимали бы поле дважды. A/B на Samsung с базовой
  сборкой 66ae28ce (отдельный пакет `.baseline`, собран из `git archive` в scratchpad): высота WebView с
  клавиатурой 446 / 800 (до правки) / 446 (после). Прочие сентябрьские кандидаты (флаги экрана блокировки
  `d606afdc`, пересоздание Activity `ec716f7c`) к этому не причастны: воспроизводилось без звонков.
- **Меню «не до конца» — старое (с марта).** `BottomSheet` хранил смещение после закрытия свайпом;
  `07ab342c` сбрасывает его при открытии, добавляет `touchcancel` и не тянет лист при прокрученном списке.
- `769edd35` (подпись к фото, только iOS) заменён при слиянии вариантом upstream (`--app-bottom-inset` для всех).
- Не проверено: iOS (клавиатура на XR требует нажатия владельца), ответ на звонок с экрана блокировки с
  последующей клавиатурой (нужен PIN).

## Открытые задачи

### Нужно решение владельца

1. **#809 п. 2 — Forta звонит, пока человек уже говорит в Bastyon.** Владелец выбрал вариант А (2026-09-18), сделано:
   правило пушей `com.forta.call.select_answer` + `SelectAnswerPolicy`. Шлюз пушей `selected_party_id` не передаёт
   (`saprobe3`), поэтому «кто ответил» решается по слоту Telecom, бэкенд не нужен. Ответ на этом же телефоне проверен
   (`sahere1`), ответ в Bastyon — тоже (`ownerb3`: рингер Forta снят через 28 мс после пуша); счётчик в списке чатов после такого звонка — 1, только приглашение
   (`ownerb4`). Всё проверено — запись «Forta перестаёт звонить, когда
   на звонок ответили на другом устройстве» в `manual-verification.md`. Риск для релиза: старая сборка Android на том
   же аккаунте примет этот пуш за отбой и будет рвать принятые звонки.
2. **#809 п. 1 — уведомление Forta перекрывает карточку звонка Bastyon.** Решение владельца 2026-09-18: оставить как
   есть, известная особенность. Владелец сам наткнулся на неё в `ownerb1` (ответил в Forta вместо Bastyon).
3. **#1091** — удаление записей о звонках: сделано 2026-09-26 (`a4276c7c`), вариант «все события звонка, у всех —
   только свои». Владелец может пересмотреть.

### Можно делать без владельца

4. **«Поздний stop прошлого звонка не гасит следующий»** (`706e8f96`) — проверено 2026-09-18 (`redial2`–`redial6`).
   На живой странице гонка на Samsung недостижима, поэтому её внедряли задержкой `dismissCallUI` по CDP; защита
   сработала, попутно найден и починен остаток — поздний `dismissCallUI` закрывал экран нового звонка.
5. **Передача файлов через Tor** — починено и проверено 2026-09-19: плагин ходил к прокси через `CONNECT`, а
   отправка больших файлов падала на `No access token` ещё до плагина. Запись «Файлы отправляются и скачиваются при
   включённом Tor (Android)» в `manual-verification.md`. Индикатор отправки (100 % сразу) починен `670dbb1b`
   (2026-09-21). 2026-09-25: Tor, включённый без перезапуска, теперь шлёт файлы через TorFile (`1c01a29d`), а пузырь
   показывает прогресс — `v-memo` строки сообщения не знал про `uploadProgress` и `content` (`f248a621`; тот же
   дефект держал на экране «[encrypted]» у сообщения, расшифрованного после первого показа — гипотеза к жалобам
   «приходят зашифрованные»). Без Tor прогресс починен 2026-09-26 (`96ed405d`). Остаётся таймаут обратного прокси
   120 с (HTTP 502 на медленных загрузках через Tor) — зашит в `libreverseproxy.so`.

### Нужен владелец, устройства есть

6. **Samsung с PIN** — ответ на заблокированном телефоне и после смахивания проверен 2026-09-21 (`lockA1`, `lockB1`).
   Строка `REVOKED` («Full-screen intent…», шаг 2): плагин при выключенном разрешении отдаёт `allowed:false`, но
   отправить настоящий отчёт из локальной сборки нельзя — `VITE_BUG_REPORT_TOKEN` есть только в секретах CI. Остаток
   закрывается вместе с п. 8 сборкой из CI.
7. **AirPods** — сессия 2026-09-22 (`air2`–`air4`): ответ с ножки, «Динамик» ↔ AirPods и осиротевший слот прошли;
   завершение с ножки на связке AirPods + Samsung не доходит до Android (гудки отказа гарнитуры), закрыто как
   недостижимое.
8. **Отправка настоящего отчёта о баге — нужна сборка из CI** (`android-test-apk.yml` на ветке или релиз): «Таймлайн
   аудио доезжает в реальном отчёте», строка `Tor` и шаг 1 «Фактов ICE и Tor в отчёте», строка `REVOKED` из п. 6 и
   новый раздел «Encryption diagnostics».
9. **TURN на 443 по TLS** — настройка сервера; шаг 3 «Фактов ICE и Tor».
10. **Пуш и релиз.** Запушить незапушенные коммиты ветки, выпустить сборку, через неделю пересчитать отчёты о звонках
    (`scripts/triage-call-reports.mjs`, см. `forta-chat-call-report-coverage.md`). После релиза — «Пустые каналы
    уведомлений не возвращаются после обновления» (пара «старый релиз → релиз из CI»).
11. **E2E** — закрыто 2026-09-23: 4/4 однодевайсных сценария на Pixel 9 (`docs/call-bugs-needing-you.md`, раздел H).
    Запускать с `DEVICE=<serial>`: без него скрипт берёт первое устройство и стирает на нём сессию (`clearState`).

### Нужны другие устройства или сеть

12. **Xiaomi, Honor или realme:** «Разговор переживает завершение предыдущего звонка» и 49 отчётов группы B.
    Разбор 2026-09-24 в `docs/call-bugs-needing-you.md` («Вендорское или общее для Android»): гонка `onDestroy`
    закрыта на Samsung; вендорскими остаются privacy shield MIUI, эхо Infinix, «принять» на оболочках и автозапуск.
    Покупать после пересчёта отчётов (п. 10), не раньше.
13. **Телефон с жалобой на звук:** «Переключатель движка WebRTC меняет поведение».
14. **Сеть, где блокируют Tor:** snowflake проверен 2026-09-21 (сеть стенда в тот день блокировала прямой Tor);
    obfs4 из приложения не выбрать. Бинарник Tor предупреждает, что версия устарела.
15. **iPhone** — 2026-09-23 подключён iPhone XR (iOS 17.3.1, Developer Mode по данным `devicectl` выключен). Два трека:
    - трек А, Safari — **пройден 2026-09-23**: на iOS 17.3.1 входящий показывается, «Принять» работает, микрофон
      выдаётся, звук в обе стороны (#538/#1276 не воспроизводятся; подробности в `call-bugs-needing-you.md`).
      Найденная особенность: спящая вкладка Safari звонки не принимает (JS усыплён, sync стоит);
    - трек Б, нативная запись «iOS: метка получает возраст…» — нужна сборка на устройство. **Xcode 15.4 проект не
      собирает**: `@capacitor-community/sqlite` 8.1.1 тянет `SQLCipher.swift` 4.14+, а все его теги 4.14.0–4.19.0
      требуют `swift-tools-version: 6.0` (Swift 5.10 в 15.4 их не читает); пин не поможет. Нужен **Xcode 16+**, как и
      сказано в `docs/ios-local-build.md`. `libimobiledevice` на Mac поставлен (`idevicesyslog`).
      **Дальше 2026-09-23:** владелец поставил Xcode 16.4 (`/Applications/Xcode.app`, 15.4 → `Xcode-15.4.app`,
      `xcode-select` переключён), iOS 18.5 SDK скачан (`xcodebuild -downloadPlatform iOS`, Apple ID не нужен). Вторая
      стена — форк `llama-cpp-pro` объявляет продукт `LlamaCppCapacitor`, а `cap sync ios` просит `LlamaCppPro`;
      починено `74993ced` (`scripts/fix-ios-spm-products.mjs` после sync). Разрешение пакетов проходит. Для сборки на
      XR не хватает только сертификата подписи (Apple ID → Manage Certificates); Developer Mode на XR включён.
16. **Не-Samsung телефон со старой установкой:** «В „Аккаунтах вызовов“ значится Forta Chat» (Samsung такие
    аккаунты скрывает; нужно обновление поверх старой версии — после релиза).

### Низкая ценность

17. **«Зависший звонок отпускается при возврате»** — закрыто решением владельца 2026-09-21.
18. **Обновить бинарник Tor (плановая, без срока).** `libtor.so` пишет `This version of Tor will eventually stop
    working`: когда сеть сделает недостающий протокол обязательным, встроенный Tor перестанет подключаться у всех.
    Пересобрать под четыре ABI и заново проверить snowflake.

## Найдено и починено в этой сессии (для справки)

Подробности и замеры — в «Проверено» `docs/manual-verification.md`.

- Утечка `AudioContext` замораживала звонки дольше минуты и теряла отбой (`e137334a`).
- Прокси нативного WebRTC: кандидаты в ответе и откат при встречном перезапуске ICE (`6b1b88cc`, `c2ed5f98`).
- Отбой из нативной части при смахивании посреди разговора, через Tor — как весь трафик приложения (`696470e2`,
  `6c459594`, `5dbad8be`); плюс правки другой сессии `e24045ae` (только HTTPS для адреса сервера).
- Повторный звонок после отмены звонящим и после отклонения по таймауту (`e059cc1e`, `ffeb0a46`).
- Размер видео в веб-версии (#936, `a549d635`), повторная регистрация плагина Tor каждые 2 с (`fb151495`).
