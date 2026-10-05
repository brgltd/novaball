/** Plot the last ~4 s before each goal of a match: node <bundle> <ts> <d0> <d1> <seed> <out.html> */
import { writeFileSync } from 'node:fs';
import type { Difficulty, TeamSize } from '../../../src/sim/types';
import { runMatch } from '../harness';
const a = process.argv.slice(2);
const m = runMatch({ teamSize: Number(a[0]) as TeamSize, diff: [a[1] as Difficulty, a[2] as Difficulty], seed: Number(a[3]), goalClips: true });
const S = 5, W = 36, L = 50;
const X = (x: number) => (W - x) * S;
const Z = (z: number) => (L - z) * S;
const col = ['#1ec8ff', '#ff6a1a'];
const panels = (m.clips ?? []).map((clip, gi) => {
  const fr = clip.frames;
  let svg = `<svg width="${2 * W * S}" height="${2 * L * S}" style="background:#0b1020">`;
  svg += `<rect x="${X(8.5)}" y="0" width="${17 * S}" height="6" fill="#ff6a1a88"/><rect x="${X(8.5)}" y="${2 * L * S - 6}" width="${17 * S}" height="6" fill="#1ec8ff88"/>`;
  svg += `<polyline points="${fr.map((f) => `${X(f.b[0])},${Z(f.b[2])}`).join(' ')}" fill="none" stroke="#fff" stroke-width="2"/>`;
  const n = fr[0]?.c.length ?? 0;
  for (let i = 0; i < n; i++) {
    const team = i < n / 2 ? 0 : 1;
    svg += `<polyline points="${fr.map((f) => `${X(f.c[i][0])},${Z(f.c[i][2])}`).join(' ')}" fill="none" stroke="${col[team]}" stroke-width="1.3" opacity="0.9"/>`;
    for (let k = 0; k < fr.length; k += 10) {
      const f = fr[k];
      svg += `<text x="${X(f.c[i][0]) + 3}" y="${Z(f.c[i][2])}" fill="${col[team]}" font-size="8">${(f.t - fr[fr.length - 1].t).toFixed(1)} ${f.c[i][3]}</text>`;
    }
  }
  svg += `</svg>`;
  return `<div style="display:inline-block;margin:4px;color:#cde;font:11px monospace">goal ${gi} team ${clip.team} scorer ${clip.scorerId}<br>${svg}</div>`;
});
writeFileSync(a[4], `<!doctype html><body style="background:#000;margin:0">${panels.join('')}</body>`);
console.log(`score ${m.score} goals ${m.goals} → ${a[4]}`);
