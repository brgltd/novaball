#!/usr/bin/env node
// NOVABALL — cross-engine determinism check for the simulation.
// Bundles ./scenario.ts, runs it in Node (V8) and in headless Firefox (SpiderMonkey), and compares the
// World.hash() checkpoints (every 5 s of a 60 s chaotic 3v3). Usage (from the project root):
//   node tests/sim/xengine/run.mjs            # FIREFOX=/path/to/firefox to override the browser binary
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const work = mkdtempSync(join(tmpdir(), 'novaball-xengine-'));
const cleanup = () => rmSync(work, { recursive: true, force: true });
process.on('exit', cleanup);
const bundle = join(work, 'scenario.mjs');
mkdirSync(join(work, 'profile'));
const b = spawnSync('npx', ['rolldown', join(here, 'scenario.ts'), '--file', bundle, '--format', 'esm', '--platform', 'browser'], { cwd: root, encoding: 'utf8' });
if (b.status !== 0) { console.error(b.stdout, b.stderr); process.exit(2); }

await import(pathToFileURL(bundle).href);
const nodeResult = globalThis.__runScenario(60);
console.log(`node ${process.version}: ${JSON.stringify(nodeResult.hashes)}`);

const firefox = process.env.FIREFOX || '/usr/bin/firefox';
if (!existsSync(firefox)) {
  console.log('firefox not found — node-only run');
  process.exit(0);
}
const page = `<!doctype html><meta charset="utf-8"><script type="module">
import './scenario.mjs';
let body; try { body = JSON.stringify({ ua: navigator.userAgent, result: globalThis.__runScenario(60) }); }
catch (e) { body = JSON.stringify({ ua: navigator.userAgent, error: String((e && e.stack) || e) }); }
fetch('/result', { method: 'POST', body });
</script>`;
let ff;
const browserResult = await new Promise((resolve, reject) => {
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { res.end('ok'); srv.close(); resolve(JSON.parse(s)); });
      return;
    }
    if (req.url === '/scenario.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(bundle)); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(page);
  });
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    ff = spawn(firefox, ['--headless', '--no-remote', '--profile', join(work, 'profile'), `http://127.0.0.1:${port}/`], { stdio: 'ignore' });
  });
  setTimeout(() => reject(new Error('timeout waiting for firefox')), 120_000).unref();
}).finally(() => {
  try {
    ff?.kill();
  } catch {
    /* already gone */
  }
});
if (browserResult.error) { console.error(browserResult.error); process.exit(1); }
console.log(`${browserResult.ua}: ${JSON.stringify(browserResult.result.hashes)}`);
const same = JSON.stringify(browserResult.result) === JSON.stringify(nodeResult);
console.log(same ? 'PASS — identical simulation on V8 and SpiderMonkey' : 'FAIL — engines diverged');
process.exit(same ? 0 : 1);
