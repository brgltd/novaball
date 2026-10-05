/** PAUSE: resume / restart / settings / controls / quit + live scoreboard. */
import type { MatchConfig } from '../../sim/types';
import { Panel, type UIContext } from '../core';
import { div, formatClock, h, setText, span, textNode } from '../dom';
import type { Hud } from '../hud/Hud';
import { ScoreTable } from '../hud/ScoreTable';
import { button, gp, hint, icon, kbd } from '../widgets';

const DIFF_NAME: Record<string, string> = { rookie: 'ROOKIE', pro: 'PRO', legend: 'LEGEND' };

export class PauseMenu extends Panel {
  readonly el: HTMLElement;
  override root = true;
  override wrap = true;
  private readonly table = new ScoreTable('pause');
  private readonly meta: Text;
  private readonly clock: Text;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly board: HTMLElement;

  constructor(
    private readonly ctx: UIContext,
    private readonly hud: Hud,
    private readonly getConfig: () => MatchConfig | null,
  ) {
    super();
    this.meta = textNode('');
    this.clock = textNode('');
    this.resumeBtn = button(ctx, { label: 'RESUME', icon: 'play', variant: 'primary', sound: 'back', onClick: () => ctx.cb.onResume() });
    const restart = button(ctx, {
      label: 'RESTART',
      icon: 'reset',
      onClick: () => ctx.confirm({ title: 'RESTART MATCH?', body: 'The current match will be lost and a fresh kickoff starts with the same setup.', confirmLabel: 'RESTART' }, () => ctx.cb.onRestart()),
    });
    const settings = button(ctx, { label: 'SETTINGS', icon: 'settings', onClick: () => ctx.open('settings') });
    const controls = button(ctx, { label: 'CONTROLS', icon: 'gamepad', onClick: () => ctx.open('controls') });
    const fullscreen = button(ctx, { label: 'FULLSCREEN', icon: 'fullscreen', onClick: () => ctx.toggleFullscreen() });
    const fsLabel = fullscreen.querySelector('.nb-btn-label');
    ctx.onFullscreenChange((on) => {
      if (fsLabel) fsLabel.textContent = on ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
    });
    const quit = button(ctx, {
      label: 'QUIT TO MENU',
      icon: 'back',
      variant: 'danger',
      onClick: () => ctx.confirm({ title: 'QUIT MATCH?', body: 'Leave this match and return to the main menu? Match progress will be lost.', confirmLabel: 'QUIT', danger: true }, () => ctx.cb.onQuitToMenu()),
    });
    for (const b of [this.resumeBtn, restart, settings, controls, fullscreen, quit]) {
      b.classList.add('nb-pause-btn');
      b.setAttribute('data-nav-group', 'pause');
    }

    this.board = h(
      'div',
      { class: 'nb-pause-board' },
      h('div', { class: 'nb-pause-board-head' }, icon('scoreboard'), span('nb-pause-board-t', 'SCOREBOARD'), span('nb-pause-board-clock', this.clock)),
      this.table.el,
    );

    this.el = h(
      'div',
      { class: 'nb-screen nb-pause nb-layer' },
      div('nb-pause-bg'),
      h(
        'div',
        { class: 'nb-pause-left' },
        h('div', { class: 'nb-pause-eyebrow' }, icon('pause'), 'GAME PAUSED'),
        h('h2', { class: 'nb-pause-title' }, 'PAUSED'),
        h('div', { class: 'nb-pause-meta' }, this.meta),
        h('nav', { class: 'nb-pause-menu' }, this.resumeBtn, restart, settings, controls, fullscreen, quit),
      ),
      this.board,
      h('footer', { class: 'nb-pause-foot' }, h('div', { class: 'nb-hints' }, hint([kbd('↑'), kbd('↓')], [gp('DPAD')], 'NAVIGATE'), hint([kbd('ENTER', true)], [gp('A')], 'SELECT'), hint([kbd('ESC', true)], [gp('B')], 'RESUME'))),
    );
  }

  override defaultFocus(): HTMLElement | null {
    return this.resumeBtn;
  }

  override onShow(): void {
    this.refresh();
  }

  override onStart(): boolean {
    this.ctx.sound('back');
    this.ctx.cb.onResume();
    return true;
  }

  /** Refresh the live scoreboard + meta (cheap when nothing changed). */
  refresh(): void {
    const hud = this.hud;
    const cfg = this.getConfig();
    const free = hud.freePlay || !!cfg?.freePlay;
    this.el.classList.toggle('is-freeplay', free);
    if (free) setText(this.meta, 'FREE PLAY · PRACTICE ARENA');
    else if (cfg) setText(this.meta, `${cfg.teamSize}V${cfg.teamSize} · ${DIFF_NAME[cfg.difficulty] ?? cfg.difficulty.toUpperCase()} BOTS · ${formatClock(cfg.durationSec)} MATCH`);
    else setText(this.meta, 'EXHIBITION VS AI');
    setText(this.clock, hud.overtime ? `OVERTIME` : free ? '' : `${formatClock(Math.ceil(hud.clock - 1e-6))} LEFT`);
    this.table.update(hud.lines, hud.teamNames, hud.score);
  }
}
