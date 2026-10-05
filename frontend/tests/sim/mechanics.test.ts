import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { BALL, BOOST_PADS, CAR, GRAVITY, PAD_LAYOUT, PULSE, RESPAWN_SPOTS, SIM_HZ, SURGE } from '../../src/sim/constants';
import { carGravityScaleFor } from '../../src/sim/match';
import type { ControlState, MatchMutators, SimEvent } from '../../src/sim/types';
import { makeControlState } from '../../src/sim/types';
import { World } from '../../src/sim/world';
import { config, ctl, eventsOf, freePlayWorld, place, run, skipCountdown } from './helpers';

const ALL_ON: MatchMutators = { charge: true, pulse: true, surges: true, demolitions: true };
const ALL_OFF: MatchMutators = { charge: false, pulse: false, surges: false, demolitions: false };

function steps(w: World, n: number, inputs: ControlState[] = []): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    w.step(inputs);
    out.push(...w.drainEvents());
  }
  return out;
}

describe('boost pads', () => {
  it('small pad +12, big pad = 100, respawn after 4 s / 10 s, no pickup when full or airborne', () => {
    const w = freePlayWorld();
    const small = PAD_LAYOUT.findIndex((p) => !p.big);
    const big = PAD_LAYOUT.findIndex((p) => p.big);
    const ps = PAD_LAYOUT[small];
    const pb = PAD_LAYOUT[big];
    // small pad
    place(w, 0, ps.x, ps.z, 0, 1, 20);
    let evs = steps(w, 1);
    expect(eventsOf(evs, 'boostPickup')).toEqual([{ type: 'boostPickup', carId: 0, padIndex: small, big: false }]);
    expect(w.cars[0].boost).toBe(20 + BOOST_PADS.smallAmount);
    expect(w.pads[small].active).toBe(false);
    // stays inactive while the car sits on it, then respawns
    place(w, 0, 0, -30, 0, 1, 10);
    evs = steps(w, Math.round((BOOST_PADS.smallRespawn - 0.1) * SIM_HZ));
    expect(w.pads[small].active).toBe(false);
    steps(w, Math.round(0.2 * SIM_HZ));
    expect(w.pads[small].active).toBe(true);
    // big pad
    place(w, 0, pb.x, pb.z, 0, 1, 5);
    steps(w, 1);
    expect(w.cars[0].boost).toBe(100);
    expect(w.pads[big].active).toBe(false);
    expect(w.pads[big].timer).toBeGreaterThan(BOOST_PADS.bigRespawn - 0.1);
    // full tank: no pickup
    place(w, 0, ps.x, ps.z, 0, 1, 100);
    steps(w, Math.round(5 * SIM_HZ)); // make sure the small pad is back
    place(w, 0, ps.x, ps.z, 0, 1, 100);
    evs = steps(w, 1);
    expect(eventsOf(evs, 'boostPickup').length).toBe(0);
    expect(w.pads[small].active).toBe(true);
    // airborne above pickupHeight: no pickup
    const car = place(w, 0, ps.x, ps.z, 0, 1, 0);
    car.pos.y = BOOST_PADS.pickupHeight + 1;
    car.onGround = false;
    evs = steps(w, 1);
    expect(eventsOf(evs, 'boostPickup').length).toBe(0);
  });

  it('snapshot mirrors pad state', () => {
    const w = freePlayWorld();
    const i = PAD_LAYOUT.findIndex((p) => !p.big);
    place(w, 0, PAD_LAYOUT[i].x, PAD_LAYOUT[i].z, 0, 1, 0);
    steps(w, 1);
    const s = w.createSnapshot();
    expect(s.padsActive.length).toBe(PAD_LAYOUT.length);
    expect(s.padsActive[i]).toBe(false);
  });
});

describe('NOVA PULSE', () => {
  it('blasts the ball away, shoves nearby cars, counts as a touch, then cools down', () => {
    const w = new World(config({ teamSize: 1 }));
    skipCountdown(w);
    w.drainEvents();
    const me = place(w, 0, 0, -6, 0, 1);
    const foe = place(w, 1, 4, -6, 0, -1);
    const farFoe = w.cars[1];
    expect(farFoe).toBe(foe);
    w.ball.pos.set(0, BALL.radius, -2);
    const inputs = [ctl({ pulse: true }), makeControlState()];
    let evs = steps(w, 1, inputs);
    const p = eventsOf(evs, 'pulse')[0];
    expect(p).toBeDefined();
    expect(p.carId).toBe(0);
    expect(p.hitBall).toBe(true);
    expect(p.hitCarIds).toEqual([1]);
    expect(w.ball.vel.z).toBeGreaterThan(10); // away from the car (+Z)
    expect(w.ball.vel.y).toBeGreaterThan(PULSE.ballLift - 0.2);
    expect(foe.vel.x).toBeGreaterThan(3); // pushed away (+X)
    expect(w.ball.lastTouchCarId).toBe(0);
    expect(w.ball.charge).toBe(1); // pulse touches waive the speed requirement
    expect(w.ball.chargeTeam).toBe(0);
    expect(me.pulseCooldown).toBeCloseTo(PULSE.cooldown, 6);
    expect(w.createSnapshot().cars[0].pulseReady01).toBeLessThan(0.01);
    // park the ball so no goal interrupts play, then: held button / cooldown ⇒ no second pulse
    w.ball.pos.set(25, BALL.radius, 0);
    w.ball.vel.set(0, 0, 0);
    evs = steps(w, 5 * SIM_HZ, [ctl({ pulse: false }), makeControlState()]);
    evs.push(...steps(w, 1, [ctl({ pulse: true }), makeControlState()]));
    expect(eventsOf(evs, 'pulse').length).toBe(0);
    steps(w, (PULSE.cooldown - 5) * SIM_HZ + 5, [ctl({ pulse: false }), makeControlState()]);
    expect(me.pulseCooldown).toBe(0);
    expect(w.createSnapshot().cars[0].pulseReady01).toBe(1);
    evs = steps(w, 1, [ctl({ pulse: true }), makeControlState()]);
    expect(eventsOf(evs, 'pulse').length).toBe(1);
  });

  it('shoves rivals only: a teammate at the same distance is left alone', () => {
    const setup = (pulse: boolean) => {
      const w = new World(config({ teamSize: 2 })); // cars 0, 1 = team 0; 2, 3 = team 1
      skipCountdown(w);
      w.ball.pos.set(25, BALL.radius, 30); // out of range, no goal
      place(w, 0, 0, -6, 0, 1);
      place(w, 1, -4, -6, 0, 1); // teammate, 4 m to the left
      place(w, 2, 4, -6, 0, -1); // opponent, 4 m to the right
      place(w, 3, 30, 40, 0, -1);
      w.drainEvents();
      const evs = steps(w, 1, [ctl({ pulse }), makeControlState(), makeControlState(), makeControlState()]);
      return { w, evs };
    };
    const on = setup(true);
    const off = setup(false);
    const p = eventsOf(on.evs, 'pulse')[0];
    expect(p).toBeDefined();
    expect(p.hitCarIds).toEqual([2]);
    expect(eventsOf(off.evs, 'pulse').length).toBe(0);
    // the teammate is exactly as if nobody had pulsed (no shove, no pop)
    const mate = on.w.cars[1];
    expect(mate.team).toBe(on.w.cars[0].team);
    expect(mate.vel.toArray()).toEqual(off.w.cars[1].vel.toArray());
    expect(mate.pos.toArray()).toEqual(off.w.cars[1].pos.toArray());
    expect(mate.jumpLock).toBe(off.w.cars[1].jumpLock);
    // the rival gets the full shove: (1 − 0.6·4/8)·carImpulse away from the pulse (+X) plus the lift, and is popped
    const foe = on.w.cars[2];
    const foe0 = off.w.cars[2];
    const imp = PULSE.carImpulse * (1 - (0.6 * 4) / PULSE.radius);
    expect(foe.vel.x - foe0.vel.x).toBeCloseTo(imp, 6);
    expect(foe.vel.y - foe0.vel.y).toBeCloseTo(PULSE.carLift, 6);
    expect(foe.jumpLock).toBe(true);
  });

  it('out of range does nothing to the ball; disabled when the mutator is off or not playing', () => {
    const w = new World(config({ teamSize: 1 }));
    // during the countdown: ignored
    let evs = steps(w, 1, [ctl({ pulse: true })]);
    expect(eventsOf(evs, 'pulse').length).toBe(0);
    skipCountdown(w);
    w.drainEvents();
    place(w, 0, 0, -30, 0, 1);
    evs = steps(w, 1, [ctl({ pulse: false })]);
    evs = steps(w, 1, [ctl({ pulse: true })]);
    const p = eventsOf(evs, 'pulse')[0];
    expect(p.hitBall).toBe(false);
    expect(w.ball.vel.length()).toBe(0);
    const off = new World(config({ teamSize: 1, mutators: { ...ALL_ON, pulse: false } }));
    skipCountdown(off);
    off.drainEvents();
    evs = steps(off, 2, [ctl({ pulse: true })]);
    expect(eventsOf(evs, 'pulse').length).toBe(0);
    expect(off.createSnapshot().cars[0].pulseReady01).toBe(0);
  });
});

describe('ZERO-G SURGE', () => {
  it('3-min match: warnings at 2:03 and 1:03, surges at 2:00–1:50 and 1:00–0:50 with 30 % gravity', () => {
    const w = new World(config({ teamSize: 1, durationSec: 180 }));
    skipCountdown(w);
    w.drainEvents();
    // keep everyone still and away from the ball so no goal interrupts the clock
    const log: Array<{ type: string; clock: number }> = [];
    let activeTicks = 0;
    let maxIntensity = 0;
    for (let i = 0; i < 180 * SIM_HZ && w.match.phase === 'playing'; i++) {
      w.step([]);
      for (const e of w.drainEvents()) if (e.type.startsWith('surge')) log.push({ type: e.type, clock: w.match.clock });
      if (w.match.surge.state === 'active') {
        activeTicks++;
        expect(w.match.surge.gravityScale).toBe(SURGE.gravityScale);
      } else expect(w.match.surge.gravityScale).toBe(1);
      maxIntensity = Math.max(maxIntensity, w.match.surge.intensity);
      expect(w.match.surge.intensity).toBeGreaterThanOrEqual(0);
      expect(w.match.surge.intensity).toBeLessThanOrEqual(1);
    }
    expect(log.map((l) => l.type)).toEqual(['surgeWarning', 'surgeStart', 'surgeEnd', 'surgeWarning', 'surgeStart', 'surgeEnd']);
    expect(log[0].clock).toBeCloseTo(123, 1);
    expect(log[1].clock).toBeCloseTo(120, 1);
    expect(log[2].clock).toBeCloseTo(110, 1);
    expect(log[3].clock).toBeCloseTo(63, 1);
    expect(log[4].clock).toBeCloseTo(60, 1);
    expect(log[5].clock).toBeCloseTo(50, 1);
    expect(activeTicks).toBe(2 * SURGE.duration * SIM_HZ);
    expect(maxIntensity).toBe(1);
  });

  it('low gravity really applies to the ball and cars', () => {
    const w = new World(config({ teamSize: 1, durationSec: 124 }));
    skipCountdown(w);
    // run until the surge is active
    while (w.match.surge.state !== 'active') w.step([]);
    w.ball.pos.set(0, 10, 0);
    w.ball.vel.set(0, 0, 0);
    const car = place(w, 0, 10, -10, 0, 1);
    for (let i = 0; i < SIM_HZ; i++) w.step([i === 0 ? ctl({ jump: true }) : ctl({ jump: i < 24 })]);
    // ball fell 0.5·g·0.3·1² ≈ 0.975 m (minus tiny drag)
    expect(10 - w.ball.pos.y).toBeGreaterThan(0.9);
    expect(10 - w.ball.pos.y).toBeLessThan(1.05);
    // the car is still flying 1 s after a normal jump
    expect(car.onGround).toBe(false);
    expect(car.pos.y).toBeGreaterThan(3);
  });

  it('surge gravity: cars 0.55 (jumps stay playable, no parking on the ceiling), the ball keeps 0.3', () => {
    expect(carGravityScaleFor(1)).toBe(1);
    expect(carGravityScaleFor(SURGE.gravityScale)).toBe(SURGE.carGravityScale);
    /** A real match (first surge 4 s after kickoff), run until the surge is active; opponent and ball parked. */
    const surgeWorld = () => {
      const w = new World(config({ teamSize: 1, durationSec: 124 }));
      skipCountdown(w);
      expect(w.carGravityScale).toBe(1);
      while (w.match.surge.state !== 'active') w.step([]);
      expect(w.match.surge.gravityScale).toBe(SURGE.gravityScale);
      expect(w.gravityScale).toBe(SURGE.gravityScale);
      expect(w.carGravityScale).toBe(SURGE.carGravityScale);
      place(w, 1, 30, 40, 0, -1);
      w.ball.pos.set(-30, BALL.radius, 40);
      w.ball.vel.set(0, 0, 0);
      w.drainEvents();
      return w;
    };
    /** Car-center apex and time back on the ground for a jump input pattern. */
    const jump = (input: (t: number) => ControlState) => {
      const w = surgeWorld();
      const car = place(w, 0, 0, -10, 0, 1);
      let apex = 0;
      let left = false;
      let landed = -1;
      run(w, input, 9, (t) => {
        apex = Math.max(apex, car.pos.y);
        if (!car.onGround) left = true;
        if (left && car.onGround) {
          landed = t;
          return true;
        }
      });
      return { apex, landed };
    };
    const full = jump((t) => ctl({ jump: t < 0.3 }));
    expect(full.apex).toBeGreaterThan(4.5); // was 9.2 m with the ball's 0.3 on cars
    expect(full.apex).toBeLessThan(5.8);
    expect(full.landed).toBeGreaterThan(2);
    expect(full.landed).toBeLessThanOrEqual(3.5); // was 6.0 s
    const dbl = jump((t) => ctl({ jump: t < 0.2 || (t > 0.25 && t < 0.3) }));
    expect(dbl.apex).toBeGreaterThan(full.apex + 3);
    expect(dbl.apex).toBeLessThanOrEqual(11); // was 19 m (the ceiling)
    // a car that stops on the ceiling drops off (car gravity beats the mag-grip) — it used to park there all surge
    {
      const w = surgeWorld();
      const car = place(w, 0, 26, -10, 1, 0);
      car.vel.set(12, 0, 0);
      let onCeil = -1;
      let off = -1;
      run(w, () => ctl({ throttle: onCeil >= 0 ? 0 : 1 }), 8, (t) => {
        if (onCeil < 0 && car.onGround && car.up.y < -0.9) onCeil = t;
        if (onCeil >= 0 && !car.onGround) {
          off = t;
          return true;
        }
      });
      expect(onCeil).toBeGreaterThan(0);
      expect(off).toBeGreaterThan(onCeil);
      expect(off - onCeil).toBeLessThanOrEqual(2.5);
    }
    // the ball keeps the ball scale: straight up at 10 m/s → y(1 s) = 1 + 10 − ½·g·0.3 (tiny drag); apex from 6 m/s
    {
      const w = surgeWorld();
      w.ball.pos.set(0, 1, 0);
      w.ball.vel.set(0, 10, 0);
      let apex = 0;
      for (let i = 0; i < SIM_HZ; i++) {
        w.step([]);
        apex = Math.max(apex, w.ball.pos.y);
      }
      const ideal = 1 + 10 - 0.5 * GRAVITY * SURGE.gravityScale;
      expect(w.ball.pos.y).toBeLessThan(ideal);
      expect(w.ball.pos.y).toBeGreaterThan(ideal - 0.2);
      w.ball.pos.set(0, 1, 0);
      w.ball.vel.set(0, 6, 0);
      apex = 0;
      for (let i = 0; i < 4 * SIM_HZ; i++) {
        w.step([]);
        apex = Math.max(apex, w.ball.pos.y);
      }
      const idealApex = 1 + 36 / (2 * GRAVITY * SURGE.gravityScale); // 10.2 m drag-free (car gravity would give ≈ 6 m)
      expect(apex).toBeLessThan(idealApex);
      expect(apex).toBeGreaterThan(idealApex - 1);
    }
  });

  it('surges happen in overtime too; mutator off ⇒ never', () => {
    const w = new World(config({ teamSize: 1, durationSec: 10 }));
    skipCountdown(w);
    while (!w.match.overtime) w.step([]);
    skipCountdown(w);
    w.drainEvents();
    const evs = steps(w, 61 * SIM_HZ);
    const types = eventsOf(evs, 'surgeWarning').length + eventsOf(evs, 'surgeStart').length;
    expect(types).toBeGreaterThanOrEqual(2);
    const off = new World(config({ teamSize: 1, durationSec: 180, mutators: { ...ALL_ON, surges: false } }));
    skipCountdown(off);
    const e2 = steps(off, 90 * SIM_HZ);
    expect(e2.filter((e) => e.type.startsWith('surge')).length).toBe(0);
  });
});

describe('demolitions and bumps', () => {
  function headOn(mutators: MatchMutators, sameTeam = false, attackerSpeed = 22.5) {
    const w = new World(config({ teamSize: 2, mutators }));
    skipCountdown(w);
    w.drainEvents();
    w.cars.forEach((c, i) => place(w, c.id, -30 + i * 5, -40, 0, 1));
    w.ball.pos.set(30, BALL.radius, 40);
    const a = place(w, 0, 0, -10, 0, 1);
    const victimId = sameTeam ? 1 : 2;
    const v = place(w, victimId, 0, -7, 1, 0);
    a.vel.set(0, 0, attackerSpeed);
    a.supersonic = attackerSpeed >= CAR.supersonicSpeed;
    const inputs = w.cars.map(() => makeControlState());
    inputs[0] = ctl({ throttle: 1, boost: true });
    const evs = steps(w, 30, inputs);
    return { w, a, v, evs };
  }

  it('supersonic front hit on an opponent demolishes it; respawn after 3 s at a team spot', () => {
    const { w, a, v, evs } = headOn(ALL_ON);
    const demo = eventsOf(evs, 'demolish')[0];
    expect(demo).toMatchObject({ victimId: v.id, attackerId: a.id });
    expect(v.demolished).toBe(true);
    expect(a.stats.demos).toBe(1);
    expect(w.createSnapshot().cars[v.id].demolished).toBe(true);
    // demolished cars don't collide or move
    const p = v.pos.clone();
    const e2 = steps(w, Math.round((CAR.respawnTime - 0.3) * SIM_HZ));
    expect(v.pos.equals(p)).toBe(true);
    expect(eventsOf(e2, 'respawn').length).toBe(0);
    const e3 = steps(w, Math.round(0.5 * SIM_HZ));
    expect(eventsOf(e3, 'respawn')).toEqual([{ type: 'respawn', carId: v.id }]);
    expect(v.demolished).toBe(false);
    expect(v.boost).toBeLessThanOrEqual(CAR.boostStart + 1e-9);
    // team 1 respawns at mirrored spots, facing −Z (the enemy goal)
    const spot = RESPAWN_SPOTS.some((s) => Math.abs(-s.x - v.pos.x) < 1 && Math.abs(-s.z - v.pos.z) < 1);
    expect(spot).toBe(true);
    expect(v.fwd.z).toBeLessThan(-0.99);
  });

  it('teammates, sub-supersonic hits and demolitions-off only bump', () => {
    for (const [mut, same, speed] of [
      [ALL_ON, true, 22.5],
      [ALL_ON, false, 15],
      [{ ...ALL_ON, demolitions: false }, false, 22.5],
      [ALL_OFF, false, 22.5],
    ] as const) {
      const { v, evs } = headOn(mut, same, speed);
      expect(eventsOf(evs, 'demolish').length).toBe(0);
      expect(v.demolished).toBe(false);
      const bump = eventsOf(evs, 'carBump')[0];
      expect(bump).toBeDefined();
      expect(bump.aId).toBe(0);
      expect(bump.bId).toBe(v.id);
      expect(v.vel.z).toBeGreaterThan(5); // shoved forward
    }
  });
});

describe('car–car contact geometry (hitbox-accurate vertically)', () => {
  function duel() {
    const w = new World(config({ teamSize: 1 }));
    skipCountdown(w);
    w.ball.exploded = true; // cars only
    w.drainEvents();
    return w;
  }

  it('a supersonic car flying level just over a parked opponent never touches it (no ghost demo / bump)', () => {
    for (const gap of [0.05, 0.15, 0.25, 0.35]) {
      const w = duel();
      const a = place(w, 0, 0, -5, 0, 1);
      const b = place(w, 1, 0, 0, 0, -1);
      steps(w, 30); // B settles on its hover
      const h = b.pos.y + 2 * CAR.halfExtents.y + gap; // A's center height for that hitbox gap
      a.pos.set(0, h, -5);
      const evs: SimEvent[] = [];
      for (let i = 0; i < 60; i++) {
        a.pos.y = h; // fly perfectly level at 23 m/s over B
        a.vel.set(0, 0, 23);
        a.supersonic = true;
        a.onGround = false;
        a.jumpLock = true;
        a.jumpTimer = 0;
        a.hasJumped = true;
        evs.push(...steps(w, 1));
      }
      expect(a.pos.z).toBeGreaterThan(5); // it really flew over
      expect(eventsOf(evs, 'demolish').length).toBe(0);
      expect(eventsOf(evs, 'carBump').length).toBe(0);
      expect(b.demolished).toBe(false);
      expect(b.vel.length()).toBeLessThan(0.1);
    }
  });

  it('a car dropping onto an opponent’s roof still bumps it, then rests on the roof', () => {
    const w = duel();
    const a = place(w, 0, 0, -10, 0, 1);
    const b = place(w, 1, 0, -10, 0, 1);
    a.pos.y = 1.6;
    a.vel.set(0, -3, 0);
    a.onGround = false;
    a.hasJumped = true;
    a.jumpLock = true;
    const evs = steps(w, 2 * SIM_HZ);
    expect(eventsOf(evs, 'carBump').length).toBeGreaterThanOrEqual(1);
    expect(eventsOf(evs, 'demolish').length).toBe(0);
    // resting on the roof: boxes touching (center gap = 2 × half height), not floating on the taller capsule
    expect(a.pos.y - b.pos.y).toBeGreaterThan(2 * CAR.halfExtents.y - 0.03);
    expect(a.pos.y - b.pos.y).toBeLessThan(2 * CAR.halfExtents.y + 0.05);
    expect(a.vel.length()).toBeLessThan(0.2);
  });

  it('ground bumps are unchanged: rear-end and T-bone victim speeds at 5 / 10 / 15 / 20 m/s (±1 %)', () => {
    // victim |v| 3 ticks after the first carBump, measured before the up-axis test was added
    const REF: Record<string, number> = {
      rear5: 6.022649,
      rear10: 11.910006,
      rear15: 17.791067,
      rear20: 22.982809,
      tbone5: 6.022653,
      tbone10: 11.910098,
      tbone15: 17.79137,
      tbone20: 22.982784,
    };
    for (const side of [false, true]) {
      for (const s of [5, 10, 15, 20]) {
        const w = duel();
        const a = place(w, 0, 0, -5, 0, 1);
        const b = side ? place(w, 1, 0, 0, 1, 0) : place(w, 1, 0, 0, 0, 1);
        let bumps = 0;
        let n = -1;
        let victim = -1;
        run(
          w,
          () => {
            if (bumps === 0) a.vel.set(0, 0, s);
            return ctl({ throttle: 1 });
          },
          1,
          () => {
            bumps += eventsOf(w.drainEvents(), 'carBump').length;
            if (bumps > 0) n++;
            if (n === 3) victim = b.vel.length();
          },
        );
        const ref = REF[(side ? 'tbone' : 'rear') + s];
        expect(bumps).toBe(1);
        expect(Math.abs(victim - ref) / ref).toBeLessThan(0.01);
      }
    }
  });
});

describe('mutators off', () => {
  it('charge stays 0, pulses ignored, no surges, no demos', () => {
    const w = new World(config({ teamSize: 1, durationSec: 150, mutators: ALL_OFF }));
    skipCountdown(w);
    const evs: SimEvent[] = [];
    const inputs = [ctl({ throttle: 1, boost: true, pulse: true }), ctl({ throttle: 1, boost: true })];
    for (let i = 0; i < 40 * SIM_HZ; i++) {
      inputs[0].pulse = (i & 16) !== 0;
      inputs[0].steer = (i >> 7) & 1 ? 0.5 : -0.5;
      inputs[1].steer = (i >> 8) & 1 ? 0.5 : -0.5;
      w.step(inputs);
      evs.push(...w.drainEvents());
    }
    expect(w.ball.charge).toBe(0);
    expect(eventsOf(evs, 'chargeChange').length).toBe(0);
    expect(eventsOf(evs, 'pulse').length).toBe(0);
    expect(evs.filter((e) => e.type.startsWith('surge')).length).toBe(0);
    expect(eventsOf(evs, 'demolish').length).toBe(0);
  });
});

describe('pulse / surge sanity with vectors', () => {
  it('pulse direction falls off with distance', () => {
    const near = freePlayWorld(false);
    place(near, 0, 0, -2.5, 0, 1);
    near.ball.pos.set(0, BALL.radius, 0);
    const w2 = freePlayWorld(false);
    place(w2, 0, 0, -8, 0, 1);
    w2.ball.pos.set(0, BALL.radius, 0);
    near.step([ctl({ pulse: true })]);
    w2.step([ctl({ pulse: true })]);
    const vn = new Vector3().copy(near.ball.vel).setY(0).length();
    const vf = new Vector3().copy(w2.ball.vel).setY(0).length();
    expect(vn).toBeGreaterThan(vf);
    expect(vf).toBeGreaterThan(0.35 * PULSE.ballImpulse);
  });
});
