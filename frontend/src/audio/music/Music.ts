/**
 * NOVABALL music — procedural synthwave sequencer.
 *
 * Lookahead scheduler: `pump(until)` schedules every 16th-note step whose time falls before `until` using
 * AudioContext time (sample-accurate), so timer jitter never affects the groove. The AudioSystem calls pump from
 * a 25 ms interval AND from every frame, with ~0.2 s of lookahead.
 *
 * States: menu (atmospheric), match (full groove, layers by intensity), overtime (faster, urgent),
 * victory / defeat (stinger, then a short loop). State changes are quantized to the next bar.
 */
import type { MusicState, Stinger } from '../../contracts';
import type { Synth } from '../core/synth';
import { Rng, clamp01, lerp } from '../core/util';
import { noiseBurst, thump } from '../sfx/gameplay';
import { MusicRig, type LeadVoice, type LongVoice } from './instruments';
import { SONGS, drumVel, type ChordDef, type SectionDef, type SongDef } from './songs';
import type { AudioGraph } from '../core/graph';

type SongKey = keyof typeof SONGS;

export class Music {
  readonly rig: MusicRig;
  private state: MusicState = 'off';
  private song: SongDef | null = null;
  private running = false;
  private pending: MusicState | null = null;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private section = 0;
  private cycle = 0;
  private stepDur = 0.125;
  private intensityTarget = 0;
  private barIntensity = 0;
  private barTier = 0;
  private breakdownNow = false;
  private padUntil = -1;
  private padChord: ChordDef | null = null;
  private prevSectionFill = false;
  private readonly longVoices: LongVoice[] = [];
  /** Current section's lead line (notes are scheduled step by step to spread the main-thread cost). */
  private lead: { voice: LeadVoice; melody: ReadonlyArray<readonly [number, number, number]>; idx: number } | null = null;
  /** Context time when the music was switched off (-1 = n/a). */
  private offAt = -1;
  private lastStinger: Stinger | null = null;
  private lastStingerTime = -10;
  private lastStingerEnd = -10;
  private readonly rng = new Rng(0x5eed);
  /** Velocity humanization (±6 %). */
  private readonly hum = (): number => 1 + this.rng.spread(0.06);
  /** Diagnostics. */
  stepsScheduled = 0;
  stepsSkipped = 0;

  constructor(
    private readonly s: Synth,
    graph: AudioGraph,
  ) {
    this.rig = new MusicRig(s, graph);
  }

  get currentState(): MusicState {
    return this.state;
  }

  get info(): { state: MusicState; section: number; bar: number; tier: number; bpm: number; intensity: number } {
    return { state: this.state, section: this.section, bar: this.bar, tier: this.barTier, bpm: this.song?.bpm ?? 0, intensity: this.barIntensity };
  }

  setIntensity(x: number): void {
    this.intensityTarget = clamp01(Number.isFinite(x) ? x : 0);
  }

  setState(next: MusicState): void {
    if (next === this.state) {
      this.pending = null;
      if (next === 'off' || this.running) return;
    }
    const now = this.s.now;
    if (next === 'off') {
      this.pending = null;
      this.state = 'off';
      this.rig.fadeGate(0, now, 0.35);
      this.releaseAll(now + 0.05, 0.4);
      this.running = false;
      this.offAt = now;
      return;
    }
    if (next === 'victory' || next === 'defeat') {
      const recent = this.lastStinger === next && now - this.lastStingerTime < 3;
      const stEnd = recent ? this.lastStingerEnd : this.stinger(next);
      this.rig.fadeGate(0, now, 0.2);
      this.releaseAll(now + 0.02, 0.3);
      this.startSong(next, Math.max(now + 0.1, stEnd - 0.9), 0.6);
      return;
    }
    if (!this.running) {
      this.startSong(next, now + 0.06, next === 'menu' ? 0.4 : 0.02);
      return;
    }
    this.pending = next;
  }

  private startSong(key: SongKey, at: number, fadeTau: number): void {
    const song = SONGS[key];
    this.state = key;
    this.song = song;
    this.stepDur = 15 / song.bpm;
    this.nextTime = at;
    this.step = 0;
    this.bar = 0;
    this.section = 0;
    this.cycle = 0;
    this.padUntil = -1;
    this.padChord = null;
    this.prevSectionFill = key === 'match' || key === 'overtime';
    this.running = true;
    this.pending = null;
    this.offAt = -1;
    this.rig.setActive(true);
    this.rig.setTempo(song.bpm, at);
    this.rig.fadeGate(song.gain, at, fadeTau);
  }

  private releaseAll(t: number, tau: number): void {
    for (const v of this.longVoices) if (v.end > t) this.rig.release(v, t, tau);
    this.longVoices.length = 0;
    this.lead = null;
    this.rig.silenceMono(t);
    this.padUntil = -1;
    this.padChord = null;
  }

  /** Schedule everything up to context time `until`. */
  pump(until: number): void {
    const now = this.s.now;
    if (!this.running || !this.song) {
      // Once faded out, detach the whole song subgraph (no DSP while the music is off).
      if (this.offAt >= 0 && now > this.offAt + 2.5) {
        this.offAt = -1;
        this.rig.setActive(false);
      }
      return;
    }
    // Stalled main thread (long hitch): drop the missed steps but keep the musical position.
    if (this.nextTime < now - 0.02) {
      while (this.nextTime < now + 0.01) {
        this.advance();
        this.stepsSkipped++;
      }
      this.padUntil = -1;
    }
    let guard = 0;
    while (this.running && this.nextTime < until && guard++ < 64) {
      if (this.step === 0 && this.pending) {
        const next = this.pending;
        this.pending = null;
        this.releaseAll(this.nextTime, 0.3);
        this.startSong(next as SongKey, this.nextTime, 0.02);
      }
      this.scheduleStep(this.nextTime);
      this.stepsScheduled++;
      this.advance();
    }
    // Housekeeping: forget finished long voices.
    for (let i = this.longVoices.length - 1; i >= 0; i--) if (this.longVoices[i].end < now) this.longVoices.splice(i, 1);
  }

  private advance(): void {
    const song = this.song;
    if (!song) return;
    this.nextTime += this.stepDur;
    this.step++;
    if (this.step >= 16) {
      this.step = 0;
      this.bar++;
      const sec = song.sections[this.section];
      if (this.bar >= sec.chords.length) {
        this.prevSectionFill = !!sec.fill;
        this.bar = 0;
        this.section++;
        if (this.section >= song.sections.length) {
          this.section = 0;
          this.cycle++;
        }
      }
    }
  }

  private scheduleStep(t: number): void {
    const song = this.song!;
    const st = song.style;
    const sec = song.sections[this.section];
    const step = this.step;
    if (step === 0) this.beginBar(t, song, sec);
    const tier = this.barTier;
    const I = this.barIntensity;
    const chord = sec.chords[this.bar];
    const r = this.rng;
    const hum = this.hum;
    const fillBar = !!sec.fill && this.bar === sec.chords.length - 1 && tier >= 1;
    const fillZone = fillBar && step >= 12;
    const hasDrums = st.kick[tier].indexOf('X') >= 0;

    // ---- drums ----
    if (!this.breakdownNow && !fillZone) {
      const kv = drumVel(st.kick[tier], step);
      if (kv) {
        this.rig.kick(t, kv * hum());
        this.rig.pumpAt(t, st.pump[tier]);
      }
    }
    if (fillZone && hasDrums) {
      this.rig.snare(t, (0.45 + (step - 12) * 0.17) * hum());
      if (step === 15) this.rig.kick(t, 0.8);
    } else {
      const sv = drumVel(st.snare[tier], step);
      if (sv) this.rig.snare(t, sv * hum());
      if (fillBar && st.toms && step >= 8 && step < 12 && (step & 1) === 0) this.rig.tom(t, 0.8, step === 8 ? 196 : 147);
    }
    // ---- lead (notes of the current section starting on this step) ----
    const ld = this.lead;
    if (ld) {
      const secStep = this.bar * 16 + step;
      const t0 = t - secStep * this.stepDur;
      while (ld.idx < ld.melody.length && ld.melody[ld.idx][0] <= secStep) {
        const [stp, midi, len] = ld.melody[ld.idx];
        const nx = ld.melody[ld.idx + 1];
        if (stp === secStep) {
          this.rig.leadNote(ld.voice, t, midi, len * this.stepDur * 0.94, 0.92 + this.rng.spread(0.06), nx ? t0 + nx[0] * this.stepDur : -1);
        }
        ld.idx++;
      }
    }

    const cv = drumVel(st.clap[tier], step);
    if (cv && !fillZone) this.rig.clap(t, cv * hum());
    const hv = drumVel(st.hat[tier], step);
    if (hv) this.rig.hat(t, hv * hum(), false);
    const ov = drumVel(st.ohat[tier], step);
    if (ov) this.rig.hat(t, ov * hum(), true);

    // ---- bass ----
    if (!this.breakdownNow) {
      const pat = st.bass[tier];
      const c = pat.charCodeAt(step);
      // '.' 46, '~' 126
      if (c !== 46 && c !== 126) {
        let n = 1;
        while (step + n < 16 && pat.charCodeAt(step + n) === 126) n++;
        const gap = step + n < 16 && pat.charCodeAt(step + n) === 46 ? 0.6 : 0;
        const dur = (n + gap) * this.stepDur * 0.92;
        const up = c === 79 || c === 111 ? 12 : c === 70 || c === 102 ? 7 : 0; // O/o, F/f
        const loud = c === 82 || c === 79 || c === 70; // R, O, F
        const vel = (loud ? 1 : 0.72) * hum();
        const note = chord.bass + up;
        if (st.subBass) this.rig.subBass(t, note, vel, dur);
        else this.rig.bass(t, note, vel, dur, 0.35 + 0.65 * I);
      }
    }

    // ---- arp ----
    const ap = st.arp[tier];
    if (ap) {
      let idx = ap[step];
      if (idx >= 0) {
        // Variation: mirrored arp contour in the second half of the arrangement (alternating every cycle).
        if (song.id === 'match' && (this.section >= 4) !== ((this.cycle & 1) === 1)) idx = 5 - idx;
        const vel = (step % 4 === 0 ? 1 : 0.78) * hum();
        this.rig.arp(t, chord.arp[idx], vel * (tier === 1 && song.id === 'match' ? 0.75 : 1), 0.3 + 0.6 * I);
      }
    }
    if (st.twinkle && r.chance(0.05)) this.rig.twinkle(t, chord.arp[r.int(6)] + 12, r.range(0.5, 1));
  }

  private beginBar(t: number, song: SongDef, sec: SectionDef): void {
    const st = song.style;
    const I = this.intensityTarget;
    this.barIntensity = I;
    let tier = I < 0.34 ? 0 : I < 0.67 ? 1 : 2;
    if (tier < st.minTier) tier = st.minTier;
    this.barTier = tier;
    // Intensity also lifts the level a little (≈ +2 dB from calm to max).
    this.rig.gate.gain.setTargetAtTime(song.gain * (0.88 + 0.24 * I), t, 0.6);
    // Breakdown (no kick / bass for 2 bars) on flagged sections at low intensity — never on the very first bars.
    this.breakdownNow = !!sec.breakdown && tier === 0 && this.bar < 2 && (this.cycle > 0 || this.section > 0);

    // Crash on section entries after a fill / into a lift.
    if (this.bar === 0 && tier >= 1 && (sec.lift || this.prevSectionFill) && st.kick[tier].indexOf('X') >= 0) {
      this.rig.crash(t, 0.9);
      this.prevSectionFill = false;
    }

    // Pad: one voice per run of identical chords.
    const chord = sec.chords[this.bar];
    if (t >= this.padUntil - 1e-3 || chord !== this.padChord) {
      let n = 1;
      while (this.bar + n < sec.chords.length && sec.chords[this.bar + n] === chord) n++;
      const dur = n * 16 * this.stepDur;
      const bright = clamp01(lerp(st.padBright[0], st.padBright[1], I) + (sec.lift ? 0.08 : 0));
      const v = this.rig.pad(t, chord.pad, dur, bright, st.padAttack, st.padRelease, st.padLevel);
      this.longVoices.push(v);
      this.padUntil = t + dur;
      this.padChord = chord;
    }

    // Lead melody voice for the whole section (notes are added per step in scheduleStep).
    if (this.bar === 0) {
      this.lead = null;
      const allowed = st.lead === 'always' || (st.lead === 'high' && tier === 2) || (st.lead === 'lift' && (tier === 2 || (tier === 1 && !!sec.lift)));
      if (allowed && sec.melody && sec.melody.length) {
        const end = t + sec.chords.length * 16 * this.stepDur;
        const voice = this.rig.leadVoice(t, sec.melody[0][1], end, tier === 2 ? 1 : 0.8);
        this.longVoices.push(voice);
        this.lead = { voice, melody: sec.melody, idx: 0 };
      }
    }
  }

  /** Musical stingers (music bus, independent of the song gate). Returns the end time. */
  stinger(kind: Stinger): number {
    const now = this.s.now;
    const t = now + 0.03;
    const rig = this.rig;
    const s = this.s;
    const fx = rig.fx;
    let end = t;
    switch (kind) {
      case 'matchStart': {
        const hit = t + 0.9;
        rig.riser(t, 0.9, 1);
        end = Math.max(end, rig.stab(hit, [57, 60, 64, 69, 72], 0.45, 1.2));
        end = Math.max(end, thump(s, hit, fx, 120, 42, 0.07, 0.8, 0.2));
        end = Math.max(end, noiseBurst(s, hit, fx, 'highpass', 4200, 0.7, 0.11, 0.002, 0.5));
        break;
      }
      case 'countdownGo': {
        end = Math.max(end, rig.stab(t, [57, 60, 64, 69, 72], 0.22, 1.1));
        end = Math.max(end, thump(s, t, fx, 130, 45, 0.06, 0.7, 0.16));
        end = Math.max(end, noiseBurst(s, t, fx, 'highpass', 4200, 0.7, 0.09, 0.002, 0.45));
        break;
      }
      case 'victory': {
        rig.stab(t, [53, 57, 60, 65], 0.2, 1.0);
        rig.stab(t + 0.3, [55, 59, 62, 67], 0.2, 1.05);
        end = Math.max(end, rig.stab(t + 0.6, [57, 61, 64, 69, 73], 1.7, 1.3));
        thump(s, t, fx, 120, 45, 0.06, 0.5, 0.12);
        thump(s, t + 0.3, fx, 120, 45, 0.06, 0.55, 0.12);
        end = Math.max(end, thump(s, t + 0.6, fx, 120, 40, 0.08, 0.8, 0.22));
        end = Math.max(end, noiseBurst(s, t + 0.6, fx, 'highpass', 4200, 0.7, 0.11, 0.002, 0.55));
        const arp = [81, 85, 88, 93, 97];
        for (let i = 0; i < arp.length; i++) rig.twinkle(t + 0.65 + i * 0.07, arp[i], 1.4);
        break;
      }
      case 'defeat': {
        const notes = [76, 74, 72, 69];
        for (let i = 0; i < notes.length; i++) {
          const ti = t + i * 0.38;
          const last = i === notes.length - 1;
          end = Math.max(end, rig.stab(ti, [notes[i], notes[i] - 12], last ? 1.3 : 0.26, 0.55, fx));
        }
        end = Math.max(end, thump(s, t + 1.14, fx, 70, 38, 0.2, 0.6, 0.45));
        break;
      }
      default:
        return now;
    }
    this.lastStinger = kind;
    this.lastStingerTime = now;
    this.lastStingerEnd = end;
    return end;
  }

  dispose(): void {
    this.running = false;
    this.releaseAll(this.s.now, 0.05);
    this.rig.dispose();
  }
}
