# Исследование проблемы клавиатуры в Forta Chat и рекомендации по исправлению

## Обзор

В Forta Chat проблема клавиатуры на мобильных устройствах проявляется в двух основных симптомах: поле ввода иногда перекрывается клавиатурой, а некоторые поля и контейнеры сдвигаются слишком сильно или дёргаются при открытии клавиатуры.[cite:1] В приложении уже реализована собственная архитектура управления клавиатурой через `windowSoftInputMode="adjustNothing"`, `WindowInsetsCompat`, CSS-переменные и `safe-bottom` layout, что означает, что система сознательно не должна автоматически ресайзить WebView.[cite:1]

На основании анализа текущей архитектуры и внешней документации, безопасная стратегия заключается не в замене существующего подхода на `@capacitor/keyboard` или `VirtualKeyboard API`, а в стабилизации текущего контура, снижении числа конкурирующих источников keyboard-height и добавлении новых API только как вторичных сигналов или feature-detected enhancement.[cite:1][cite:69][cite:73]

## Текущее устройство проблемы

Согласно внутреннему описанию архитектуры, Android-часть Forta Chat использует `adjustNothing`, edge-to-edge режим и ручной расчёт высоты клавиатуры через `WindowInsetsCompat.Type.ime()`, затем пробрасывает значение в WebView через CSS-переменную `--native-keyboard-height` и событие `native-keyboard-change`.[cite:1] На JS-уровне `App.vue` объединяет два источника: нативное событие как основной источник и `visualViewport` как fallback, а итоговая высота записывается в `--keyboardheight`, после чего `safe-bottom` поднимает контент над клавиатурой.[cite:1]

Собственный документ Forta Chat уже перечисляет вероятные причины сбоев: некорректные IME insets на OEM-прошивках, отсутствие или нестабильность `visualViewport`, race condition между нативной инъекцией и рендером WebView, двухфазная высота клавиатуры у Samsung/SwiftKey и конфликт между несколькими параллельными источниками обновления высоты.[cite:1] Это же объясняет жалобы на “двойной сдвиг”, дёрганье и скрытую строку ввода.[cite:1]

## Что показывают внешние источники

Документация Capacitor Keyboard подтверждает, что плагин даёт события `keyboardWillShow`, `keyboardDidShow`, `keyboardWillHide`, `keyboardDidHide` и отдаёт `keyboardHeight` в событии показа клавиатуры, что делает его полезным как дополнительный событийный слой.[cite:69] Но методы `setResizeMode()` и `getResizeMode()` поддерживаются только на iOS, а Android-опция `resizeOnFullScreen` описана как workaround для случая, когда WebView не ресайзится при fullscreen-режиме с включённым StatusBar overlay, а не как универсальная модель управления клавиатурой для архитектур с ручным layout-контролем.[cite:69]

Документация MDN по VirtualKeyboard API показывает, что API позволяет слушать `geometrychange`, читать `boundingRect` клавиатуры и включать `overlaysContent`, чтобы браузер не менял viewport автоматически.[cite:73] Но MDN также прямо помечает VirtualKeyboard API как experimental и not Baseline, то есть API недоступен во всех широко используемых браузерах и средах исполнения.[cite:73] Дополнительные публичные обсуждения подтверждают, что `geometrychange` может не срабатывать в части Android Chromium-based браузеров, поэтому строить на нём единственный браузерный keyboard-pipeline рискованно.[cite:76][cite:79]

## Оценка идеи: `@capacitor/keyboard` для Android + `navigator.virtualKeyboard.geometrychange` для браузера

Эта идея выглядит привлекательной, потому что упрощает количество технологий на бумаге, но на практике она создаёт новые риски для вашей архитектуры.[cite:1][cite:69][cite:73] Для Android `@capacitor/keyboard` не является полноценной заменой уже существующей `WindowInsetsCompat`-логики, поскольку его resize-механика не является главным Android API в документации, а ваш layout уже завязан на ручной `safe-bottom` pipeline.[cite:1][cite:69] Если использовать плагин как основной источник layout-поведения, можно снова получить конфликт между системным resize и собственным padding-based repositioning.[cite:1]

Для браузера опора только на `navigator.virtualKeyboard.geometrychange` ещё более рискованна, потому что API экспериментален и не обеспечивает достаточной предсказуемости во всех WebView и мобильных браузерах.[cite:73][cite:76][cite:79] Поэтому связка “Capacitor plugin only on Android + VirtualKeyboard only in browser” не выглядит надёжной базовой архитектурой для production-fix в текущем состоянии платформенной поддержки.[cite:69][cite:73]

## Рекомендованная стратегия исправления

### Оставить основной архитектурный принцип

Основной принцип `adjustNothing + WindowInsetsCompat + CSS safe-bottom` следует сохранить, потому что он уже встроен в Forta Chat и согласован с текущим flex-layout чата, `MessageInput`, `ChatVirtualScroller` и остальными контейнерами.[cite:1] Переход на `adjustResize` или попытка отдать управление системному resize противоречат текущей архитектуре и могут заново вызвать именно те эффекты, с которыми приложение уже столкнулось.[cite:1]

### Снизить число конкурирующих источников

Нужно жёстко определить приоритет источников keyboard-height и перестать смешивать их без координации.[cite:1] Рекомендуемый порядок такой:

- Android native: `WindowInsetsCompat` — единственный authoritative source.[cite:1]
- Android JS fallback/telemetry: `@capacitor/keyboard` — только как дополнительный событийный канал, без передачи ему управления resize/layout.[cite:69]
- Web enhancement: `navigator.virtualKeyboard.geometrychange` — только при наличии API и успешной проверке поведения.[cite:73][cite:79]
- Web baseline fallback: `visualViewport resize/scroll` — как текущий универсальный fallback.[cite:1]

### Убрать "double shift"

Проблема “двойного сдвига” вероятнее всего возникает из-за комбинации нескольких факторов: одновременные native/web updates, глобальный `focusin → scrollIntoView`, а на части Chromium/WebView-конфигураций — потенциальное изменение viewport браузером параллельно с вашим собственным `safe-bottom` layout.[cite:1] Из предыдущего анализа моделей следует, что безопасный план — ввести native-priority lock/debounce в JS, чтобы после нативного события короткое время игнорировать web-derived keyboard updates, а также сделать `scrollIntoView` условным: прокручивать элемент только если он реально перекрыт, а не всегда при `focusin`.[cite:1]

Если на проблемных Android/WebView действительно присутствует системное вмешательство в viewport, дополнительным кандидатом на controlled experiment является `interactive-widget=overlays-content` для native WebView-сценария, чтобы контент не менялся автоматически и весь keyboard-avoidance оставался под вашим контролем.[cite:73] Этот шаг должен внедряться отдельно, под фиче-флагом и после базовой стабилизации событийного пайплайна.[cite:73]

### Разделить источники safe-area и keyboard vars

В текущем CSS есть fallback через `env(safe-area-inset-*)`, а в native-режиме реальные значения также инжектятся из `MainActivity.kt`.[cite:1] Чтобы избежать перезаписи и неясного приоритета, полезно разделить переменные по происхождению, например `--native-safe-area-inset-bottom` и `--env-safe-area-inset-bottom`, а в util-классах брать итог через `max()` или заранее нормализованную итоговую переменную.[cite:1] Это уменьшит риск того, что браузерный fallback случайно “победит” реальное нативное значение на отдельных устройствах.[cite:1]

### Добавить диагностику до фикса

Перед изменением поведения полезно включить временное логирование на проблемных устройствах: `ime.bottom`, `insetBottom`, вычисленный `keyboardHeight`, приход `native-keyboard-change`, `visualViewport.height`, `visualViewport.offsetTop`, факт вызова `scrollIntoView`, и итоговый `--keyboardheight` в DOM.[cite:1] Без такой диагностики легко спутать OEM-баг insets, race condition и лишний JS-scroll.[cite:1]

## Конкретные рекомендации по внедрению

| Область | Рекомендация | Зачем |
|---|---|---|
| `MainActivity.kt` | Оставить `adjustNothing`; сохранить `WindowInsetsCompat` как основной источник; добавить более подробное debug-логирование под флагом | Не ломает текущую архитектуру и помогает изолировать OEM-проблемы.[cite:1] |
| `App.vue` | Ввести source-priority: native > virtualKeyboard > visualViewport; добавить короткий lock/debounce после native update | Уменьшает дёрганье и race condition между источниками.[cite:1][cite:73] |
| `App.vue` | Переписать глобальный `focusin` так, чтобы `scrollIntoView` происходил только при реальном перекрытии поля | Убирает лишний second shift поверх `safe-bottom`.[cite:1] |
| `keyboard-height.ts` | Добавить единый нормализатор источников и журналирование причины выбора значения | Делает поведение трассируемым и предсказуемым.[cite:1] |
| Browser path | Оставить `visualViewport` как fallback; `VirtualKeyboard API` включать только через feature detection | Снижает риск сломать браузеры/старые WebView.[cite:73][cite:79] |
| Android path | Подключить `@capacitor/keyboard` только как вспомогательный канал | Получаете полезные keyboard events без смены архитектуры.[cite:69] |

## Что не рекомендуется

Не рекомендуется полностью переходить на `@capacitor/keyboard` как основной Android keyboard manager, потому что это не даёт доказанного преимущества по сравнению с уже существующей `WindowInsetsCompat`-схемой, а риск конфликтов остаётся.[cite:69][cite:1] Не рекомендуется также удалять `visualViewport` и полагаться только на `navigator.virtualKeyboard.geometrychange`, поскольку поддержка API недостаточно широка и стабильна для production-only решения.[cite:73][cite:76][cite:79]

Не рекомендуется одновременно включать несколько resize-механизмов без жёсткой координации приоритетов, потому что текущая проблема уже содержит признаки именно такого конфликта.[cite:1] Не рекомендуется пытаться “починить всё сразу” большим рефакторингом без device-level instrumentation и без staged rollout.[cite:1]

## Приоритетный план действий

1. Сначала добавить диагностическое логирование и воспроизводимый test-matrix по устройствам/клавиатурам.[cite:1]
2. Затем стабилизировать JS-агрегацию keyboard-height: native-priority, debounce, condition-based scrollIntoView.[cite:1]
3. После этого добавить `@capacitor/keyboard` только как дополнительный источник событий для Android debugging/fallback.[cite:69]
4. Затем добавить `VirtualKeyboard API` как browser enhancement под feature detection, не удаляя `visualViewport`.[cite:73]
5. И только если останутся device-specific double-shift кейсы — тестировать `interactive-widget=overlays-content` или аналогичное отключение системного viewport-resize поведения под фиче-флагом.[cite:73]

## Практический итог

Наиболее надёжный путь для Forta Chat — не заменять текущую keyboard-архитектуру, а дисциплинировать её: один основной источник истины на Android, browser enhancement без жёсткой зависимости от experimental API, меньше параллельных resize/update путей и больше управляемой диагностики.[cite:1][cite:69][cite:73] Такой подход лучше соответствует уже существующему устройству приложения и снижает риск того, что исправление клавиатуры сломает другие layout-сценарии в чате, авторизации и вспомогательных экранах.[cite:1]
