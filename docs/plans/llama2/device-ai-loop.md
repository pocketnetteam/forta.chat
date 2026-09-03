# Rules — `local-ai` fix ⇄ real-device loop

How to iterate on `local-ai` (`C:\inetpub2026\localai`) bugs that only reproduce through the real
Capacitor/Android bridge, using Forta Chat as the live consumer app. Written 2026-08-19 after the
first real-device run since Phases 0.5/0.6/7.4 (`README.md`, `qa-checklist-phase7.md`) were left
"needs a device" — a phone was plugged in and two real bugs surfaced in the first five minutes, both
invisible to `local-ai`'s own `pnpm test` (see `decisions.md`'s "First real-device run" entry there).

## Why this loop exists

`local-ai` is consumed via a `file:` dependency (`forta.chat/package.json` →
`"local-ai": "file:../../inetpub2026/localai"`), which npm installs as a **symlink**
(`node_modules/local-ai` → `C:\inetpub2026\localai`). That means:

- `local-ai`'s own `npm run build` (tsup → `dist/`) is immediately visible to forta.chat — **no
  relink, no `npm install` needed** in forta.chat after a `local-ai` change.
- forta.chat's own build (`vite build` / `cap sync`) still needs to re-run to pick up the new
  `dist/` into the bundled web assets and the Android APK.

`local-ai`'s own testing rule (its `CLAUDE.md`) correctly keeps real-Capacitor-bridge behavior out of
`pnpm test` — but that means bugs specific to the real `@capacitor-community/sqlite` /
`llama-cpp-capacitor` / `@capgo/capacitor-downloader` native builds (as opposed to the Node
fakes/`node:sqlite` used in `test/unit`+`test/integration`) are **only findable this way**. Treat a
green `local-ai` `pnpm test` as "the design and Node-only logic are correct", not as "this works on a
phone" — same caveat the library's own README leads with.

## Prerequisites

- An Android device (or emulator) with USB debugging on, reachable via `adb devices`. Verify:
  `& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" devices -l` — must show one `device`
  line, not `unauthorized`/empty.
- `ANDROID_HOME`/`ANDROID_SDK_ROOT` or the default `%LOCALAPPDATA%\Android\Sdk` location must contain
  `platform-tools\adb.exe` — `scripts/find-adb.mjs` resolves it the same way
  `scripts/ensure-android-sdk.mjs` resolves the SDK dir.

## The loop

1. **Change `local-ai` source** (`C:\inetpub2026\localai\src\**`).
2. **Verify inside `local-ai` first** — cheap, fast, catches everything Node *can* catch before
   spending a device-install cycle on it:
   ```
   cd C:\inetpub2026\localai
   npm run lint && npm run typecheck && npm run test:unit && npm run test:integration
   npm run build
   ```
3. **Redeploy forta.chat to the device**: `cd C:\inetpub2025\forta.chat && npm run cap:run`. This:
   - `vite build`s forta.chat (picks up `local-ai`'s fresh `dist/` via the symlink),
   - `npx cap sync android`s the web assets + native plugins into `android/`,
   - installs the APK via `scripts/run-android-device.mjs` (see "Windows gradlew gotcha" below — this
     replaced a straight `npx cap run android`, which is broken on Windows),
   - launches the app and captures a 12s logcat window, flagging crash signals
     (`FATAL EXCEPTION`/`AndroidRuntime`) and anything matching a `local-ai`/`llama`/SQLite-related
     pattern (see `run-android-device.mjs`'s `AI_SIGNAL_PATTERNS`) — this is the closest thing to an
     automated test that exists for this integration right now (there is no real one; see "What
     'test' means here").
4. **Exercise the actual AI flow manually** (no UI automation harness in this repo) — either by hand
   on the device, or by driving `adb shell input tap`/`swipe` + `adb exec-out screencap -p` yourself
   (works fine as a scripted approximation; see "Driving the UI over adb" below). At minimum: open the
   sidebar's `AI` filter tab (last tab, scroll right — `getSidebarFabMode()`,
   `src/widgets/sidebar/model/sidebar-fab.ts`), open/create a chat, watch the model gate.
5. **Read the logs**:
   ```
   & "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" logcat -d -v time | Select-String "local-ai|llama|LocalAi|Sqlite|CreateConnection|transaction|Capacitor/Console"
   ```
   The full capture from step 3 is also saved to `forta.chat/logs/android-smoke-<ts>.log` (gitignored,
   `*.log`).
6. **Diagnose which repo owns the fix**:
   - Error shape is `[LocalAiClient]`/`Sending plugin error {"pluginId":"CapacitorSQLite"/"LlamaCpp"/
     "CapacitorDownloader"/"DeviceInfo", ...}`, or anything inside `src/adapters/capacitor/**` or
     `src/core/**` in `local-ai` → fix in **`local-ai`**. This is the common case — the whole point of
     this loop is exercising the native bridge `local-ai`'s own adapters wrap.
   - Error shape is `[ai-chat-store]`/`[local-ai-store]`/`[AiModelGate]` etc. (forta.chat's own
     `console.warn`/`console.error` prefixes, `src/entities/local-ai/**`,
     `src/entities/ai-chat/**`, `src/features/ai-chat/**`) → fix in **forta.chat**.
7. **Repeat from step 1.**

## Windows gradlew gotcha (already fixed, keep in mind if it resurfaces)

This machine has `NoDefaultCurrentDirectoryInExePath=1` set, so `cmd.exe` refuses to resolve a bare
relative `gradlew.bat` against the current directory — every Gradle-driven script must invoke
`.\gradlew.bat`, not `gradlew.bat`. `scripts/run-android-gradle.mjs` and
`scripts/run-android-device.mjs` both do this already. If a *new* script spawns Gradle directly and
hits `'gradlew.bat' is not recognized...`, this is why — copy the `.\\gradlew.bat` pattern from either
existing script rather than re-debugging it.

## Driving the UI: CDP (preferred) over adb-tap-and-screenshot

**Use `scripts/device-e2e/cdp-client.mjs` for anything beyond a single, trivial tap.** Every Capacitor
debug build exposes its WebView as a real debuggable Chromium target over a Unix socket
(`webview_devtools_remote_<pid>` — `adb shell cat /proc/net/unix | grep devtools`, pid from
`adb shell pidof com.forta.chat`). Forwarding that socket and talking Chrome DevTools Protocol over it
gives direct access to the actual DOM: `cdp.clickByText("Пауза")` fires the real Vue click handler
synchronously regardless of scroll position; `cdp.visibleTexts()` reads back what's actually rendered
as a flat string array, no OCR/screenshot-reading involved. This is categorically more reliable than
`adb shell input tap <x,y>` — a 2026-08-19 session spent a genuinely long time chasing what looked like
random flakiness (taps landing on a *different, stale* screen than the one just screenshotted) that
turned out to just be `input tap`'s physical-coordinate approach having no way to know whether the
screen it's tapping matches the screen it was aimed at. Switching that same verification over to
`cdp.clickByText(...)` navigation took a few minutes and produced deterministic, repeatable results on
the first try. `scripts/device-e2e/verify-local-ai-settings.mjs` is a working example: navigates
Settings → Local AI purely by clicking visible text, starts a download, pauses it, and asserts the
Delete/Discard button's visibility and label via `visibleTexts()` — zero screenshots.

Two things worth knowing before writing a new CDP script:
- **This app's tab/section state lives in a Pinia store (`useSidebarTab`), not the URL router** —
  `location.hash = '#/settings'` is a silent no-op. Navigate by clicking the actual bottom-nav/list
  items via `clickByText()`, the same way a real tap would.
- `fetch()`/`WebSocket` must target `127.0.0.1`, not `localhost` — `adb forward` binds IPv4 only, and
  Node's `fetch` resolving `localhost` to `::1` first produces a silent `ECONNREFUSED`. The CDP
  server's own `webSocketDebuggerUrl` also comes back with hostname `localhost` — rewrite it before
  connecting (`cdp-client.mjs` already does both).

Screenshots (`adb exec-out screencap -p`) and `adb shell input tap`/`swipe` still have a place —
visually confirming a genuinely visual thing (an icon, a color, a layout glitch you can't query from
the DOM) — but reach for CDP first for anything that's really "is X on screen" / "does tapping Y do Z".
Notes from when tap/screenshot is still the right tool:
- Screenshot pixel coordinates are the device's real resolution — if you're looking at a *displayed*
  (downscaled) copy of the PNG, multiply the coordinates you read off it by
  `real_width / displayed_width` before feeding them to `adb shell input tap`.
- Add a ~1s pause between a `swipe`/`tap` and the next action — the sidebar's tab strip and route
  transitions animate, and a `tap` fired mid-animation can land on the pre-animation layout instead
  of the one visible in your last screenshot.
- The AI filter tab is off the right edge of the tab strip by default — swipe it into view first
  (`input swipe 960 466 240 466 300` at 1080-wide portrait) before trying to tap it.

## What "test" means here

`scripts/run-android-device.mjs`'s post-launch logcat capture is a **crash/error-signal smoke check**
— confirms the app launches and native `local-ai` libraries load without throwing, nothing about
whether download/inference/streaming actually work end to end.

For the download/resume path specifically, there is now a real scripted device-e2e test:
`scripts/device-e2e/ai-download-resume.mjs` (built 2026-08-19, after hand-tapping through this exact
flow many times over one session made "write the automation" the obvious next move). It navigates by
finding UI elements through `uiautomator dump` (`scripts/device-e2e/ui-automator.mjs` — matches on
on-screen text/bounds, works against WebView content since Chromium exposes it through the
accessibility tree) rather than hardcoded pixel coordinates, which kept breaking whenever error text
shifted a button's position. It starts a real download, force-stops the app mid-download, relaunches,
and asserts the partial file actually grew from where it left off rather than restarting from 0 —
i.e. it's specifically a resume regression test, not just a smoke check. Usage:
```
node scripts/device-e2e/ai-download-resume.mjs [--kill-after-bytes=N]
```
Manual/emulator-only (real Capacitor bridge, real device) — never add this to `npm test`, same as
`qa-checklist-phase7.md`'s other items. It does NOT reset `local-ai`'s state between runs — if a
previous run exhausted `DownloadEngine`'s `maxAttempts` (5; every app-kill-during-download counts as
one attempt — a real gap, not fixed, see `decisions.md`'s "no real resume on Android" entry), clear it
first: `adb shell run-as com.forta.chat sh -c 'rm databases/local_ai_*SQLite.db* files/models/*.gguf'`
(this only clears `local-ai`'s own state, not the Matrix session — safe to run without re-logging in).

The rest of `qa-checklist-phase7.md` (inference/streaming/lifecycle) still has no automation — walk it
by hand, or by adb-driven taps per "Driving the UI over adb" above, after a change that touches those
paths.

## Known device flakiness: WebView renderer-sandbox stall → blank white screen on launch

Found 2026-08-19 while writing the script above (it kept failing at the very first boot-wait). The
Activity's native shell renders fine, but the WebView content stays pure white with **zero**
`Capacitor/Console` log lines — `uiautomator dump` shows no text nodes at all, confirming nothing
painted, not just a slow paint. Root cause, from `adb logcat`:
```
ActivityManager: Killing NNNNN:com.google.android.webview:sandboxed_process0...: isolated not needed
ActivityManager: Unable to launch app com.forta.chat/... for service ...SandboxedProcessService0:0: process is bad
```
followed by repeated `nativeloader(NNNNN): InitDefaultPublicLibraries...` every ~3s (a fresh PID each
time) until one attempt finally sticks — sometimes under 10s, sometimes over a minute. Android killed
Chromium's sandboxed renderer process (memory pressure) and then refuses to relaunch it for a stretch
("process is bad" = crash-loop backoff), so the WebView has no renderer to paint with until the
backoff clears. This is very likely what the user had already noticed intermittently ("иногда при
сборке белый экран при первом запуске... не знаю из-за чего") without a diagnosis — and rapid
force-stop/relaunch cycling (exactly what this device loop's own testing does, manual or scripted)
plausibly triggers/worsens it by keeping memory pressure and process churn high.

Not an app bug, nothing to fix in forta.chat/local-ai code — a device resource/backoff behavior.
`ai-download-resume.mjs`'s `waitForBoot()` tolerates it (one retry with a longer wait rather than
failing immediately); do the same in any new device-e2e script — a blank screen for the first 10-60s
after `am start` is not on its own evidence of a real crash, check for `FATAL EXCEPTION`/
`AndroidRuntime` specifically before concluding that.

## Real manifest is now live (was the hard blocker, resolved 2026-08-19)

`entities/local-ai/lib/create-client.ts`'s `MANIFEST_URL_PLACEHOLDER` now points at a real,
self-hosted manifest (`https://bastyon.com/local-ai-manifest.json`, CORS header added on the IIS
side) describing a real model (Qwen3-4B-GGUF Q4_K_M) — see `decisions.md` items 1/2 for the full
history. Not necessarily the final production URL — confirm with the product owner before a release
build. Download/`ensureModelReady()` is now exercisable end to end on a real device; `sendMessage()`/
streaming past that point is still unverified (needs the model to actually finish downloading once —
slow over the chunked `CapacitorRangeDownloadAdapter` transport, budget real time for it, see
`decisions.md`'s "no real resume on Android" entry for why a plain `DownloadManager`-based transport
wasn't kept instead).
