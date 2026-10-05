/**
 * NOVABALL audio — match-level event recipes: goal explosion, stadium horns, euphoric goal swell, countdown,
 * zero-G surge alarm / start / end, clock ticks, replay whooshes.
 * Same conventions as gameplay.ts: build into `out` at time `t`, return the silent end time.
 */
import type { Synth } from '../core/synth';
import { bell, noiseBurst, thump } from './gameplay';

const max = Math.max;

/** Goal explosion. size: 0..1 (points / charge), supernova adds a massive shimmering tail. */
export function goalBoom(s: Synth, t: number, out: AudioNode, size: number, supernova: boolean): number {
  let end = noiseBurst(s, t, out, 'highpass', 1500, 0.7, 1.0, 0.0005, 0.02);
  {
    // Main blast: fuzzy noise through a closing low-pass.
    const lp = s.filter('lowpass', 8000, 0.8, out);
    lp.frequency.setValueAtTime(8500, t);
    lp.frequency.setTargetAtTime(170, t + 0.02, 0.3);
    const g = s.gain(0, lp);
    const sh = s.shaper(s.buf.curveFuzz, g);
    s.noise('white', t, 3.6, s.gain(1.6, sh));
    end = max(end, s.perc(g.gain, t, 0.95, 0.004, 0.45 + 0.2 * size));
  }
  end = max(end, thump(s, t, out, 78, 27, 0.35, 1.0, 0.6 + 0.25 * size));
  end = max(end, thump(s, t + 0.035, out, 56, 30, 0.3, 0.7, 0.5));
  {
    // Embers: crackle tail.
    const bp = s.filter('bandpass', 4200, 0.8, out);
    const g = s.gain(0, bp);
    s.noise('crackle', t + 0.1, 3.4, g, 1.1);
    end = max(end, s.ahr(g.gain, t + 0.1, 0.3 + 0.15 * size, 0.2, 0.5, 0.5));
  }
  if (supernova) {
    const bp = s.filter('bandpass', 3000, 3, out);
    s.sweep(bp.frequency, t, 2500, 11000, 1.6);
    const g = s.gain(0, bp);
    s.noise('white', t, 4, g);
    end = max(end, s.ahr(g.gain, t, 0.3, 0.3, 0.6, 0.55));
    end = max(end, thump(s, t + 0.08, out, 45, 24, 0.5, 0.8, 0.9));
  }
  return end;
}

/**
 * Stadium air horn. chord: frequencies (Hz). blasts: [start offset, duration] pairs.
 */
export function horn(s: Synth, t: number, out: AudioNode, chord: ReadonlyArray<number>, blasts: ReadonlyArray<readonly [number, number]>, peak = 0.5): number {
  let end = t;
  for (const [off, dur] of blasts) {
    const t0 = t + off;
    const lp = s.filter('lowpass', 400, 2.2, out);
    lp.frequency.setValueAtTime(350, t0);
    lp.frequency.linearRampToValueAtTime(2400, t0 + 0.07);
    lp.frequency.setTargetAtTime(1500, t0 + 0.07, 0.15);
    const g = s.gain(0, lp);
    const stop = t0 + dur + 0.9;
    for (let i = 0; i < chord.length; i++) {
      const f = chord[i];
      for (const det of [-7, 7]) {
        const o = s.osc('sawtooth', f, t0, stop, g, det + s.rng.spread(3));
        // Air-pressure "blat": pitch settles up into tune.
        o.frequency.setValueAtTime(f * 0.93, t0);
        o.frequency.setTargetAtTime(f, t0, 0.03);
      }
    }
    const nb = s.filter('bandpass', 1300, 0.8, g);
    const ng = s.gain(0.05, nb);
    s.noise('white', t0, dur + 0.9, ng);
    end = max(end, s.ahr(g.gain, t0, peak / Math.sqrt(chord.length), 0.05, dur, 0.12));
  }
  return end;
}

export const HORN_CHORDS = {
  /** VOLT: bright A major power horn. */
  volt: [110, 164.81, 220, 277.18] as const,
  /** BLAZE: darker G minor horn. */
  blaze: [98, 146.83, 196, 233.08] as const,
  /** Neutral (overtime / final): A power chord. */
  neutral: [110, 164.81, 220, 329.63] as const,
};

/** Euphoric goal swell for the listener's team: A-major pad bloom + sparkling arpeggio. */
export function euphoria(s: Synth, t: number, out: AudioNode): number {
  let end = t;
  {
    const lp = s.filter('lowpass', 600, 1.2, out);
    s.sweep(lp.frequency, t, 600, 6500, 0.9);
    const g = s.gain(0, lp);
    for (const f of [220, 277.18, 329.63, 440, 554.37]) {
      s.osc('sawtooth', f, t, t + 4.5, g, -11);
      s.osc('sawtooth', f, t, t + 4.5, g, 11);
    }
    end = max(end, s.ahr(g.gain, t, 0.07, 0.35, 1.4, 0.45));
  }
  const arp = [880, 1108.73, 1318.51, 1760, 2217.46, 2637.02];
  for (let i = 0; i < arp.length; i++) end = max(end, bell(s, t + 0.12 + i * 0.07, out, arp[i], 0.14, 0.2, 3.5, 1.2));
  return end;
}

/** Disappointment for the listener's team conceding: low descending minor tones. */
export function concede(s: Synth, t: number, out: AudioNode): number {
  const lp = s.filter('lowpass', 900, 0.7, out);
  const g = s.gain(0, lp);
  const a = s.osc('triangle', 220, t, t + 2.4, g);
  const b = s.osc('triangle', 261.63, t, t + 2.4, g);
  s.sweep(a.frequency, t + 0.25, 220, 207.65, 0.5);
  s.sweep(b.frequency, t + 0.25, 261.63, 246.94, 0.5);
  return s.ahr(g.gain, t, 0.22, 0.08, 0.7, 0.3);
}

/** Countdown beep (3-2-1) or GO. */
export function countdownBeep(s: Synth, t: number, out: AudioNode, go: boolean): number {
  const f = go ? 1760 : 880;
  const hold = go ? 0.42 : 0.1;
  let end = t;
  {
    const g = s.gain(0, out);
    s.osc('sine', f, t, t + hold + 1, g);
    end = max(end, s.ahr(g.gain, t, 0.5, 0.004, hold, go ? 0.14 : 0.045));
  }
  {
    const lp = s.filter('lowpass', go ? 5000 : 3500, 0.7, out);
    const g = s.gain(0, lp);
    s.osc('square', f, t, t + hold + 1, g);
    s.ahr(g.gain, t, 0.08, 0.004, hold, go ? 0.12 : 0.04);
  }
  if (go) {
    const g = s.gain(0, out);
    s.osc('sine', 880, t, t + 1.4, g);
    s.ahr(g.gain, t, 0.3, 0.004, hold, 0.16);
    const bp = s.filter('bandpass', 2500, 0.9, out);
    s.sweep(bp.frequency, t, 1200, 6000, 0.3);
    const ng = s.gain(0, bp);
    s.noise('white', t, 0.9, ng);
    end = max(end, s.perc(ng.gain, t, 0.3, 0.03, 0.12));
    end = max(end, thump(s, t, out, 110, 45, 0.05, 0.5, 0.1));
  }
  return end;
}

/** ZERO-G SURGE warning: three rising sci-fi "whoops" of increasing intensity over a building rumble. */
export function surgeAlarm(s: Synth, t: number, out: AudioNode, seconds: number): number {
  const n = Math.max(1, Math.min(5, Math.round(seconds)));
  let end = t;
  for (let i = 0; i < n; i++) {
    const t0 = t + i;
    const lp = s.filter('lowpass', 2600, 3.5, out);
    const g = s.gain(0, lp);
    const o = s.osc('sawtooth', 330, t0, t0 + 1.2, g);
    s.sweep(o.frequency, t0, 330, 880, 0.5);
    const o2 = s.osc('square', 331, t0, t0 + 1.2, g);
    s.sweep(o2.frequency, t0, 331, 882, 0.5);
    end = max(end, s.ahr(g.gain, t0, 0.14 + 0.1 * (i / Math.max(1, n - 1)), 0.02, 0.45, 0.06));
  }
  {
    const lp = s.filter('lowpass', 140, 1, out);
    const g = s.gain(0, lp);
    s.noise('brown', t, n + 1.2, g);
    end = max(end, s.swell(g.gain, t, 0.9, n, 0.25));
  }
  {
    // Pulsing sub (6 Hz tremolo).
    const g = s.gain(0, out);
    const trem = s.gain(0.6, g);
    s.osc('sine', 55, t, t + n + 1.5, trem);
    const depth = s.gain(0.4, trem.gain);
    s.osc('sine', 6, t, t + n + 1.5, depth);
    end = max(end, s.swell(g.gain, t, 0.35, n, 0.2));
  }
  return end;
}

/** Surge begins: gravity drops — whoomp + falling sweep + airy swell. */
export function surgeStart(s: Synth, t: number, out: AudioNode): number {
  let end = thump(s, t, out, 125, 30, 0.28, 1.0, 0.5);
  {
    const g = s.gain(0, out);
    const o = s.osc('sine', 800, t, t + 1.8, g);
    s.sweep(o.frequency, t, 900, 60, 0.9);
    end = max(end, s.perc(g.gain, t, 0.22, 0.01, 0.3));
  }
  {
    const lp = s.filter('lowpass', 3000, 1.5, out);
    s.sweep(lp.frequency, t, 3200, 350, 1.2);
    const g = s.gain(0, lp);
    for (const f of [220, 261.63, 329.63, 493.88]) {
      s.osc('sawtooth', f, t, t + 3, g, -10);
      s.osc('sawtooth', f, t, t + 3, g, 10);
    }
    end = max(end, s.ahr(g.gain, t, 0.06, 0.05, 0.6, 0.4));
  }
  end = max(end, noiseBurst(s, t, out, 'lowpass', 900, 0.7, 0.5, 0.01, 0.2, 'pink'));
  return end;
}

/** Surge ends: gravity returns — rising sweep into a thud. */
export function surgeEnd(s: Synth, t: number, out: AudioNode): number {
  let end = t;
  {
    const g = s.gain(0, out);
    const o = s.osc('sine', 60, t, t + 1, g);
    s.sweep(o.frequency, t, 60, 620, 0.45);
    end = max(end, s.swell(g.gain, t, 0.2, 0.42, 0.04));
  }
  {
    const bp = s.filter('bandpass', 800, 1, out);
    s.sweep(bp.frequency, t, 400, 3000, 0.45);
    const g = s.gain(0, bp);
    s.noise('white', t, 0.8, g);
    end = max(end, s.swell(g.gain, t, 0.3, 0.42, 0.05));
  }
  end = max(end, thump(s, t + 0.45, out, 110, 40, 0.06, 0.8, 0.14));
  return end;
}

/** Final-seconds clock tick. urgent: last 3 seconds. */
export function clockTick(s: Synth, t: number, out: AudioNode, urgent: boolean): number {
  const f = urgent ? 2093 : 1568;
  let end = bell(s, t, out, f, urgent ? 0.75 : 0.6, urgent ? 0.06 : 0.045, 2.0, 0.6);
  end = max(end, bell(s, t, out, f / 2, 0.25, 0.03, 1.0, 0.3));
  end = max(end, noiseBurst(s, t, out, 'highpass', 4000, 0.7, 0.25, 0.0005, 0.005));
  if (urgent) end = max(end, thump(s, t, out, 180, 90, 0.02, 0.45, 0.05));
  return end;
}

/** Replay "rewind" whoosh (start) or the reverse (end). */
export function replayWhoosh(s: Synth, t: number, out: AudioNode, start: boolean): number {
  let end = t;
  {
    const bp = s.filter('bandpass', 1000, 2, out);
    if (start) s.sweep(bp.frequency, t, 4500, 280, 0.55);
    else s.sweep(bp.frequency, t, 280, 4500, 0.5);
    const g = s.gain(0, bp);
    s.noise('white', t, 1, g);
    end = max(end, start ? s.perc(g.gain, t, 1.3, 0.05, 0.15) : s.swell(g.gain, t, 0.4, 0.45, 0.06));
  }
  {
    const lp = s.filter('lowpass', 2500, 2, out);
    const g = s.gain(0, lp);
    const o = s.osc('sawtooth', 600, t, t + 1.2, g);
    if (start) s.sweep(o.frequency, t, 900, 90, 0.55);
    else s.sweep(o.frequency, t, 90, 900, 0.5);
    end = max(end, start ? s.perc(g.gain, t, 0.12, 0.02, 0.15) : s.swell(g.gain, t, 0.12, 0.45, 0.05));
  }
  if (!start) end = max(end, thump(s, t + 0.47, out, 100, 45, 0.05, 0.4, 0.1));
  return end;
}
