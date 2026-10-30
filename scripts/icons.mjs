// Renders icons/icon.svg to PNG sizes with the preinstalled Chromium.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import fs from 'node:fs';
const svg = fs.readFileSync(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');
const b = await chromium.launch();
for (const s of [192, 512]) {
  const p = await b.newPage({ viewport: { width: s, height: s } });
  await p.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
  await p.screenshot({ path: new URL(`../public/icons/icon-${s}.png`, import.meta.url).pathname, omitBackground: true });
}
await b.close();
