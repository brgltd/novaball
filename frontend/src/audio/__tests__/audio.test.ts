import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AudioSystem } from '../AudioSystem';
import { Listener, makeSpatial } from '../core/spatial';
import { SmoothParam } from '../core/util';
import { FakeWorld } from '../dev/fakeWorld';
import { SONGS, drumVel } from '../music/songs';
import { DEFAULT_SETTINGS } from '../../settings';
import type { SimEvent } from '../../sim/types';

describe('AudioSystem without Web Audio (Node)', () => {
  it('every public method is a silent no-op and never throws', async () => {
    const a = new AudioSystem();
    const w = new FakeWorld(3);
    const evs: SimEvent[] = [
      { type: 'ballHit', carId: 0, team: 0, pos: { x: 0, y: 1, z: 5 }, normal: { x: 0, y: 0, z: 1 }, strength: 20, dodge: true, aerial: false, ballSpeed: 30 },
      { type: 'goal', team: 0, scorerId: 0, assistId: -1, points: 3, charge: 3, ballSpeed: 40, pos: { x: 0, y: 2, z: 51 }, ownGoal: false },
      { type: 'matchEnd', winner: 0 },
    ];
    expect(() => {
      a.applySettings(DEFAULT_SETTINGS);
      a.setMusic('menu');
      a.setMusicIntensity(0.7);
      a.setMusicIntensity(Number.NaN);
      a.playUi('click');
      a.playStinger('victory');
      a.update(0.016, w.frame);
      a.handleEvents(evs, w.frame);
      a.debugMute('crowd', true);
      a.debugPumpMusic(1);
    }).not.toThrow();
    await expect(a.unlock()).resolves.toBeUndefined();
    expect(a.context).toBeNull();
    expect(() => {
      a.dispose();
      a.dispose();
      a.update(0.016, w.frame);
      a.handleEvents(evs, w.frame);
    }).not.toThrow();
    await expect(a.unlock()).resolves.toBeUndefined();
  });

  it('tolerates garbage input', () => {
    const a = new AudioSystem();
    expect(() => {
      a.applySettings({} as never);
      a.update(Number.NaN, null as never);
      a.handleEvents(null as never, null as never);
      a.handleEvents([{ type: 'nope' } as never], null as never);
    }).not.toThrow();
  });
});

describe('music data', () => {
  const KEY = new Set([9, 11, 0, 2, 4, 5, 7, 8]); // A minor + G#
  for (const [id, song] of Object.entries(SONGS)) {
    it(`${id}: patterns, harmony and melodies are well-formed and in key`, () => {
      const st = song.style;
      for (const key of ['kick', 'snare', 'clap', 'hat', 'ohat', 'bass'] as const) {
        expect(st[key].length).toBe(3);
        for (const p of st[key]) expect(p.length).toBe(16);
      }
      for (const a of st.arp) if (a) {
        expect(a.length).toBe(16);
        for (const i of a) expect(i).toBeGreaterThanOrEqual(-1), expect(i).toBeLessThan(6);
      }
      expect(song.bpm).toBeGreaterThanOrEqual(80);
      expect(song.bpm).toBeLessThanOrEqual(130);
      for (const sec of song.sections) {
        for (const c of sec.chords) {
          expect(c.arp.length).toBe(6);
          expect(c.bass).toBeGreaterThanOrEqual(24);
          expect(c.bass).toBeLessThanOrEqual(40);
        }
        const steps = sec.chords.length * 16;
        let prevEnd = 0;
        for (const [step, midi, len] of sec.melody ?? []) {
          expect(step).toBeGreaterThanOrEqual(prevEnd); // monotonic, non-overlapping
          expect(step + len).toBeLessThanOrEqual(steps);
          if (id !== 'victory') expect(KEY.has(midi % 12)).toBe(true);
          prevEnd = step + len;
        }
      }
    });
  }
  it('match tempo is in the synthwave range', () => {
    expect(SONGS.match.bpm).toBeGreaterThanOrEqual(116);
    expect(SONGS.match.bpm).toBeLessThanOrEqual(124);
  });
  it('drum velocities', () => {
    expect(drumVel('X.x.o...........', 0)).toBe(1);
    expect(drumVel('X.x.o...........', 2)).toBe(0.8);
    expect(drumVel('X.x.o...........', 4)).toBe(0.5);
    expect(drumVel('X.x.o...........', 1)).toBe(0);
  });
});

describe('spatialization', () => {
  const up = new Vector3(0, 1, 0);
  const L = new Listener();
  // Camera at the origin looking down +Z (three.js cameras look down local -Z → rotate by π).
  L.update(new Vector3(0, 0, 0), new Quaternion().setFromAxisAngle(up, Math.PI), 1 / 60);
  const sp = makeSpatial();

  it('pans screen-right sources to the right and screen-left to the left', () => {
    // Screen-right for a camera looking +Z is world -X.
    expect(L.locate({ x: -10, y: 0, z: 10 }, sp).pan).toBeGreaterThan(0.3);
    expect(L.locate({ x: 10, y: 0, z: 10 }, sp).pan).toBeLessThan(-0.3);
    expect(Math.abs(L.locate({ x: 0, y: 0, z: 10 }, sp).pan)).toBeLessThan(0.01);
  });
  it('attenuates and darkens with distance, darker behind', () => {
    const near = L.locate({ x: 0, y: 0, z: 5 }, sp).gain;
    const far = L.locate({ x: 0, y: 0, z: 60 }, sp).gain;
    expect(near).toBeCloseTo(1, 5);
    expect(far).toBeLessThan(0.2);
    const front = L.locate({ x: 0, y: 0, z: 20 }, sp).cutoff;
    const behind = L.locate({ x: 0, y: 0, z: -20 }, sp).cutoff;
    expect(behind).toBeLessThan(front * 0.7);
  });
  it('Doppler raises pitch for approaching sources and lowers it for receding ones', () => {
    expect(L.doppler({ x: 0, y: 0, z: 30 }, { x: 0, y: 0, z: -20 })).toBeGreaterThan(1.05);
    expect(L.doppler({ x: 0, y: 0, z: 30 }, { x: 0, y: 0, z: 20 })).toBeLessThan(0.95);
  });
});

describe('SmoothParam', () => {
  it('skips redundant automation events', () => {
    let calls = 0;
    const fake = { setTargetAtTime: () => (calls++, fake), cancelScheduledValues: () => fake, setValueAtTime: () => fake } as unknown as AudioParam;
    const p = new SmoothParam(fake, 0.05);
    for (let i = 0; i < 100; i++) p.set(1 + i * 1e-5, i / 60);
    expect(calls).toBe(1);
    p.set(2, 2);
    expect(calls).toBe(2);
    p.set(Number.NaN, 3);
    expect(calls).toBe(2);
  });
});

describe('robustness', () => {
  it('spatial math never returns non-finite values', () => {
    const L = new Listener();
    L.update(new Vector3(0, 0, 0), new Quaternion(), 1 / 60);
    const sp = makeSpatial();
    for (const p of [{ x: Number.NaN, y: 0, z: 0 }, { x: Infinity, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]) {
      const r = L.locate(p, sp);
      expect(Number.isFinite(r.gain) && Number.isFinite(r.pan) && Number.isFinite(r.cutoff) && Number.isFinite(r.send)).toBe(true);
    }
    expect(L.doppler({ x: 1, y: 0, z: 0 }, { x: Number.NaN, y: 0, z: 0 })).toBe(1);
  });
});
