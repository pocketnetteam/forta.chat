# Desktop build icons

Source of truth for electron-builder:

| Path | Role |
|------|------|
| `build/icon.png` | Master icon (≥512×512). electron-builder generates `.ico` / `.icns` at pack time |
| `build/icons/512x512.png` | Linux icon set root (and tray source) |

Currently upscaled to 512×512 from `public/forta-icon.png` (source is ~252×248).

## Tor / asar

`asar: true` is enabled. Tor binaries are **not** shipped inside the asar —
`electron/tor/tor-control.cjs` downloads them into `app.getPath('userData')/tor`
at runtime. No `asarUnpack` / `extraResources` needed for Tor sidecars.

## Regenerating

```bash
# After replacing the brand PNG:
cp public/forta-icon.png build/icon.png
cp public/forta-icon.png build/icons/512x512.png
```

Optional tray sizes (Phase 2): add `build/icons/tray-16.png` and `tray-32.png`.
Until then `tray.cjs` falls back to a resized `512x512.png` / `icon.png`.
