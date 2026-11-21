// renders the email art into public/landing/email. needs: python3 -m http.server 7433 --bind 127.0.0.1 in ~/Desktop/code,
// playwright from the make checkout, and the headless shell CHROMIUM_PATH names (or playwright's own)
import { createRequire } from 'module';
import { copyFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
const { chromium } = createRequire('/Users/siddharth/Desktop/code/make/')('playwright');
const here = new URL('.', import.meta.url).pathname, out = `${here}../../public/landing/email`;
const ROOT = process.env.ROOT ?? 'apps/site';
const scenes = ['code', 'welcome', 'cloud-ready', 'receipt', 'payment', 'napping', 'heads-up', 'cloud-gone', 'bye', 'promo'];
mkdirSync(`${out}/fonts`, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
for (const scene of scenes) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 500 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:7433/${ROOT}/art-src/email/scenes.html?scene=${scene}`);
  await page.waitForFunction(() => window.READY === true, null, { timeout: 15000 });
  await page.locator('canvas').screenshot({ path: `${out}/scene-${scene}.png` });
  if (errors.length) console.log(scene, errors);
  await page.close();
}
await browser.close();
copyFileSync('/Users/siddharth/Desktop/code/omb-ref/brand/final/madani-logo-64.png', `${out}/kit-64.png`);
for (const font of ['general-sans', 'geist-mono']) copyFileSync(`${here}../../public/landing/fonts/${font}.woff2`, `${out}/fonts/${font}.woff2`);
// pixel art carries few colours: a palette png keeps them exact and small
execFileSync('python3', ['-c', `
import glob
from PIL import Image
for f in glob.glob('${out}/scene-*.png'):
    im = Image.open(f).convert('RGB')
    if len(im.getcolors(1 << 16) or []) <= 256: im.quantize(colors=256, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE).save(f, optimize=True)
    else: im.save(f, optimize=True)
`]);
console.log('done');
