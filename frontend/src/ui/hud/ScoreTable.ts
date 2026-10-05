/** Team-grouped player stats table (scoreboard overlay, pause menu, end screen). Rebuilds only when data changes. */
import type { PlayerLine } from '../../contracts';
import type { Team } from '../../sim/types';
import { TEAMS } from '../../theme';
import { h, scoreText, span } from '../dom';
import { icon } from '../widgets';

const COLS: ReadonlyArray<{ key: 'score' | 'goals' | 'assists' | 'saves' | 'shots' | 'demos'; label: string; short: string }> = [
  { key: 'score', label: 'SCORE', short: 'SCR' },
  { key: 'goals', label: 'GOALS', short: 'G' },
  { key: 'assists', label: 'ASSISTS', short: 'A' },
  { key: 'saves', label: 'SAVES', short: 'SV' },
  { key: 'shots', label: 'SHOTS', short: 'SH' },
  { key: 'demos', label: 'DEMOS', short: 'DM' },
];

export class ScoreTable {
  readonly el: HTMLElement;
  private sig = '';

  constructor(variant: 'overlay' | 'pause' | 'end') {
    this.el = h('div', { class: `nb-st nb-st-${variant}`, role: 'table' });
  }

  update(lines: ReadonlyArray<PlayerLine>, teamNames: readonly [string, string], score: readonly [number, number] | null, mvpId = -1): void {
    let sig = `${teamNames[0]}|${teamNames[1]}|${score ? score[0] + ':' + score[1] : ''}|${mvpId}`;
    for (const p of lines) {
      const s = p.stats;
      sig += `|${p.id},${p.name},${p.team},${p.isPlayer ? 1 : 0},${p.isBot ? 1 : 0},${s.score},${s.goals},${s.assists},${s.saves},${s.shots},${s.demos}`;
    }
    if (sig === this.sig) return;
    this.sig = sig;
    this.rebuild(lines, teamNames, score, mvpId);
  }

  private rebuild(lines: ReadonlyArray<PlayerLine>, teamNames: readonly [string, string], score: readonly [number, number] | null, mvpId: number): void {
    const frag = document.createDocumentFragment();
    frag.append(
      h(
        'div',
        { class: 'nb-st-row nb-st-head', role: 'row' },
        span('nb-st-name', 'PILOT'),
        ...COLS.map((c) => h('span', { class: `nb-st-c c-${c.key}`, title: c.label }, span('nb-st-long', c.label), span('nb-st-short', c.short))),
      ),
    );
    for (const team of [0, 1] as Team[]) {
      const members = lines.filter((p) => p.team === team).sort((a, b) => b.stats.score - a.stats.score || a.id - b.id);
      const teamEl = h('div', { class: `nb-st-team t${team}`, role: 'rowgroup' });
      teamEl.style.setProperty('--tc', TEAMS[team].primary);
      teamEl.style.setProperty('--tc2', TEAMS[team].secondary);
      teamEl.append(
        h(
          'div',
          { class: 'nb-st-teamhead', role: 'row' },
          span('nb-st-teambar'),
          span('nb-st-teamname', teamNames[team] || TEAMS[team].name),
          score ? span('nb-st-teamscore', scoreText(score[team])) : null,
        ),
      );
      if (members.length === 0) teamEl.append(h('div', { class: 'nb-st-row nb-st-empty' }, span('nb-st-name', '—')));
      for (const p of members) {
        const s = p.stats;
        teamEl.append(
          h(
            'div',
            { class: `nb-st-row${p.isPlayer ? ' is-you' : ''}${p.id === mvpId ? ' is-mvp' : ''}`, role: 'row' },
            h(
              'span',
              { class: 'nb-st-name' },
              p.id === mvpId ? h('span', { class: 'nb-st-mvp', title: 'MVP' }, icon('star')) : null,
              span('nb-st-pname', p.name),
              p.isPlayer ? span('nb-tag nb-tag-you', 'YOU') : null,
              p.isBot ? span('nb-tag nb-tag-bot', 'BOT') : null,
            ),
            ...COLS.map((c) => span(`nb-st-c c-${c.key}`, String(s[c.key]))),
          ),
        );
      }
      frag.append(teamEl);
    }
    this.el.replaceChildren(frag);
  }
}
