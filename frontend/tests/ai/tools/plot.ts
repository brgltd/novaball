/**
 * Renders lab traces to an HTML page (top-down SVG + side view) for visual debugging.
 *   node <bundle> <difficulty> <kind> <index...>  → writes <out>.html (screenshot with scripts/shot.mjs)
 */
import { writeFileSync } from 'node:fs';
import { BotRng } from '../../../src/ai/math';
import type { Difficulty } from '../../../src/sim/types';
import { makeSetup, runLab, type LabResult, type ScenarioKind } from '../lab';

const a = process.argv.slice(2);
const diff = (a[0] ?? 'pro') as Difficulty;
const kind = (a[1] ?? 'openNet') as ScenarioKind;
const out = a[2] ?? 'plot.html';
const idx = a.slice(3).map(Number);
const secs = 7;
const rng = new BotRng(1234 + kind.length);
const runs: Array<{ i: number; r: LabResult }> = [];
const maxI = Math.max(...idx);
for (let i = 0; i <= maxI; i++) {
  const s = makeSetup(kind, rng);
  if (idx.includes(i)) runs.push({ i, r: runLab(s, diff, secs, 100 + i, false, true) });
}
const W = 36, L = 50, S = 6; // px per m
function panel(i: number, r: LabResult): string {
  const tr = r.trace!;
  const X = (x: number) => (W - x) * S; // +x drawn to the left so the view is from team 0 looking +Z... keep simple
  const Z = (z: number) => (L - z) * S;
  let svg = `<svg width="${2 * W * S}" height="${2 * L * S}" style="background:#0b1020">`;
  svg += `<rect x="0" y="0" width="${2 * W * S}" height="${2 * L * S}" fill="none" stroke="#335"/>`;
  svg += `<rect x="${X(8.5)}" y="${Z(50) - 8}" width="${17 * S}" height="8" fill="#1ec8ff55"/>`;
  svg += `<rect x="${X(8.5)}" y="${Z(-50)}" width="${17 * S}" height="8" fill="#ff6a1a55"/>`;
  svg += `<line x1="0" y1="${Z(0)}" x2="${2 * W * S}" y2="${Z(0)}" stroke="#223"/>`;
  const bp = tr.map((p) => `${X(p.b[0]).toFixed(1)},${Z(p.b[2]).toFixed(1)}`).join(' ');
  const cp = tr.map((p) => `${X(p.c[0]).toFixed(1)},${Z(p.c[2]).toFixed(1)}`).join(' ');
  svg += `<polyline points="${bp}" fill="none" stroke="#fff" stroke-width="1.5"/>`;
  svg += `<polyline points="${cp}" fill="none" stroke="#1ec8ff" stroke-width="1.5"/>`;
  for (let k = 0; k < tr.length; k += 10) {
    const p = tr[k];
    svg += `<circle cx="${X(p.b[0])}" cy="${Z(p.b[2])}" r="${2 + p.b[1] * 0.6}" fill="none" stroke="#fff8"/>`;
    svg += `<line x1="${X(p.c[0])}" y1="${Z(p.c[2])}" x2="${X(p.c[0] + p.f[0] * 3)}" y2="${Z(p.c[2] + p.f[1] * 3)}" stroke="#1ec8ff"/>`;
    svg += `<circle cx="${X(p.tgt[0])}" cy="${Z(p.tgt[1])}" r="2" fill="#ff0"/>`;
    svg += `<text x="${X(p.c[0]) + 4}" y="${Z(p.c[2])}" fill="#9ab" font-size="9">${p.t.toFixed(1)} ${p.mode} ${p.ctl}</text>`;
  }
  svg += `</svg>`;
  const info = `#${i} touched ${r.touched} t ${r.tTouch.toFixed(2)} scored ${r.scored} own ${r.ownGoal} jumps ${r.jumps} vAfter (${r.vAfter.x.toFixed(1)},${r.vAfter.y.toFixed(1)},${r.vAfter.z.toFixed(1)})`;
  // side view: height over time
  let side = `<svg width="${2 * W * S}" height="140" style="background:#0b1020">`;
  const T = (t: number) => (t / secs) * 2 * W * S;
  const H = (y: number) => 130 - y * 9;
  side += `<polyline points="${tr.map((p) => `${T(p.t)},${H(p.b[1])}`).join(' ')}" fill="none" stroke="#fff"/>`;
  side += `<polyline points="${tr.map((p) => `${T(p.t)},${H(p.c[1])}`).join(' ')}" fill="none" stroke="#1ec8ff"/>`;
  side += `</svg>`;
  return `<div style="display:inline-block;margin:6px;color:#cde;font:11px monospace">${info}<br>${svg}<br>${side}</div>`;
}
writeFileSync(out, `<!doctype html><body style="background:#000;margin:0">${runs.map((x) => panel(x.i, x.r)).join('')}</body>`);
console.log('wrote', out, runs.map((x) => `#${x.i} scored=${x.r.scored} touched=${x.r.touched}`).join(' '));
