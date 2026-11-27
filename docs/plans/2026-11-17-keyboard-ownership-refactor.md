# Keyboard ownership refactor

> Status: code landed (phases 1–3). Device QA in `docs/manual-verification.md`.

## Goal

One soft-keyboard owner for Capacitor apps: programmatic focus/blur, autofocus
policy 1A, and CSS inset publishing — without reviving native content padding
alongside `--app-bottom-inset` (calls-fork lesson: `fb0e6650` → `bcb3d0e7`).

## Module

`src/shared/lib/keyboard/`:

| Export | Role |
|--------|------|
| `shouldAutofocus` | Policy 1A |
| `requestFocus` / `requestFocusNextTick` / `releaseFocus` | IME open/close |
| `installKeyboardDismiss` | iOS outside-tap blur |
| `useKeyboardInsets` | iOS CSS vars + Android VV cross-check |
| `useKeyboardHeight` / `useKeyboardVisible` | Height signal |

Legacy composables under `src/shared/lib/composables/use-*-keyboard*.ts` are thin
deprecated re-exports / no-ops.

## Policy 1A

On native or mobile viewport:

- No autofocus: Forward / GIF / ChatSearch / QuickSearch / Contacts search
- Autofocus OK: composer edit / reply / forward caption (after target chat), forms

Desktop keeps previous search autofocus.

## Inset contract

- Lift only via CSS `.safe-*` + `--app-bottom-inset`
- Android primary writer: `MainActivity.injectAllCssVars`
- Do not restore `KeyboardInsetPolicy` / `@capacitor-community/safe-area` pad
- `.pb-safe` remains keyboard-free (call chrome)

## Phases shipped

1. Facade + ForwardPicker / MessageInput / GifPicker
2. Modal `initialFocus` + ChatSearch / QuickSearch / forms / ContactsPanel
3. Docs + MainActivity comment + manual-verification entry
