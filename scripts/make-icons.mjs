// Renders public/icons/icon.svg to the PNG sizes phones need (uses the pre-installed Chromium).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Playwright is not a project dependency; this uses a global install if present.
const { chromium } = createRequire(import.meta.url)('playwright');

const svg = readFileSync('public/icons/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['apple-touch-icon.png', 180, 0], ['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-512-maskable.png', 512, 0.12]]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  await page.setContent(`<html><body style="margin:0;background:#dff0d8;display:grid;place-items:center;width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `).replace('rx="44"', pad || name.startsWith('apple') ? 'rx="0"' : 'rx="44"')}</body></html>`);
  await page.screenshot({ path: `public/icons/${name}`, omitBackground: !pad && !name.startsWith('apple') });
}
await browser.close();
console.log('Icons written to public/icons/');
