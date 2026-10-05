#!/usr/bin/env node
// Headless-Chrome screenshot + console capture helper (independent browser instance per call).
// Usage:
//   node scripts/shot.mjs <url> [--out file.png] [--wait ms] [--w 1600] [--h 900]
//        [--eval "js expression returning JSON-able value"] [--keys "KeyW:2000,Space:100"] [--click]
// Prints: console messages (errors/warnings/logs), page errors, optional eval result, and output path.
// Debug API: against a PRODUCTION build only the read-only window.__novaball.state() exists unless the URL has
// ?debug=1 (e.g. http://localhost:4173/?debug=1); the dev server always exposes the full API.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const url = args[0];
if (!url) { console.error('usage: node scripts/shot.mjs <url> [--out f.png] [--wait ms] [--eval js] [--keys K:ms,...] [--click]'); process.exit(2); }
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
const out = opt('out', 'shot.png');
const wait = Number(opt('wait', '4000'));
const w = Number(opt('w', '1600')), h = Number(opt('h', '900'));
const evalExpr = opt('eval', null);
const keys = opt('keys', null);

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ''}`));
await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
if (flag('click')) { await page.mouse.click(w / 2, h / 2); }
if (keys) {
  for (const part of keys.split(',')) {
    const [k, ms] = part.split(':');
    await page.keyboard.down(k); await page.waitForTimeout(Number(ms ?? 100)); await page.keyboard.up(k);
  }
}
await page.waitForTimeout(wait);
let evalResult;
if (evalExpr) {
  try { evalResult = await page.evaluate(evalExpr); } catch (e) { evalResult = 'EVAL ERROR: ' + e.message; }
}
await page.screenshot({ path: out });
console.log(logs.join('\n'));
if (evalExpr) console.log('[eval] ' + JSON.stringify(evalResult, null, 2));
console.log('[screenshot] ' + out);
await browser.close();
