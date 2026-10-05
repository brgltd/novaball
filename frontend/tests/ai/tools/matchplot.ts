/** Plot a window of a match: node <bundle> <ts> <d0> <d1> <seed> <t0> <t1> <out.html> */
import { writeFileSync } from 'node:fs';
import { BotManager } from '../../../src/ai/BotManager';
import type { Difficulty, TeamSize } from '../../../src/sim/types';
import { makeControlState } from '../../../src/sim/types';
import { World } from '../../../src/sim/world';
import { makeConfig } from '../harness';
const a = process.argv.slice(2);
const ts = Number(a[0]) as TeamSize;
const cfg = makeConfig({ teamSize: ts, diff: [a[1] as Difficulty, a[2] as Difficulty], seed: Number(a[3]) });
const w = new World(cfg);
const ids = (t: number) => w.cars.filter((c) => c.team === t).map((c) => c.id);
const m0 = new BotManager(w, ids(0), a[1] as Difficulty, Number(a[3]) * 31 + 7);
const m1 = new BotManager(w, ids(1), a[2] as Difficulty, Number(a[3]) * 57 + 3);
const inputs = w.cars.map(() => makeControlState());
const t0 = Number(a[4]), t1 = Number(a[5]);
type F = { t: number; b: number[]; c: Array<[number, number, string]>; ph: string };
const frames: F[] = [];
const evs: string[] = [];
while (w.time < t1 + 3) {
  m0.update(w, inputs);
  m1.update(w, inputs);
  w.step(inputs);
  for (const e of w.drainEvents()) if (w.time >= t0 && w.time <= t1 && (e.type === 'ballHit' || e.type === 'goal' || e.type === 'shot' || e.type === 'save' || e.type === 'pulse')) evs.push(`${w.time.toFixed(2)} ${e.type} ${'carId' in e ? e.carId : ''}`);
  if (w.time >= t0 && w.time <= t1 && w.tick % 6 === 0)
    frames.push({ t: w.time, b: [w.ball.pos.x, w.ball.pos.y, w.ball.pos.z], ph: w.match.phase, c: w.cars.map((c) => { const st = m0.botState(c.id) ?? m1.botState(c.id); return [c.pos.x, c.pos.z, st ? `${st.mode}[${st.role[0]}]` : '']; }) });
}
const S = 5, W = 36, L = 50;
const X = (x: number) => (W - x) * S, Z = (z: number) => (L - z) * S;
const col = ['#1ec8ff', '#ff6a1a'];
let svg = `<svg width="${2 * W * S}" height="${2 * L * S}" style="background:#0b1020">`;
svg += `<rect x="${X(8.5)}" y="0" width="${17 * S}" height="6" fill="#ff6a1a88"/><rect x="${X(8.5)}" y="${2 * L * S - 6}" width="${17 * S}" height="6" fill="#1ec8ff88"/>`;
svg += `<polyline points="${frames.map((f) => `${X(f.b[0])},${Z(f.b[2])}`).join(' ')}" fill="none" stroke="#fff" stroke-width="2"/>`;
for (let i = 0; i < w.cars.length; i++) {
  const team = w.cars[i].team;
  svg += `<polyline points="${frames.map((f) => `${X(f.c[i][0])},${Z(f.c[i][1])}`).join(' ')}" fill="none" stroke="${col[team]}" stroke-width="1.2" opacity="${0.5 + 0.5 * ((i % ts) / ts)}"/>`;
  for (let k = 0; k < frames.length; k += 15) {
    const f = frames[k];
    svg += `<text x="${X(f.c[i][0]) + 3}" y="${Z(f.c[i][1])}" fill="${col[team]}" font-size="8">${f.t.toFixed(0)}:${i} ${f.c[i][2]}</text>`;
  }
}
for (let k = 0; k < frames.length; k += 15) svg += `<text x="${X(frames[k].b[0]) + 3}" y="${Z(frames[k].b[2]) - 3}" fill="#fff" font-size="9">${frames[k].t.toFixed(0)}</text>`;
svg += `</svg>`;
writeFileSync(a[6], `<!doctype html><body style="background:#000;margin:0;display:flex"><div>${svg}</div><pre style="color:#9ab;font:10px monospace">${evs.join('\n')}</pre></body>`);
console.log('frames', frames.length, 'score', w.match.score);
