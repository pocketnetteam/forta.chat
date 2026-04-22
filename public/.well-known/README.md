# `.well-known/assetlinks.json`

Served at `https://forta.chat/.well-known/assetlinks.json`. Required by Android
App Links verification so that links like `https://forta.chat/invite?ref=...`
open the app directly instead of showing a chooser (or opening in Chrome).

## Как это работает у нас

Мы **не** используем Google Play — APK раздаётся через GitHub Releases, подпись
делается в CI из keystore, хранящегося как `ANDROID_KEYSTORE` в GitHub Secrets
(см. `.github/workflows/android-release.yml`).

Файл `assetlinks.json` в репозитории содержит **placeholder**
(`PLACEHOLDER_FILL_BEFORE_RELEASE:...`) — так production-fingerprint не попадает
в git history. Реальный fingerprint подставляется автоматически во время
FTP-деплоя (`.github/workflows/deploy.yml`) через
`scripts/inject-assetlinks-fingerprint.sh`:

1. Скрипт декодирует base64-keystore из `secrets.ANDROID_KEYSTORE`.
2. Извлекает `SHA256:` из вывода `keytool -list -v`.
3. Заменяет placeholder в `dist/.well-known/assetlinks.json` перед FTP upload.
4. Удаляет временный keystore.

Таким образом после `git push master` сайт раздаёт корректный
`assetlinks.json` без ручных действий.

## Требуемые GitHub Secrets

Уже существуют (используются в `android-release.yml`):

- `ANDROID_KEYSTORE` — base64-закодированный `.jks` файл
- `ANDROID_KEYSTORE_PASSWORD` — пароль keystore
- `ANDROID_KEY_ALIAS` — alias ключа

Дополнительных секретов не требуется.

## Проверка вручную (локально)

Если нужно узнать fingerprint без CI:

```bash
# Декодировать keystore из GitHub (через gh CLI нельзя — секреты write-only,
# достать может только владелец через UI Settings → Secrets).
# Либо взять keystore прямо с машины, на которой он создавался:

keytool -list -v \
  -keystore release-keystore.jks \
  -alias forta \
  -storepass "$ANDROID_KEYSTORE_PASSWORD" \
  | grep SHA256:
```

Взять полную colon-separated hex-строку после `SHA256:` — это то значение, что
CI подставляет на деплое.

## Проверка после деплоя

```bash
# 1. Файл должен отдаваться без placeholder:
curl https://forta.chat/.well-known/assetlinks.json

# 2. На устройстве проверить статус App Links verification:
adb shell pm get-app-links com.forta.chat
# Ожидаем: "forta.chat: verified"

# 3. Симулировать клик по ссылке:
adb shell am start -a android.intent.action.VIEW \
  -d "https://forta.chat/invite?ref=PSomeAddress1234567890ABCDEFGHIJKL"
# Должно открыть Forta Chat напрямую, без chooser-диалога.
```

Если в `pm get-app-links` стоит `unverified` — чаще всего проблема в том, что
домен ещё не раздаёт `assetlinks.json` (проверь FTP-деплой), либо SHA256 не
совпадает с сертификатом, которым подписан установленный APK.

## Когда обновлять вручную

Никогда — placeholder в репе перезаписывается в CI на каждый деплой. Если
keystore ротировался, достаточно обновить соответствующие GitHub Secrets и
запушить в master.

Если keystore навсегда потерян и нужно выпустить новый — Android сочтёт новую
подпись несовместимой, и пользователям придётся переустановить APK. В этом
случае достаточно обновить `ANDROID_KEYSTORE` в Secrets; repo и скрипт
инжекции менять не нужно.

## Поддержка нескольких сертификатов

Если нужно одновременно поддерживать debug и release fingerprint'ы (например,
для внутреннего тестирования), `sha256_cert_fingerprints` принимает массив:

```json
"sha256_cert_fingerprints": [
  "AA:BB:CC:...",
  "11:22:33:..."
]
```

Сейчас шаблон в репе рассчитан на один fingerprint. Если понадобится второй —
надо расширять `inject-assetlinks-fingerprint.sh` (второй секрет + второй
placeholder).
