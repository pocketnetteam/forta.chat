// Generate 1024x1024 / 2732x2732 source PNGs in resources/ from the
// existing 252x248 Android forta-icon.png so that `npx capacitor-assets
// generate --ios` can produce a complete iOS asset catalogue.
//
// This is a placeholder pipeline: the upscaled icon will be pixelated.
// Designer should drop pixel-perfect 1024x1024 PNGs into resources/
// (icon-only.png, icon-foreground.png, icon-background.png) and a
// 2732x2732 splash.png, then re-run `npx capacitor-assets generate --ios`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, 'resources');
const SOURCE_ICON = path.join(ROOT, 'public', 'forta-icon.png');

const ICON_SIZE = 1024;
const SPLASH_SIZE = 2732;
const BG_COLOR = { r: 0x0d, g: 0x12, b: 0x1f, alpha: 1 };

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function main() {
  await ensureDir(OUT);
  const sourceBuf = await fs.readFile(SOURCE_ICON);

  const fittedIcon = await sharp(sourceBuf)
    .resize(ICON_SIZE, ICON_SIZE, {
      fit: 'contain',
      background: BG_COLOR,
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer();

  const transparentForeground = await sharp(sourceBuf)
    .resize(Math.round(ICON_SIZE * 0.66), Math.round(ICON_SIZE * 0.66), {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.lanczos3,
    })
    .extend({
      top: Math.round(ICON_SIZE * 0.17),
      bottom: Math.round(ICON_SIZE * 0.17),
      left: Math.round(ICON_SIZE * 0.17),
      right: Math.round(ICON_SIZE * 0.17),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const solidBackground = await sharp({
    create: {
      width: ICON_SIZE,
      height: ICON_SIZE,
      channels: 4,
      background: BG_COLOR,
    },
  })
    .png()
    .toBuffer();

  const splash = await sharp({
    create: {
      width: SPLASH_SIZE,
      height: SPLASH_SIZE,
      channels: 4,
      background: BG_COLOR,
    },
  })
    .composite([
      {
        input: await sharp(sourceBuf)
          .resize(Math.round(SPLASH_SIZE * 0.25), Math.round(SPLASH_SIZE * 0.25), {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
            kernel: sharp.kernel.lanczos3,
          })
          .png()
          .toBuffer(),
        gravity: 'center',
      },
    ])
    .png()
    .toBuffer();

  await fs.writeFile(path.join(OUT, 'icon-only.png'), fittedIcon);
  await fs.writeFile(path.join(OUT, 'icon-foreground.png'), transparentForeground);
  await fs.writeFile(path.join(OUT, 'icon-background.png'), solidBackground);
  await fs.writeFile(path.join(OUT, 'splash.png'), splash);
  await fs.writeFile(path.join(OUT, 'splash-dark.png'), splash);

  console.log('Generated source assets in resources/:');
  for (const f of ['icon-only.png', 'icon-foreground.png', 'icon-background.png', 'splash.png', 'splash-dark.png']) {
    const stat = await fs.stat(path.join(OUT, f));
    console.log(`  ${f} (${stat.size} bytes)`);
  }
}

main().catch((err) => {
  console.error('[generate-ios-source-assets] failed:', err);
  process.exit(1);
});
