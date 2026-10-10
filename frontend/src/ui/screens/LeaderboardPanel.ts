/** LEADERBOARD: every pilot's career, read live from the NovaArena contract (best NOVA earners first). */
import { addressUrl, chain, CHAIN, DEPLOYMENT, formatNova, shortAddress, type LeaderRow } from '../../chain';
import { openUrl } from '../chainui';
import { Panel, type UIContext } from '../core';
import { div, h, span } from '../dom';
import { gp, hint, icon, kbd } from '../widgets';
import { panelHeader } from './common';

export class LeaderboardPanel extends Panel {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private loading = false;

  constructor(private readonly ctx: UIContext) {
    super();
    this.list = div('nb-lb-list');
    this.status = span('nb-foot-note', '');
    const head = h(
      'div',
      { class: 'nb-lb-row nb-lb-head' },
      span('nb-lb-rank', '#'),
      span('nb-lb-pilot', 'PILOT'),
      span('nb-lb-num', 'MATCHES'),
      span('nb-lb-num', 'WINS'),
      span('nb-lb-num', 'POINTS'),
      span('nb-lb-earned', 'NOVA EARNED'),
    );
    this.el = h(
      'section',
      { class: 'nb-layer nb-panel nb-leaderboard', 'aria-label': 'Leaderboard' },
      div('nb-panel-bg'),
      panelHeader(ctx, 'LEADERBOARD', 'LIVE FROM THE ARENA CONTRACT', h('span', { class: 'nb-net-badge' }, span('nb-net-dot'), CHAIN.name.toUpperCase())),
      h('div', { class: 'nb-panel-body nb-lb-body' }, head, this.list),
      h('footer', { class: 'nb-panel-foot' }, this.status, h('div', { class: 'nb-hints' }, hint([kbd('ENTER', true)], [gp('A')], 'VIEW PILOT'), hint([kbd('ESC', true)], [gp('B')], 'BACK'))),
    );
  }

  override defaultFocus(): HTMLElement | null {
    return (this.list.querySelector('.is-you') as HTMLElement | null) ?? (this.list.querySelector('[data-nav]') as HTMLElement | null) ?? (this.el.querySelector('.nb-back') as HTMLElement | null);
  }

  override onShow(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.status.textContent = 'READING NOVAARENA…';
    if (!this.list.childElementCount) this.list.replaceChildren(div('nb-lb-empty', 'Loading pilots…'));
    try {
      const rows = await chain.leaderboard(50);
      this.render(rows);
      this.status.textContent = `${rows.length} PILOT${rows.length === 1 ? '' : 'S'} · RANKED BY NOVA EARNED · ${DEPLOYMENT ? shortAddress(DEPLOYMENT.arena) : ''}`;
    } catch {
      this.list.replaceChildren(div('nb-lb-empty', `Can't reach ${CHAIN.name} right now.`));
      this.status.textContent = 'OFFLINE';
    } finally {
      this.loading = false;
    }
  }

  private render(rows: LeaderRow[]): void {
    if (!rows.length) {
      this.list.replaceChildren(div('nb-lb-empty', 'No pilots yet — finish a match and claim the #1 spot.'));
      return;
    }
    this.list.replaceChildren(
      ...rows.map((r) => {
        const row = h(
          'button',
          { class: `nb-lb-row${r.isYou ? ' is-you' : ''}${r.rank <= 3 ? ` is-top is-top${r.rank}` : ''}`, type: 'button', 'data-nav': '', title: r.address },
          span('nb-lb-rank', r.rank <= 3 ? '' : String(r.rank), r.rank <= 3 ? icon('trophy') : null),
          h('span', { class: 'nb-lb-pilot' }, span('nb-lb-name', r.callsign), r.isYou ? span('nb-tag nb-tag-you', 'YOU') : null, span('nb-lb-addr', shortAddress(r.address))),
          span('nb-lb-num', String(r.matches)),
          span('nb-lb-num', String(r.wins)),
          span('nb-lb-num', r.points.toLocaleString('en-US')),
          h('span', { class: 'nb-lb-earned' }, icon('nova', 'nb-nova-ico'), formatNova(r.earned)),
        );
        row.addEventListener('click', () => {
          this.ctx.sound('click');
          openUrl(addressUrl(r.address));
        });
        return row;
      }),
    );
    this.ctx.focus(this.defaultFocus());
  }
}
