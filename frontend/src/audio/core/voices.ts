/**
 * NOVABALL audio — one-shot voice management.
 *
 * Every one-shot sound gets a short output chain:
 *     input (GainNode) → [air-absorption low-pass] → [StereoPanner] → bus
 *                                                              └→ send gain → reverb
 * The pool caps concurrent voices (globally and per category), steals the oldest / least important voice when
 * full, and disconnects finished chains so nothing lingers in the graph.
 */
import type { SpatialResult } from './spatial';
import { disconnect } from './util';

export type VoiceCat =
  | 'hit'
  | 'bounce'
  | 'impact'
  | 'move'
  | 'pickup'
  | 'ability'
  | 'charge'
  | 'big'
  | 'event'
  | 'crowd'
  | 'ui'
  | 'stinger';

const CAPS: Record<VoiceCat, number> = {
  hit: 5,
  bounce: 4,
  impact: 4,
  move: 6,
  pickup: 4,
  ability: 3,
  charge: 3,
  big: 3,
  event: 6,
  crowd: 5,
  ui: 4,
  stinger: 3,
};

interface Voice {
  active: boolean;
  cat: VoiceCat;
  prio: number;
  start: number;
  end: number;
  input: GainNode | null;
  tail: AudioNode | null;
  send: GainNode | null;
}

export interface VoiceOutOptions {
  /** Output bus. */
  dest: AudioNode;
  /** Reverb send bus (optional). */
  reverb?: AudioNode | null;
  /** Reverb send amount 0..1. */
  send?: number;
  /** Spatial info from Listener.locate (null = centered, full level). */
  spatial?: SpatialResult | null;
  /** Extra linear gain on the voice input. */
  gain?: number;
}

export class VoicePool {
  private readonly voices: Voice[] = [];
  private readonly counts: Record<VoiceCat, number> = {
    hit: 0, bounce: 0, impact: 0, move: 0, pickup: 0, ability: 0, charge: 0, big: 0, event: 0, crowd: 0, ui: 0, stinger: 0,
  };
  private activeCount = 0;
  /** Diagnostics. */
  stolen = 0;
  dropped = 0;
  created = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly maxVoices = 30,
  ) {
    for (let i = 0; i < maxVoices + 8; i++) {
      this.voices.push({ active: false, cat: 'event', prio: 0, start: 0, end: 0, input: null, tail: null, send: null });
    }
  }

  get active(): number {
    return this.activeCount;
  }

  /**
   * Allocate a voice. Returns the input GainNode to connect sound sources into, or null if the sound should be
   * dropped (pool full of more important sounds). Call `finish(input, endTime)` once the duration is known.
   */
  acquire(cat: VoiceCat, prio: number, opts: VoiceOutOptions): GainNode | null {
    const now = this.ctx.currentTime;
    this.retire(now);
    if (this.counts[cat] >= CAPS[cat] || this.activeCount >= this.maxVoices) {
      const victim = this.findVictim(this.counts[cat] >= CAPS[cat] ? cat : null, prio);
      if (!victim) {
        this.dropped++;
        return null;
      }
      this.kill(victim, now);
      this.stolen++;
    }
    const v = this.freeSlot();
    if (!v) {
      this.dropped++;
      return null;
    }
    const ctx = this.ctx;
    const input = ctx.createGain();
    input.gain.value = opts.gain ?? 1;
    let tail: AudioNode = input;
    const sp = opts.spatial;
    if (sp) {
      if (sp.cutoff < 16000) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = sp.cutoff;
        lp.Q.value = 0.5;
        tail.connect(lp);
        tail = lp;
      }
      if (sp.pan > 0.02 || sp.pan < -0.02) {
        const pn = ctx.createStereoPanner();
        pn.pan.value = sp.pan;
        tail.connect(pn);
        tail = pn;
      }
      input.gain.value *= sp.gain;
    }
    tail.connect(opts.dest);
    let send: GainNode | null = null;
    const amt = opts.send ?? (sp ? sp.send : 0);
    if (opts.reverb && amt > 0.001) {
      send = ctx.createGain();
      send.gain.value = amt;
      tail.connect(send);
      send.connect(opts.reverb);
    }
    v.active = true;
    v.cat = cat;
    v.prio = prio;
    v.start = now;
    v.end = now + 10; // provisional until finish()
    v.input = input;
    v.tail = tail;
    v.send = send;
    this.counts[cat]++;
    this.activeCount++;
    this.created++;
    return input;
  }

  /** Declare when the voice's sources end (absolute context time). */
  finish(input: GainNode, endTime: number): void {
    for (const v of this.voices) {
      if (v.active && v.input === input) {
        v.end = endTime;
        return;
      }
    }
  }

  /** Disconnect voices whose sound is over. Cheap; call every frame. */
  retire(now: number): void {
    if (this.activeCount === 0) return;
    for (const v of this.voices) {
      if (v.active && v.end + 0.05 < now) this.release(v);
    }
  }

  /** Fade out and release everything (kickoff reset, dispose). */
  stopAll(): void {
    const now = this.ctx.currentTime;
    for (const v of this.voices) if (v.active) this.kill(v, now);
  }

  private kill(v: Voice, now: number): void {
    if (v.input) {
      try {
        v.input.gain.cancelScheduledValues(now);
        v.input.gain.setTargetAtTime(0, now, 0.012);
      } catch {
        /* ignore */
      }
    }
    // Disconnect a bit later (after the fade) — keep the chain alive until then.
    const input = v.input;
    const tail = v.tail;
    const send = v.send;
    this.release(v, false);
    if (typeof setTimeout === 'function') {
      setTimeout(() => disconnect(tail, send, input), 90);
    } else {
      disconnect(tail, send, input);
    }
  }

  private release(v: Voice, doDisconnect = true): void {
    if (doDisconnect) disconnect(v.tail, v.send, v.input);
    v.active = false;
    v.input = null;
    v.tail = null;
    v.send = null;
    this.counts[v.cat]--;
    this.activeCount--;
  }

  private findVictim(cat: VoiceCat | null, prio: number): Voice | null {
    let best: Voice | null = null;
    for (const v of this.voices) {
      if (!v.active) continue;
      if (cat && v.cat !== cat) continue;
      if (v.prio > prio) continue;
      if (!best || v.prio < best.prio || (v.prio === best.prio && v.start < best.start)) best = v;
    }
    return best;
  }

  private freeSlot(): Voice | null {
    for (const v of this.voices) if (!v.active) return v;
    return null;
  }
}
