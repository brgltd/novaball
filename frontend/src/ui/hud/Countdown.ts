/** Kickoff countdown: huge 3 · 2 · 1 · GO! with slam-in scale/fade and an expanding shock ring. */
import { cancelAnimations, h, play, span } from '../dom';
import { gp, kbd } from '../widgets';

export class Countdown {
  readonly el: HTMLElement;
  private readonly num: HTMLElement;
  private readonly ring: HTMLElement;
  private readonly ring2: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly subText: HTMLElement;
  private value: number | 'GO' | null = null;
  private hideTimer = 0;

  constructor() {
    this.num = span('nb-cd-num', '');
    this.ring = span('nb-cd-ring');
    this.ring2 = span('nb-cd-ring r2');
    this.subText = span('nb-cd-sub-t', 'GET READY');
    // First match only: the three controls that matter at kickoff, instead of "GET READY".
    const item = (kb: HTMLElement, pad: HTMLElement, label: string) =>
      h('span', { class: 'nb-cd-coach-i' }, h('span', { class: 'nb-only-kb' }, kb), h('span', { class: 'nb-only-gp' }, pad), span('', label));
    const coach = h(
      'span',
      { class: 'nb-cd-coach' },
      item(kbd('W'), gp('RT'), 'DRIVE'),
      span('nb-cd-coach-sep', '·'),
      item(kbd('SHIFT', true), gp('B'), 'BOOST'),
      span('nb-cd-coach-sep', '·'),
      item(kbd('SPACE', true), gp('A'), 'JUMP'),
    );
    this.sub = h('span', { class: 'nb-cd-sub' }, this.subText, coach);
    this.el = h('div', { class: 'nb-cd', 'aria-live': 'assertive' }, this.ring, this.ring2, this.num, this.sub);
  }

  get current(): number | 'GO' | null {
    return this.value;
  }

  /** First-match coaching: show the key controls under the count instead of "GET READY". */
  setCoachHint(on: boolean): void {
    if (this.el.classList.contains('is-coach') !== on) this.el.classList.toggle('is-coach', on);
  }

  show(v: number | 'GO' | null): void {
    if (v === this.value) return;
    this.value = v;
    window.clearTimeout(this.hideTimer);
    if (v === null) {
      this.fadeOut(220);
      return;
    }
    const go = v === 'GO';
    this.el.classList.add('is-on');
    this.el.classList.toggle('is-go', go);
    this.num.textContent = go ? 'GO!' : String(v);
    this.num.setAttribute('data-v', go ? 'GO' : String(v));
    this.subText.textContent = go ? 'KICKOFF' : 'GET READY';
    cancelAnimations(this.num);
    cancelAnimations(this.ring);
    cancelAnimations(this.ring2);
    cancelAnimations(this.sub);
    cancelAnimations(this.el);
    this.el.style.opacity = '1';
    if (go) {
      play(
        this.num,
        [
          { transform: 'scale(0.35)', opacity: 0 },
          { transform: 'scale(1.12)', opacity: 1, offset: 0.22 },
          { transform: 'scale(1)', opacity: 1, offset: 0.4 },
          { transform: 'scale(1.04)', opacity: 1, offset: 0.75 },
          { transform: 'scale(1.5)', opacity: 0 },
        ],
        // reduced motion: a static GO! (the container fades it out with the hide timer below)
        { duration: 1100, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'forwards', reduced: [{ transform: 'none', opacity: 1 }, { transform: 'none', opacity: 1 }] },
      );
      play(this.ring, [{ transform: 'scale(0.3)', opacity: 1 }, { transform: 'scale(3.2)', opacity: 0 }], { duration: 750, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'forwards' });
      play(this.ring2, [{ transform: 'scale(0.2)', opacity: 0.9 }, { transform: 'scale(4.4)', opacity: 0 }], { duration: 1000, delay: 90, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'forwards' });
      this.hideTimer = window.setTimeout(() => {
        if (this.value === 'GO') this.fadeOut(200);
      }, 1150);
    } else {
      // Slam in, then hold (the next value — or null — replaces it; never vanish early if the sim is slow).
      play(
        this.num,
        [
          { transform: 'scale(2.3)', opacity: 0 },
          { transform: 'scale(0.94)', opacity: 1, offset: 0.35 },
          { transform: 'scale(1)', opacity: 1, offset: 0.55 },
          { transform: 'scale(1.04)', opacity: 1 },
        ],
        { duration: 700, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'forwards' },
      );
      play(this.ring, [{ transform: 'scale(0.55)', opacity: 0.95 }, { transform: 'scale(1.9)', opacity: 0 }], { duration: 650, delay: 150, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'backwards' });
      play(this.sub, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 120, fill: 'backwards' });
    }
  }

  private fadeOut(ms: number): void {
    const a = play(this.el, [{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: 'forwards', reducedMs: 120 });
    const done = () => {
      if (this.value === null || this.value === 'GO') {
        this.el.classList.remove('is-on', 'is-go');
        cancelAnimations(this.el);
        this.el.style.opacity = '';
      }
    };
    if (a) a.onfinish = done;
    else done();
  }

  reset(): void {
    this.value = null;
    window.clearTimeout(this.hideTimer);
    this.el.classList.remove('is-on', 'is-go');
    cancelAnimations(this.el);
    this.el.style.opacity = '';
  }
}
