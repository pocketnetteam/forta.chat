# Forta Chat — Mobile asset sources

This directory holds the **source-of-truth** PNGs that
[`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets) reads to
generate the per-platform asset catalogues (iOS `AppIcon.appiconset` /
`Splash.imageset`, future Android adaptive icon variants).

## Files

| File | Size | Used for |
|---|---|---|
| `icon-only.png`        | 1024×1024 | iOS `AppIcon` (App Store + device home screen). |
| `icon-foreground.png`  | 1024×1024 | iOS `AppIcon` (foreground layer for translucent platforms; reused for adaptive Android). Centred art, transparent edges. |
| `icon-background.png`  | 1024×1024 | Solid background colour layer (used by Android adaptive icons; iOS uses `icon-only.png` as the composited result). |
| `splash.png`           | 2732×2732 | iOS launch screen image (light appearance), centred art on solid background. |
| `splash-dark.png`      | 2732×2732 | iOS launch screen image (dark appearance). |

## Status: placeholder

The current files are **placeholders** generated programmatically by
`scripts/generate-ios-source-assets.mjs` from the existing
`public/forta-icon.png` (252×248) by upscaling. They are pixelated up close —
acceptable for the bootstrap simulator, **not** acceptable for App Store
submission.

**Replacement workflow when design delivers final art:**

1. Drop the four/five final PNGs (above) into this directory, overwriting
   the placeholders. Keep the same filenames and dimensions.
2. Run:

   ```bash
   npx capacitor-assets generate --ios
   ```

3. Commit the regenerated `ios/App/App/Assets.xcassets/**` and the new
   source PNGs with a `chore(ios): refresh app icon + splash assets`
   commit.

## Why are these source files in git?

`@capacitor/assets` is a generator: the iOS asset catalogue is a derived
artefact, but the **inputs** are part of the design system and need to be
versioned so any developer (or CI) can re-run the generator and produce
byte-identical outputs.
