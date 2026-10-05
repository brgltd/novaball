/**
 * NOVABALL audio — gameplay one-shot recipes (ball, cars, abilities, charge).
 *
 * Every recipe builds a short-lived node graph into `out` starting at time `t` and returns the time at which it is
 * silent (≈ -60 dB). `P` is a global pitch multiplier (slow-motion). Levels are normalized so that a recipe at full
 * intensity peaks around 1.0 before the per-sound mix gain applied by the AudioSystem.
 */
import type { Synth } from '../core/synth';

const max = Math.max;

// A-minor friendly pitch set used for tonal elements.
const A4 = 440;
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880;
const C6 = 1046.5;
const E6 = 1318.51;
const A6 = 1760;

/** Pitch-dropping sine "thump" (kick-like body). */
export function thump(s: Synth, t: number, out: AudioNode, f0: number, f1: number, dropTau: number, peak: number, tau: number): number {
  const g = s.gain(0, out);
  const o = s.osc('sine', f0, t, t + 0.02 + tau * 7 + 0.02, g);
  s.glide(o.frequency, t, f0, f1, dropTau);
  return s.perc(g.gain, t, peak, 0.0015, tau);
}

/** Filtered noise burst. */
export function noiseBurst(
  s: Synth,
  t: number,
  out: AudioNode,
  type: BiquadFilterType,
  freq: number,
  q: number,
  peak: number,
  attack: number,
  tau: number,
  kind: 'white' | 'pink' | 'brown' | 'crackle' = 'white',
): number {
  const f = s.filter(type, freq, q, out);
  const g = s.gain(0, f);
  const dur = attack + tau * 7 + 0.01;
  s.noise(kind, t, dur, g);
  return s.perc(g.gain, t, peak, attack, tau);
}

/** Glassy FM bell note. */
export function bell(s: Synth, t: number, out: AudioNode, freq: number, peak: number, tau: number, ratio = 3.5, index = 1.6): number {
  const g = s.gain(0, out);
  const end = t + 0.003 + tau * 7;
  s.fm(freq, ratio, index, t, end + 0.01, tau * 0.35, g);
  return s.perc(g.gain, t, peak, 0.003, tau);
}

/** Inharmonic metal partials (bar modes) — clanks. */
function metal(s: Synth, t: number, out: AudioNode, f0: number, peak: number, tauScale: number): number {
  const ratios = [1, 2.76, 5.4, 8.93];
  const amps = [1, 0.55, 0.32, 0.18];
  const taus = [0.12, 0.075, 0.05, 0.03];
  let end = t;
  for (let i = 0; i < 4; i++) {
    const g = s.gain(0, out);
    const tau = taus[i] * tauScale;
    s.osc(i === 0 ? 'triangle' : 'sine', f0 * ratios[i] * s.rng.range(0.985, 1.015), t, t + tau * 7 + 0.02, g);
    end = max(end, s.perc(g.gain, t, peak * amps[i], 0.001, tau));
  }
  return end;
}

// ---------------------------------------------------------------------------------------------
// Ball
// ---------------------------------------------------------------------------------------------

/**
 * Ball hit. k: 0..1 strength. charge: ball charge level after the hit (0..3). dodge: flip hit (extra crunch).
 */
export function ballHit(s: Synth, t: number, out: AudioNode, P: number, k: number, charge: number, dodge: boolean): number {
  const r = s.rng;
  const kk = Math.sqrt(k);
  let end = t;
  // 1) transient snap
  end = max(end, noiseBurst(s, t, out, 'highpass', (2400 + 2600 * k) * P, 0.7, 0.06 + 0.62 * k, 0.0006, 0.005 + 0.004 * k));
  // 2) thump — the "punch"
  end = max(end, thump(s, t, out, (165 + 110 * k) * P, 50 * P, 0.03 + 0.025 * k, 0.12 + 0.88 * Math.pow(k, 0.6), 0.06 + 0.1 * k));
  // 3) body knock (rubbery shell)
  {
    const g = s.gain(0, out);
    const o = s.osc('triangle', 380 * P, t, t + 0.35, g);
    s.glide(o.frequency, t, (360 + 90 * k) * P * r.range(0.97, 1.03), 185 * P, 0.028);
    s.perc(g.gain, t, 0.08 + 0.3 * kk, 0.001, 0.03 + 0.025 * k);
  }
  // 4) mid crack
  noiseBurst(s, t, out, 'bandpass', (1200 + 1100 * k) * P, 1.2, 0.06 + 0.5 * k, 0.001, 0.02 + 0.035 * k);
  // 5) plasma ring — the Nova Core's tonal identity, pitched by charge level (in key)
  {
    const ring = [C5, E5, G5, A5][charge < 0 ? 0 : charge > 3 ? 3 : charge] * P;
    end = max(end, bell(s, t + 0.002, out, ring, 0.06 + 0.12 * k, 0.07 + 0.06 * k, 2.0, 1.0 + 1.8 * k));
  }
  // 6) charged zap — electric sizzle that grows with the charge
  if (charge > 0) {
    const lv = charge > 3 ? 3 : charge;
    const zg = s.gain(0, out);
    const hp = s.filter('highpass', 600 * P, 0.7, zg);
    const car = s.osc('sawtooth', 2800 * P, t, t + 0.3, hp);
    s.sweep(car.frequency, t, (2400 + 700 * lv) * P, 180 * P, 0.07 + 0.02 * lv);
    s.perc(zg.gain, t, 0.08 + 0.07 * lv * (0.4 + 0.6 * k), 0.001, 0.03 + 0.012 * lv);
    end = max(end, noiseBurst(s, t, out, 'highpass', 3200, 0.7, 0.1 + 0.1 * lv, 0.002, 0.04 + 0.05 * lv, 'crackle'));
    if (lv >= 3) {
      end = max(end, thump(s, t, out, 110 * P, 38 * P, 0.07, 0.55, 0.18));
      end = max(end, noiseBurst(s, t + 0.01, out, 'bandpass', 7000, 1.5, 0.22, 0.01, 0.12));
    }
  }
  // 7) dodge crunch — distorted low-mid smack
  if (dodge) {
    const bp = s.filter('bandpass', 850 * P, 0.9, out);
    const g = s.gain(0, bp);
    const sh = s.shaper(s.buf.curveFuzz, g);
    const pre = s.gain(3.5, sh);
    s.noise('white', t, 0.3, pre);
    s.perc(g.gain, t, 0.35 + 0.35 * k, 0.001, 0.045);
    end = max(end, thump(s, t, out, 95 * P, 40 * P, 0.05, 0.45 * kk + 0.1, 0.1));
  }
  return end;
}

/** Ball bounce on the arena. k: 0..1. wall: hit a force-field wall/ceiling (not the floor). */
export function ballBounce(s: Synth, t: number, out: AudioNode, P: number, k: number, wall: boolean): number {
  let end = thump(s, t, out, (95 + 55 * k) * P, 44 * P, 0.035, 0.18 + 0.8 * Math.pow(k, 0.7), 0.05 + 0.06 * k);
  end = max(end, noiseBurst(s, t, out, 'lowpass', (500 + 1400 * k) * P, 0.8, 0.1 + 0.4 * k, 0.001, 0.02 + 0.02 * k, 'pink'));
  if (wall) {
    // Force-field ripple: a bright two-tone "bvvm" plus a short electric crackle.
    const g = s.gain(0, out);
    const a = s.osc('sine', 1180 * P, t, t + 0.5, g);
    const b = s.osc('sine', 1770 * P, t, t + 0.5, g);
    s.glide(a.frequency, t, 1180 * P, 760 * P, 0.06);
    s.glide(b.frequency, t, 1770 * P, 1140 * P, 0.06);
    end = max(end, s.perc(g.gain, t, 0.05 + 0.13 * k, 0.002, 0.06));
    noiseBurst(s, t, out, 'highpass', 2800, 0.7, 0.05 + 0.12 * k, 0.002, 0.03, 'crackle');
  }
  return end;
}

// ---------------------------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------------------------

/** Car slams into the arena (wall/floor/goal). */
export function carImpact(s: Synth, t: number, out: AudioNode, P: number, k: number): number {
  let end = metal(s, t, out, s.rng.range(215, 255) * P, 0.12 + 0.3 * k, 0.6 + 0.8 * k);
  end = max(end, noiseBurst(s, t, out, 'bandpass', 2400 * P, 0.8, 0.12 + 0.35 * k, 0.0008, 0.018 + 0.01 * k));
  end = max(end, thump(s, t, out, 100 * P, 50 * P, 0.03, 0.2 + 0.5 * k, 0.05 + 0.04 * k));
  noiseBurst(s, t, out, 'highpass', 3000, 0.7, 0.04 + 0.1 * k, 0.002, 0.025, 'crackle');
  return end;
}

/** Car–car bump (heavier, crunchier). */
export function carBump(s: Synth, t: number, out: AudioNode, P: number, k: number): number {
  let end = metal(s, t, out, s.rng.range(150, 180) * P, 0.15 + 0.3 * k, 0.8 + 0.8 * k);
  const bp = s.filter('bandpass', 700 * P, 0.8, out);
  const g = s.gain(0, bp);
  const sh = s.shaper(s.buf.curveFuzz, g);
  s.noise('white', t, 0.25, s.gain(2.5, sh));
  end = max(end, s.perc(g.gain, t, 0.25 + 0.4 * k, 0.001, 0.04 + 0.02 * k));
  end = max(end, thump(s, t, out, 85 * P, 42 * P, 0.04, 0.3 + 0.6 * k, 0.07 + 0.05 * k));
  return end;
}

/** Jump: mag-lev kick + air whoosh + rising "fwip". */
export function jump(s: Synth, t: number, out: AudioNode, P: number, double: boolean): number {
  let end = t;
  {
    const bp = s.filter('bandpass', 600, 1.3, out);
    s.sweep(bp.frequency, t, (double ? 900 : 550) * P, (double ? 3400 : 2300) * P, 0.17);
    const g = s.gain(0, bp);
    s.noise('white', t, 0.4, g);
    end = max(end, s.perc(g.gain, t, double ? 1.5 : 1.2, 0.018, 0.065));
  }
  {
    const g = s.gain(0, out);
    const o = s.osc('sine', 250 * P, t, t + 0.3, g);
    s.sweep(o.frequency, t, (double ? 380 : 240) * P, (double ? 820 : 540) * P, 0.075);
    s.perc(g.gain, t, double ? 0.42 : 0.35, 0.004, 0.045);
  }
  if (!double) end = max(end, thump(s, t, out, 105 * P, 55 * P, 0.03, 0.6, 0.05));
  return end;
}

/** Dodge / flip: double swish with a stereo sweep + low "vwoom". fx/rx: dodge direction (forward/right components). */
export function dodge(s: Synth, t: number, out: AudioNode, P: number, rx: number): number {
  let end = t;
  const pn = s.pan(0, out);
  pn.pan.setValueAtTime(-0.35 * rx, t);
  pn.pan.linearRampToValueAtTime(0.35 * rx, t + 0.3);
  for (let i = 0; i < 2; i++) {
    const t0 = t + i * 0.1;
    const bp = s.filter('bandpass', 2000, 1.7, pn);
    s.sweep(bp.frequency, t0, (2800 - i * 400) * P, 650 * P, 0.15);
    const g = s.gain(0, bp);
    s.noise('white', t0, 0.35, g);
    end = max(end, s.perc(g.gain, t0, i === 0 ? 1.3 : 0.85, 0.02, 0.055));
  }
  {
    const g = s.gain(0, out);
    const o = s.osc('sine', 170 * P, t, t + 0.5, g);
    s.sweep(o.frequency, t, 175 * P, 80 * P, 0.16);
    end = max(end, s.perc(g.gain, t, 0.45, 0.01, 0.07));
  }
  return end;
}

/** Landing: soft thump + hover field re-engaging. k: 0..1 by impact speed. */
export function land(s: Synth, t: number, out: AudioNode, P: number, k: number): number {
  let end = thump(s, t, out, 88 * P, 48 * P, 0.03, 0.15 + 0.55 * Math.pow(k, 0.6), 0.045 + 0.04 * k);
  end = max(end, noiseBurst(s, t, out, 'lowpass', 480 * P, 0.7, 0.1 + 0.3 * k, 0.002, 0.025, 'pink'));
  {
    const lp = s.filter('lowpass', 420 * P, 2, out);
    const g = s.gain(0, lp);
    s.osc('sawtooth', 112 * P, t, t + 0.4, g);
    end = max(end, s.perc(g.gain, t + 0.01, 0.1 + 0.08 * k, 0.012, 0.05));
  }
  return end;
}

/** Boost pickup: rising chime (small) or power-up arpeggio + charge whoomp (big). */
export function boostPickup(s: Synth, t: number, out: AudioNode, P: number, big: boolean): number {
  let end = t;
  if (!big) {
    end = max(end, bell(s, t, out, E6 * P, 0.32, 0.06, 3.0, 1.2));
    end = max(end, bell(s, t + 0.045, out, A6 * P, 0.36, 0.08, 3.0, 1.2));
    const bp = s.filter('bandpass', 4000, 1.5, out);
    s.sweep(bp.frequency, t, 3000, 9000, 0.09);
    const g = s.gain(0, bp);
    s.noise('white', t, 0.2, g);
    end = max(end, s.perc(g.gain, t, 0.14, 0.01, 0.03));
    return end;
  }
  const notes = [A5, C6, E6, A6];
  for (let i = 0; i < notes.length; i++) end = max(end, bell(s, t + i * 0.036, out, notes[i] * P, 0.3, 0.1 + i * 0.02, 3.0, 1.3));
  {
    // "charging" whoomp
    const g = s.gain(0, out);
    const o = s.osc('sine', 55 * P, t, t + 0.9, g);
    s.sweep(o.frequency, t, 55 * P, 118 * P, 0.24);
    end = max(end, s.perc(g.gain, t, 0.5, 0.025, 0.11));
  }
  {
    // power stab: A power chord through an opening filter
    const lp = s.filter('lowpass', 400, 3, out);
    s.sweep(lp.frequency, t, 380, 3800, 0.2);
    const g = s.gain(0, lp);
    s.osc('sawtooth', 220 * P, t, t + 1.2, g, -8);
    s.osc('sawtooth', 329.63 * P, t, t + 1.2, g, 8);
    end = max(end, s.perc(g.gain, t, 0.12, 0.01, 0.13));
  }
  const bp = s.filter('bandpass', 6500, 2.2, out);
  const g = s.gain(0, bp);
  s.noise('white', t, 1.0, g);
  end = max(end, s.swell(g.gain, t, 0.22, 0.09, 0.14));
  return end;
}

/** Demolition explosion: crack, fuzzy blast with a closing filter, sub boom, debris crackle, metal ring. */
export function demolish(s: Synth, t: number, out: AudioNode, P: number): number {
  let end = noiseBurst(s, t, out, 'highpass', 1800, 0.7, 0.8, 0.0005, 0.012);
  {
    const lp = s.filter('lowpass', 6000, 0.9, out);
    lp.frequency.setValueAtTime(6500 * P, t);
    lp.frequency.setTargetAtTime(240 * P, t + 0.01, 0.17);
    const g = s.gain(0, lp);
    const sh = s.shaper(s.buf.curveFuzz, g);
    s.noise('white', t, 2.4, s.gain(1.8, sh));
    end = max(end, s.perc(g.gain, t, 0.85, 0.003, 0.3));
  }
  end = max(end, thump(s, t, out, 92 * P, 30 * P, 0.22, 1.0, 0.4));
  {
    const bp = s.filter('bandpass', 2800, 0.7, out);
    const g = s.gain(0, bp);
    s.noise('crackle', t + 0.04, 1.8, g, 0.9);
    end = max(end, s.ahr(g.gain, t + 0.04, 0.55, 0.05, 0.18, 0.3));
  }
  end = max(end, metal(s, t + 0.01, out, 175 * P, 0.22, 2.4));
  return end;
}

/** Respawn: resonant rising materialize sweep, shimmer, sparkle ping. */
export function respawn(s: Synth, t: number, out: AudioNode, P: number): number {
  let end = t;
  {
    const lp = s.filter('lowpass', 300, 9, out);
    s.sweep(lp.frequency, t, 280 * P, 5200 * P, 0.55);
    const g = s.gain(0, lp);
    const o = s.osc('sawtooth', 110 * P, t, t + 1.2, g);
    s.sweep(o.frequency, t, 110 * P, 440 * P, 0.55);
    end = max(end, s.swell(g.gain, t, 0.3, 0.5, 0.07));
  }
  {
    const bp = s.filter('bandpass', 6000, 3, out);
    const g = s.gain(0, bp);
    s.noise('white', t, 1.0, g);
    end = max(end, s.swell(g.gain, t, 0.25, 0.5, 0.08));
  }
  end = max(end, bell(s, t + 0.5, out, E6 * P, 0.28, 0.16, 2.0, 1.5));
  return end;
}

/** NOVA PULSE: sub drop, whump, expanding shimmer sweep, metallic "shwing". */
export function pulse(s: Synth, t: number, out: AudioNode, P: number, hitBall: boolean, hitCars: boolean): number {
  let end = thump(s, t, out, 155 * P, 33 * P, 0.14, 1.0, 0.27);
  {
    const lp = s.filter('lowpass', 1800, 1.2, out);
    s.sweep(lp.frequency, t, 2000 * P, 150 * P, 0.32);
    const g = s.gain(0, lp);
    s.noise('white', t, 0.9, g);
    end = max(end, s.perc(g.gain, t, 0.6, 0.004, 0.11));
  }
  {
    const bp = s.filter('bandpass', 7000, 2.6, out);
    s.sweep(bp.frequency, t, 7500 * P, 1100 * P, 0.45);
    const g = s.gain(0, bp);
    s.noise('white', t, 1.1, g);
    end = max(end, s.perc(g.gain, t, 0.42, 0.012, 0.15));
  }
  end = max(end, bell(s, t, out, 440 * P, 0.2, 0.2, 1.41, 3.2));
  if (hitBall) end = max(end, thump(s, t + 0.012, out, 210 * P, 62 * P, 0.03, 0.5, 0.09));
  if (hitCars) end = max(end, metal(s, t + 0.02, out, 200 * P, 0.14, 1.1));
  return end;
}

// ---------------------------------------------------------------------------------------------
// CORE CHARGE
// ---------------------------------------------------------------------------------------------

/** Charge rose to level 1 or 2. friendly: the charge belongs to the listener's team (brighter, higher). */
export function chargeUp(s: Synth, t: number, out: AudioNode, level: number, friendly: boolean): number {
  // Friendly: ascending (reward). Opponent: descending minor motif (threat).
  const seq = friendly ? (level >= 2 ? [C6, E6, A6] : [A5, E6]) : level >= 2 ? [E5, C5, A4] : [E5, C5];
  let end = t;
  const lp = friendly ? out : s.filter('lowpass', 2600, 0.7, out);
  for (let i = 0; i < seq.length; i++) {
    end = max(end, bell(s, t + i * 0.055, lp, seq[i], 0.34, 0.11 + 0.03 * i, friendly ? 3.5 : 2.0, friendly ? 1.6 : 1.1));
    // soft octave shimmer
    end = max(end, bell(s, t + i * 0.055 + 0.004, lp, seq[i] * 2, 0.07, 0.07, 2.0, 0.5));
  }
  return end;
}

/** SUPERNOVA (charge 3): impact + chord stab + rising shimmer + crackle. */
export function supernova(s: Synth, t: number, out: AudioNode, friendly: boolean): number {
  let end = thump(s, t, out, 120, 38, 0.16, 0.9, 0.42);
  {
    // A major (friendly: triumphant) or A minor (threat) stab through an opening filter.
    const chord = friendly ? [220, 277.18, 329.63, 440] : [220, 261.63, 329.63, 440];
    const lp = s.filter('lowpass', 700, 2.5, out);
    s.sweep(lp.frequency, t, 700, 5200, 0.25);
    const g = s.gain(0, lp);
    for (const f of chord) {
      s.osc('sawtooth', f, t, t + 2.6, g, -9);
      s.osc('sawtooth', f, t, t + 2.6, g, 9);
    }
    end = max(end, s.ahr(g.gain, t, 0.12, 0.008, 0.2, 0.32));
  }
  {
    const bp = s.filter('bandpass', 2000, 4, out);
    s.sweep(bp.frequency, t, 1800, 9500, 1.2);
    const g = s.gain(0, bp);
    s.noise('white', t, 1.6, g);
    end = max(end, s.swell(g.gain, t, 0.4, 1.05, 0.12));
  }
  {
    const lp = s.filter('lowpass', 1500, 1, out);
    const g = s.gain(0, lp);
    const o = s.osc('sawtooth', 220, t, t + 1.6, g);
    s.sweep(o.frequency, t, 220, 880, 1.1);
    end = max(end, s.swell(g.gain, t, 0.08, 1.05, 0.1));
  }
  end = max(end, noiseBurst(s, t, out, 'highpass', 3000, 0.7, 0.35, 0.004, 0.28, 'crackle'));
  return end;
}

/** Charge decayed one level (same team). */
export function chargeDown(s: Synth, t: number, out: AudioNode): number {
  const lp = s.filter('lowpass', 2400, 0.7, out);
  let end = bell(s, t, lp, E6, 0.18, 0.07, 2.0, 0.8);
  end = max(end, bell(s, t + 0.07, lp, C6, 0.16, 0.09, 2.0, 0.8));
  return end;
}

/** Charge stolen by the other team (reset to level 1 for them). friendlyNow: the listener's team now owns it. */
export function chargeSteal(s: Synth, t: number, out: AudioNode, friendlyNow: boolean): number {
  let end = t;
  {
    const bp = s.filter('bandpass', 3000, 1.6, out);
    s.sweep(bp.frequency, t, friendlyNow ? 700 : 3200, friendlyNow ? 3200 : 600, 0.2);
    const g = s.gain(0, bp);
    s.noise('white', t, 0.45, g);
    end = max(end, s.perc(g.gain, t, 0.4, 0.02, 0.06));
  }
  end = max(end, bell(s, t + 0.03, out, friendlyNow ? A5 : A4, 0.26, 0.1, friendlyNow ? 3.5 : 1.5, 1.4));
  end = max(end, noiseBurst(s, t, out, 'highpass', 3500, 0.7, 0.14, 0.003, 0.05, 'crackle'));
  return end;
}

/** Charge fully lost (neutral again): power-down. */
export function chargeLost(s: Synth, t: number, out: AudioNode): number {
  const lp = s.filter('lowpass', 2000, 1, out);
  const g = s.gain(0, lp);
  const o = s.osc('sine', 880, t, t + 0.8, g);
  s.sweep(o.frequency, t, 880, 200, 0.32);
  let end = s.perc(g.gain, t, 0.25, 0.005, 0.1);
  end = max(end, noiseBurst(s, t, out, 'bandpass', 1500, 1, 0.08, 0.01, 0.08, 'pink'));
  return end;
}

// ---------------------------------------------------------------------------------------------
// Player-state feedback (triggered by state transitions in AudioSystem.update)
// ---------------------------------------------------------------------------------------------

/** Boost ignition "fwoomp". */
export function boostIgnite(s: Synth, t: number, out: AudioNode, P: number): number {
  const lp = s.filter('lowpass', 300, 1.5, out);
  s.sweep(lp.frequency, t, 280 * P, 2600 * P, 0.12);
  const g = s.gain(0, lp);
  s.noise('white', t, 0.6, g);
  let end = s.perc(g.gain, t, 0.5, 0.012, 0.085);
  {
    const g2 = s.gain(0, out);
    const o = s.osc('sine', 60 * P, t, t + 0.5, g2);
    s.sweep(o.frequency, t, 58 * P, 112 * P, 0.1);
    end = max(end, s.perc(g2.gain, t, 0.4, 0.006, 0.075));
  }
  return end;
}

/** Crossing into supersonic: whoosh-pop with a high "tear". */
export function sonicBoom(s: Synth, t: number, out: AudioNode, P: number): number {
  const bp = s.filter('bandpass', 500, 1.1, out);
  s.sweep(bp.frequency, t, 420 * P, 3400 * P, 0.16);
  const g = s.gain(0, bp);
  s.noise('white', t, 0.8, g);
  let end = s.perc(g.gain, t, 0.45, 0.03, 0.09);
  end = max(end, thump(s, t + 0.03, out, 130 * P, 58 * P, 0.03, 0.35, 0.05));
  end = max(end, noiseBurst(s, t + 0.02, out, 'highpass', 6500, 0.7, 0.16, 0.01, 0.08));
  return end;
}

/** NOVA PULSE ready again. */
export function pulseReady(s: Synth, t: number, out: AudioNode): number {
  let end = bell(s, t, out, A6, 0.16, 0.12, 3.5, 1.2);
  end = max(end, bell(s, t + 0.06, out, E6 * 2, 0.1, 0.14, 3.5, 1.0));
  end = max(end, noiseBurst(s, t, out, 'bandpass', 8500, 2, 0.08, 0.004, 0.04));
  return end;
}
