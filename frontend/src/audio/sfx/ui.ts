/**
 * NOVABALL audio — UI sounds: crisp, short, subtle, in key.
 */
import type { UiSound } from '../../contracts';
import type { Synth } from '../core/synth';
import { bell, noiseBurst, thump } from './gameplay';

const max = Math.max;

export function uiSound(s: Synth, t: number, out: AudioNode, kind: UiSound): number {
  switch (kind) {
    case 'hover': {
      const g = s.gain(0, out);
      s.osc('sine', 2349.3, t, t + 0.2, g);
      s.osc('triangle', 1174.7, t, t + 0.2, s.gain(0.4, g));
      let end = s.perc(g.gain, t, 0.5, 0.001, 0.018);
      end = max(end, noiseBurst(s, t, out, 'highpass', 6500, 0.7, 0.08, 0.0005, 0.002));
      return end;
    }
    case 'click': {
      const g = s.gain(0, out);
      const o = s.osc('sine', 1400, t, t + 0.35, g);
      s.glide(o.frequency, t, 1480, 1170, 0.02);
      let end = s.perc(g.gain, t, 0.7, 0.001, 0.04);
      const g3 = s.gain(0, out);
      s.osc('triangle', 698.5, t, t + 0.2, g3);
      end = max(end, s.perc(g3.gain, t, 0.3, 0.001, 0.02));
      const lp = s.filter('lowpass', 5200, 0.7, out);
      const g2 = s.gain(0, lp);
      s.osc('square', 2960, t, t + 0.06, g2);
      s.perc(g2.gain, t, 0.07, 0.0008, 0.006);
      end = max(end, noiseBurst(s, t, out, 'highpass', 3200, 0.7, 0.16, 0.0005, 0.004));
      return end;
    }
    case 'back': {
      const g = s.gain(0, out);
      const o = s.osc('sine', 1100, t, t + 0.35, g);
      s.sweep(o.frequency, t, 1175, 698, 0.085);
      let end = s.perc(g.gain, t, 0.4, 0.002, 0.04);
      const g2 = s.gain(0, out);
      const o2 = s.osc('triangle', 587, t, t + 0.35, g2);
      s.sweep(o2.frequency, t, 587, 349, 0.085);
      end = max(end, s.perc(g2.gain, t, 0.14, 0.002, 0.04));
      return end;
    }
    case 'start': {
      let end = t;
      const notes = [880, 1108.73, 1318.51, 1760];
      for (let i = 0; i < notes.length; i++) end = max(end, bell(s, t + i * 0.05, out, notes[i], 0.26, 0.1 + i * 0.03, 3.5, 1.3));
      const bp = s.filter('bandpass', 1500, 1.2, out);
      s.sweep(bp.frequency, t, 700, 5200, 0.26);
      const g = s.gain(0, bp);
      s.noise('white', t, 0.7, g);
      end = max(end, s.perc(g.gain, t, 0.24, 0.05, 0.08));
      end = max(end, thump(s, t, out, 95, 48, 0.05, 0.4, 0.09));
      return end;
    }
    case 'toggle': {
      let end = bell(s, t, out, 1318.51, 0.42, 0.035, 2.0, 0.7);
      end = max(end, bell(s, t + 0.045, out, 1760, 0.4, 0.04, 2.0, 0.7));
      return end;
    }
    case 'error':
    default: {
      const lp = s.filter('lowpass', 1300, 0.9, out);
      const g = s.gain(0, lp);
      s.osc('square', 185, t, t + 0.45, g);
      s.osc('square', 196, t, t + 0.45, g);
      s.ahr(g.gain, t, 0.16, 0.004, 0.065, 0.018);
      g.gain.setValueAtTime(0, t + 0.12);
      return s.ahr(g.gain, t + 0.13, 0.16, 0.004, 0.08, 0.025);
    }
  }
}
