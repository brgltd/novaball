/** END: VICTORY / DEFEAT headline, final score, YOUR MATCH strip (+ tip), MVP card, stats table, REMATCH / MAIN MENU. */
import type { MatchSummary, PlayerLine } from '../../contracts';
import type { Difficulty } from '../../sim/types';
import { TEAMS } from '../../theme';
import { Panel, type UIContext } from '../core';
import { div, formatClock, h, play, scoreText, span } from '../dom';
import { ScoreTable } from '../hud/ScoreTable';
import { button, gp, hint, icon, kbd } from '../widgets';
import { chain, formatNova, NETWORK_LABEL, txUrl, type RewardState } from '../../chain';
import { openUrl } from '../chainui';

const DIFF_NAME: Record<string, string> = { rookie: 'ROOKIE', pro: 'PRO', legend: 'LEGEND' };
const NEXT_DIFF: Partial<Record<Difficulty, Difficulty>> = { rookie: 'pro', pro: 'legend' };

/** Optional summary fields not in the contract yet: the sim's deterministic end-of-match hash. */
interface MatchSummaryEx extends MatchSummary {
  hash?: number;
}

const hex32 = (n: number) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

export class EndScreen extends Panel {
  readonly el: HTMLElement;
  override root = true;
  private readonly table = new ScoreTable('end');
  private readonly headline: HTMLElement;
  private readonly subline: HTMLElement;
  private readonly score: HTMLElement;
  private readonly mine: HTMLElement;
  private readonly mvp: HTMLElement;
  private readonly info: HTMLElement;
  private readonly rematch: HTMLButtonElement;
  private readonly menu: HTMLButtonElement;
  /** NOVA EARNED card: the match reward as it lands on-chain. */
  private readonly reward: HTMLButtonElement;
  private readonly rewardAmt: Text;
  private readonly rewardSub: HTMLElement;
  private readonly rewardCta: HTMLElement;
  private rewardShown = false;
  private unsub: (() => void) | null = null;
  private tick = 0;
  private countFrom = 0n;
  private countRaf = 0;
  private verifyK: HTMLElement | null = null;
  private verifyHash: string | null = null;

  constructor(private readonly ctx: UIContext) {
    super();
    this.headline = h('h1', { class: 'nb-end-title' });
    this.subline = div('nb-end-sub');
    this.score = div('nb-end-score');
    this.mine = div('nb-end-mine');
    this.mvp = div('nb-mvp');
    this.info = div('nb-end-info');
    this.rematch = button(ctx, { label: 'REMATCH', icon: 'replay', variant: 'primary', sound: 'start', onClick: () => ctx.cb.onRestart() });
    this.menu = button(ctx, { label: 'MAIN MENU', icon: 'back', onClick: () => ctx.cb.onQuitToMenu() });
    this.rewardAmt = document.createTextNode('0');
    this.rewardSub = span('nb-reward-sub');
    this.rewardCta = span('nb-reward-cta');
    this.reward = h(
      'button',
      { class: 'nb-reward', type: 'button', 'data-nav': '', 'aria-label': 'NOVA earned' },
      h('span', { class: 'nb-reward-coin' }, icon('nova')),
      h('span', { class: 'nb-reward-main' }, h('span', { class: 'nb-reward-amt' }, span('nb-reward-plus', '+'), span('nb-reward-v', this.rewardAmt), span('nb-reward-u', 'NOVA')), this.rewardSub),
      this.rewardCta,
    );
    this.reward.addEventListener('click', () => {
      ctx.sound('click');
      const r = chain.state.reward;
      ctx.open(r?.status === 'confirmed' && chain.affordable().length ? 'garage' : 'wallet');
    });
    this.el = h(
      'div',
      { class: 'nb-screen nb-end nb-layer' },
      div('nb-end-bg'),
      div('nb-end-beams'),
      h('header', { class: 'nb-end-head' }, this.headline, this.subline, this.score, this.mine),
      h('div', { class: 'nb-end-body' }, this.mvp, h('div', { class: 'nb-end-table' }, this.table.el)),
      h(
        'footer',
        { class: 'nb-end-foot' },
        this.info,
        this.reward,
        h('div', { class: 'nb-end-actions' }, h('div', { class: 'nb-hints' }, hint([kbd('←'), kbd('→')], [gp('DPAD')], 'NAVIGATE'), hint([kbd('ENTER', true)], [gp('A')], 'SELECT')), this.menu, this.rematch),
      ),
    );
  }


  set(sum: MatchSummary): void {
    const pt = sum.playerTeam;
    const won = sum.winner === pt;
    const draw = sum.winner === -1;
    const result = draw ? 'draw' : won ? 'victory' : 'defeat';
    this.el.setAttribute('data-result', result);
    const wt = sum.winner === -1 ? pt : sum.winner;
    this.el.style.setProperty('--wc', TEAMS[wt].primary);
    this.el.style.setProperty('--wc2', TEAMS[wt].secondary);
    this.el.style.setProperty('--pc', TEAMS[pt].primary);

    const word = draw ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
    this.headline.replaceChildren(...[...word].map((ch, i) => {
      const s = span('nb-end-ch', ch);
      s.style.setProperty('--i', String(i));
      return s;
    }));
    this.headline.setAttribute('data-text', word);
    this.subline.replaceChildren(draw ? 'NO WINNER' : `${TEAMS[sum.winner as 0 | 1].name} WINS`);
    if (sum.overtime) this.subline.append(span('nb-end-ot', 'OVERTIME'));

    const plate = (team: 0 | 1) => {
      const el = h('div', { class: `nb-end-team t${team}${sum.winner === team ? ' is-win' : ''}` }, span('nb-end-team-name', TEAMS[team].name), span('nb-end-team-score', scoreText(sum.score[team])));
      el.style.setProperty('--tc', TEAMS[team].primary);
      el.style.setProperty('--tc2', TEAMS[team].secondary);
      return el;
    };
    this.score.replaceChildren(plate(0), span('nb-end-dash', '—'), plate(1));

    this.buildMine(sum);

    // MVP
    const mvp: PlayerLine | undefined = sum.players.find((p) => p.id === sum.mvpId) ?? [...sum.players].sort((a, b) => b.stats.score - a.stats.score)[0];
    if (mvp) {
      const t = TEAMS[mvp.team];
      this.mvp.style.setProperty('--tc', t.primary);
      this.mvp.style.setProperty('--tc2', t.secondary);
      const stat = (v: number, l: string) => h('div', { class: 'nb-mvp-stat' }, span('nb-mvp-stat-v', scoreText(v)), span('nb-mvp-stat-l', l));
      const extra = mvp.stats.hardestHit > 0 ? h('div', { class: 'nb-mvp-extra' }, 'HARDEST HIT ', span('nb-mvp-extra-v', `${Math.round(mvp.stats.hardestHit * 3.6)} KM/H`)) : null;
      this.mvp.replaceChildren(
        div('nb-mvp-shine'),
        h('div', { class: 'nb-mvp-badge' }, icon('star'), span('nb-mvp-k', 'MVP')),
        h('div', { class: 'nb-mvp-name' }, mvp.name, mvp.isPlayer ? span('nb-tag nb-tag-you', 'YOU') : mvp.isBot ? span('nb-tag nb-tag-bot', 'BOT') : null),
        h('div', { class: 'nb-mvp-team' }, span('nb-mvp-dot'), t.name),
        h('div', { class: 'nb-mvp-score' }, span('nb-mvp-score-v', scoreText(mvp.stats.score)), span('nb-mvp-score-l', 'PTS')),
        h('div', { class: 'nb-mvp-stats' }, stat(mvp.stats.goals, 'GOALS'), stat(mvp.stats.assists, 'ASSISTS'), stat(mvp.stats.saves, 'SAVES'), stat(mvp.stats.shots, 'SHOTS')),
      );
      if (extra) this.mvp.append(extra);
      this.mvp.style.display = '';
    } else this.mvp.style.display = 'none';

    this.table.update(sum.players, [TEAMS[0].name, TEAMS[1].name], sum.score, mvp ? mvp.id : -1);

    // Match info + VERIFIABLE MATCH badge (the deterministic-replay / on-chain angle)
    const c = sum.config;
    const hash = (sum as MatchSummaryEx).hash;
    const hasHash = typeof hash === 'number' && Number.isFinite(hash);
    const proof = h(
      'div',
      { class: 'nb-verify', title: 'Same inputs ⇒ same hash on any machine — ready for on-chain verification' },
      h('span', { class: 'nb-verify-ico' }, icon('verified')),
      h(
        'span',
        { class: 'nb-verify-text' },
        (this.verifyK = span('nb-verify-k', 'VERIFIABLE MATCH')),
        h('span', { class: 'nb-verify-v' }, `SEED ${hex32(c.seed)}`, hasHash ? span('nb-verify-sep', ' · ') : null, hasHash ? `HASH ${hex32(hash)}` : null),
      ),
    );
    proof.addEventListener('click', () => openUrl(this.verifyHash ? txUrl(this.verifyHash) : null));
    this.verifyHash = null;
    this.rewardShown = chain.state.enabled && !c.freePlay && sum.players.some((p) => p.isPlayer);
    this.el.classList.toggle('has-reward', this.rewardShown);
    this.countFrom = 0n;
    this.renderReward();
    this.info.replaceChildren(span('nb-end-info-k', c.freePlay ? 'FREE PLAY' : `${c.teamSize}V${c.teamSize} · ${DIFF_NAME[c.difficulty] ?? c.difficulty} BOTS · ${formatClock(c.durationSec)}`), proof);
  }

  /** YOUR MATCH: the player's own numbers (the MVP card is usually a bot on a defeat) + a contextual next step. */
  private buildMine(sum: MatchSummary): void {
    const me = sum.players.find((p) => p.isPlayer);
    if (!me) {
      this.mine.replaceChildren();
      this.mine.style.display = 'none';
      return;
    }
    this.mine.style.display = '';
    const s = me.stats;
    const stat = (v: string, l: string) => h('span', { class: 'nb-mine-stat' }, span('nb-mine-v', v), span('nb-mine-l', l));
    const pair = (a: number, al: string, b: number, bl: string) =>
      h('span', { class: 'nb-mine-stat' }, span('nb-mine-v', `${a}`), span('nb-mine-l', al), span('nb-mine-v nb-mine-v2', `${b}`), span('nb-mine-l', bl));
    const parts: HTMLElement[] = [
      h('span', { class: 'nb-mine-k' }, span('nb-mine-dot'), 'YOUR MATCH'),
      stat(String(s.touches), s.touches === 1 ? 'TOUCH' : 'TOUCHES'),
      stat(s.hardestHit > 0 ? String(Math.round(s.hardestHit * 3.6)) : '—', 'KM/H HARDEST HIT'),
      pair(s.shots, s.shots === 1 ? 'SHOT' : 'SHOTS', s.saves, s.saves === 1 ? 'SAVE' : 'SAVES'),
      pair(s.goals, s.goals === 1 ? 'GOAL' : 'GOALS', s.assists, s.assists === 1 ? 'ASSIST' : 'ASSISTS'),
    ];
    const tip = this.tipFor(sum);
    if (tip) parts.push(tip);
    this.mine.replaceChildren(...parts);
  }

  /** Lost big at ROOKIE → warm up in Free Play; won big → try the next difficulty. */
  private tipFor(sum: MatchSummary): HTMLElement | null {
    const c = sum.config;
    if (c.freePlay) return null;
    const pt = sum.playerTeam;
    const margin = sum.score[pt] - sum.score[pt === 0 ? 1 : 0];
    const ctx = this.ctx;
    let label = '';
    let sub = '';
    let action: (() => void) | null = null;
    if (margin <= -3 && c.difficulty === 'rookie') {
      label = 'WARM UP IN FREE PLAY';
      sub = 'No clock, no rivals — just you and the core';
      action = () => ctx.freePlay();
    } else if (margin >= 3 && NEXT_DIFF[c.difficulty]) {
      const next = NEXT_DIFF[c.difficulty]!;
      label = `READY FOR ${DIFF_NAME[next]}?`;
      sub = `Set up a match against ${DIFF_NAME[next]} bots`;
      action = () => {
        ctx.settings.lastDifficulty = next;
        ctx.settingsChanged();
        ctx.open('setup');
      };
    }
    if (!action) return null;
    const run = action;
    const b = h('button', { class: 'nb-mine-tip', type: 'button', 'data-nav': '', title: sub }, icon('tip', 'nb-mine-tip-ico'), span('nb-mine-tip-l', label), icon('chevron', 'nb-mine-tip-go'));
    b.addEventListener('click', () => {
      ctx.sound('click');
      run();
    });
    return b;
  }

  override defaultFocus(): HTMLElement | null {
    return this.rematch;
  }

  override onHide(): void {
    this.unsub?.();
    this.unsub = null;
    window.clearInterval(this.tick);
    cancelAnimationFrame(this.countRaf);
  }

  // ------------------------------------------------------------------ NOVA EARNED

  private renderReward(): void {
    if (!this.rewardShown) return;
    const r = chain.state.reward;
    const status = r?.status ?? 'sending';
    this.reward.className = `nb-reward is-${status}`;
    this.countTo(r?.amount ?? 0n);
    const rate = formatNova(chain.state.rewardPerPoint, 2);
    const pts = !r ? '' : r.points === 0 ? 'NO POINTS — EVERY TOUCH EARNS NOVA' : `${r.points} PTS`;
    this.reward.title = `${rate} NOVA per match point`;
    this.rewardSub.replaceChildren(pts ? span('nb-reward-pts', pts) : '', span('nb-reward-status', this.statusText(r)));
    const can = status === 'confirmed' && chain.affordable().length > 0;
    this.rewardCta.replaceChildren(
      status === 'sending' || status === 'pending' || status === 'cooldown' ? icon('spinner', 'nb-spin') : can ? span('nb-reward-cta-l', 'UNLOCK') : icon(status === 'confirmed' ? 'wallet' : 'info'),
      can ? icon('chevron') : '',
    );
    this.reward.classList.toggle('can-spend', can);
    // the verifiable-match badge links to the on-chain record once it's in
    if (status === 'confirmed' && r?.hash) {
      this.verifyHash = r.hash;
      if (this.verifyK) this.verifyK.textContent = 'RECORDED ON-CHAIN';
      this.info.querySelector('.nb-verify')?.classList.add('is-onchain');
    }
    window.clearInterval(this.tick);
    if (status === 'cooldown') this.tick = window.setInterval(() => this.renderReward(), 1000);
  }

  private statusText(r: RewardState | null): string {
    switch (r?.status) {
      case undefined:
      case 'sending':
        return `RECORDING ON ${NETWORK_LABEL}…`;
      case 'pending':
        return `MINTING ON ${NETWORK_LABEL}…`;
      case 'confirmed':
        return `MINTED · BALANCE ${formatNova(chain.state.balance)}`;
      case 'cooldown':
        return `QUEUED · ARRIVES IN ${Math.max(0, Math.ceil((r.retryAt ?? 0) - Date.now() / 1000))}S`;
      case 'offline':
        return 'REWARDS OFFLINE · RELAYER UNREACHABLE';
      case 'failed':
        return (r.message ?? 'REWARD FAILED').toUpperCase();
    }
  }

  /** Count the amount up from what is shown (900 ms). */
  private countTo(target: bigint): void {
    const from = this.countFrom;
    if (from === target) {
      this.rewardAmt.nodeValue = formatNova(target);
      return;
    }
    this.countFrom = target;
    cancelAnimationFrame(this.countRaf);
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      const e = 1 - (1 - k) ** 3;
      const v = from + ((target - from) * BigInt(Math.round(e * 1000))) / 1000n;
      this.rewardAmt.nodeValue = formatNova(v);
      if (k < 1) this.countRaf = requestAnimationFrame(step);
    };
    step();
  }

  override onShow(): void {
    this.unsub ??= chain.subscribe(() => this.renderReward());
    this.renderReward();
    const chars = this.headline.querySelectorAll<HTMLElement>('.nb-end-ch');
    chars.forEach((ch, i) =>
      play(
        ch,
        [
          { transform: 'translateY(-0.5em) scale(1.8)', opacity: 0 },
          { transform: 'translateY(0) scale(0.95)', opacity: 1, offset: 0.6 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 560, delay: 120 + i * 60, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' },
      ),
    );
    const seq: Array<[Element | null, number]> = [
      [this.subline, 520],
      [this.score, 640],
      [this.mine, 720],
      [this.mvp, 780],
      [this.table.el.parentElement, 880],
      [this.rewardShown ? this.reward : null, 960],
      [this.el.querySelector('.nb-end-foot'), 1000],
    ];
    for (const [el, delay] of seq)
      if (el) play(el, [{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
  }
}
