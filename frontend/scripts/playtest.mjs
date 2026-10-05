#!/usr/bin/env node
// Scripted playtest runner (headless Chrome on the real GPU via ANGLE-GL).
// Usage: node scripts/playtest.mjs <scenario.json> [--url http://localhost:5173/] [--outdir dir] [--w 1600 --h 900]
// Debug API: the dev server exposes the full window.__novaball (startMatch, placeBall, endSoon, setTimeScale, ...).
// A PRODUCTION build (npm run build + npx vite preview) only exposes the read-only __novaball.state() unless the page
// URL has ?debug=1 — e.g. --url 'http://localhost:4173/?debug=1'.
// Scenario: { "steps": [ step, ... ] } where step is one of:
//   { "wait": 1500 }                                  sleep (ms)
//   { "waitFor": "js expr", "timeout": 20000 }         poll until the expression is truthy
//   { "eval": "js expr", "label": "name" }             evaluate + print the (JSON) result
//   { "down": "KeyW" } / { "up": "KeyW" }              key down / up (KeyboardEvent.code names, e.g. ShiftLeft, Space)
//   { "press": "Space", "ms": 80 }                     tap a key
//   { "hold": ["KeyW", "ShiftLeft"], "ms": 2000 }      hold several keys for a duration
//   { "click": [x, y] }                                mouse click (defaults to the center)
//   { "shot": "name" }                                 screenshot → <outdir>/<name>.png
//   { "sample": "js expr", "every": 250, "ms": 5000, "label": "name" }  repeatedly evaluate and print a compact series
// Prints console errors / page errors at the end (and a count).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('usage: node scripts/playtest.mjs <scenario.json> [--url URL] [--outdir DIR]');
  process.exit(2);
}
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 ? args[i + 1] : d;
};
const url = opt('url', 'http://localhost:5173/');
const outdir = opt('outdir', 'dev/shots/playtest');
const w = Number(opt('w', '1600'));
const h = Number(opt('h', '900'));
fs.mkdirSync(outdir, { recursive: true });
const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
const logs = [];
page.on('console', (m) => {
  const t = `[console.${m.type()}] ${m.text()}`;
  if (m.type() === 'error' || m.type() === 'warning') errors.push(t);
  else logs.push(t);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
await page.goto(url, { waitUntil: 'load', timeout: 60_000 });

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
for (const step of scenario.steps) {
  if (step.wait) await page.waitForTimeout(step.wait);
  else if (step.waitFor) {
    const deadline = Date.now() + (step.timeout ?? 20000);
    let ok = false;
    while (Date.now() < deadline) {
      try {
        if (await page.evaluate(step.waitFor)) {
          ok = true;
          break;
        }
      } catch {
        /* not ready */
      }
      await page.waitForTimeout(100);
    }
    console.log(`${stamp()} waitFor ${ok ? 'OK' : 'TIMEOUT'}: ${step.waitFor}`);
  } else if (step.eval) {
    let r;
    try {
      r = await page.evaluate(step.eval);
    } catch (e) {
      r = 'EVAL ERROR: ' + e.message;
    }
    console.log(`${stamp()} ${step.label ?? 'eval'}: ${JSON.stringify(r)}`);
  } else if (step.down) await page.keyboard.down(step.down);
  else if (step.up) await page.keyboard.up(step.up);
  else if (step.press) {
    await page.keyboard.down(step.press);
    await page.waitForTimeout(step.ms ?? 80);
    await page.keyboard.up(step.press);
  } else if (step.hold) {
    for (const k of step.hold) await page.keyboard.down(k);
    await page.waitForTimeout(step.ms ?? 1000);
    for (const k of step.hold) await page.keyboard.up(k);
  } else if (step.click) {
    const [x, y] = Array.isArray(step.click) ? step.click : [w / 2, h / 2];
    await page.mouse.click(x, y);
  } else if (step.shot) {
    const p = path.join(outdir, step.shot + '.png');
    await page.screenshot({ path: p });
    console.log(`${stamp()} shot ${p}`);
  } else if (step.sample) {
    const series = [];
    const end = Date.now() + (step.ms ?? 3000);
    while (Date.now() < end) {
      try {
        series.push(await page.evaluate(step.sample));
      } catch (e) {
        series.push('ERR ' + e.message);
      }
      await page.waitForTimeout(step.every ?? 250);
    }
    console.log(`${stamp()} ${step.label ?? 'sample'}: ${JSON.stringify(series)}`);
  }
}
console.log(`\n=== ${errors.length} console errors/warnings, ${logs.length} other logs`);
for (const e of errors.slice(0, 40)) console.log(e);
await browser.close();
