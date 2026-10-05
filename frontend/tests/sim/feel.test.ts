/**
 * FEEL METRICS — measures the numbers that define how NOVABALL plays, prints them as a table and checks
 * they stay in the intended bands (regression guard for tuning changes).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SIM_HZ } from '../../src/sim/constants';
import { World } from '../../src/sim/world';
import { ChaseBots } from './bots';
import { config, ctl, freePlayWorld, place, run } from './helpers';
import { dodgeHit, groundHit } from './scenarios';

describe('FEEL METRICS', () => {
  it('measures and prints the feel table', () => {
    const rows: Array<[string, string, string]> = [];

    // 0 → 14 m/s (throttle only)
    let w = freePlayWorld();
    let car = place(w, 0, 5, -45, 0, 1);
    let t14 = -1;
    let t10 = -1;
    run(w, ctl({ throttle: 1 }), 5, (t) => {
      const s = car.vel.length();
      if (t10 < 0 && s >= 10) t10 = t;
      if (t14 < 0 && s >= 14) t14 = t;
    });
    rows.push(['0→10 m/s (throttle)', `${t10.toFixed(2)} s`, '']);
    rows.push(['0→14 m/s (throttle)', `${t14.toFixed(2)} s`, 'top throttle speed 14.1 m/s']);

    // 0 → supersonic / 23 (boost)
    w = freePlayWorld();
    car = place(w, 0, 5, -45, 0, 1);
    let tSup = -1;
    let t23 = -1;
    run(w, ctl({ throttle: 1, boost: true }), 3, (t) => {
      if (tSup < 0 && car.supersonic) tSup = t;
      if (t23 < 0 && car.vel.length() >= 22.999) t23 = t;
    });
    rows.push(['0→supersonic (boost)', `${tSup.toFixed(2)} s`, `0→23 m/s in ${t23.toFixed(2)} s`]);

    // braking 14 → 0
    w = freePlayWorld();
    car = place(w, 0, 5, -45, 0, 1);
    run(w, ctl({ throttle: 1 }), 5);
    const zb = car.pos.z;
    const tBrake = run(w, ctl({ throttle: -1 }), 2, () => car.vel.dot(car.fwd) <= 0);
    rows.push(['brake 14→0', `${tBrake.toFixed(2)} s`, `${(car.pos.z - zb).toFixed(2)} m`]);

    // turn radius @ 10 m/s
    w = freePlayWorld();
    car = place(w, 0, -15, -20, 0, 1);
    car.vel.set(0, 0, 10);
    const pts: Vector3[] = [];
    run(w, () => ctl({ steer: 1, throttle: car.vel.length() < 10 ? 1 : 0 }), 4, (t) => {
      if (t > 1) pts.push(car.pos.clone());
    });
    const c = pts.reduce((a, p) => a.add(p), new Vector3()).multiplyScalar(1 / pts.length);
    const radius = pts.reduce((a, p) => a + Math.hypot(p.x - c.x, p.z - c.z), 0) / pts.length;
    rows.push(['turn radius @ 10 m/s', `${radius.toFixed(2)} m`, 'full steer']);

    // single / double jump apex
    const apex = (ctrl: (t: number) => ReturnType<typeof ctl>) => {
      const ww = freePlayWorld();
      const cc = place(ww, 0, 0, 0, 0, 1);
      const y0 = cc.pos.y;
      let m = y0;
      run(ww, ctrl, 3, () => {
        m = Math.max(m, cc.pos.y);
      });
      return m - y0;
    };
    const single = apex((t) => ctl({ jump: t < 0.3 }));
    const tap = apex((t) => ctl({ jump: t < 0.01 }));
    const dbl = apex((t) => ctl({ jump: t < 0.2 || (t > 0.22 && t < 0.3) }));
    rows.push(['single jump apex (full hold)', `${single.toFixed(2)} m`, `tap: ${tap.toFixed(2)} m (car origin rise)`]);
    rows.push(['double jump apex', `${dbl.toFixed(2)} m`, '2nd jump right after the hold']);

    // dodge Δv + land
    w = freePlayWorld();
    car = place(w, 0, 0, -20, 0, 1);
    const vb = new Vector3();
    const va = new Vector3();
    let got = false;
    let land = -1;
    let upLand = 0;
    run(w, (t) => ctl({ jump: t < 0.05 || (t >= 0.12 && t < 0.2), pitch: t >= 0.1 ? 1 : 0 }), 2, (t) => {
      if (!car.hasDodged) vb.copy(car.vel);
      else if (!got) {
        got = true;
        va.copy(car.vel);
      }
      if (t > 0.3 && car.onGround && land < 0) {
        land = t;
        upLand = car.up.y;
      }
    });
    const dvH = Math.hypot(va.x - vb.x, va.z - vb.z);
    rows.push(['dodge Δv (horizontal)', `${dvH.toFixed(2)} m/s`, `front flip lands at ${land.toFixed(2)} s, up·Y ${upLand.toFixed(3)}`]);

    // ball speeds
    const g20 = groundHit(20).after.length();
    const g10 = groundHit(10).after.length();
    const d20 = dodgeHit(20).speed;
    rows.push(['ball after 20 m/s grounded head-on hit', `${g20.toFixed(1)} m/s`, `10 m/s hit → ${g10.toFixed(1)} m/s`]);
    rows.push(['ball after 20 m/s dodge (flip) hit', `${d20.toFixed(1)} m/s`, '']);

    // ceiling hang
    w = freePlayWorld();
    car = place(w, 0, 0, 0, 1, 0);
    let on = -1;
    let off = -1;
    run(w, ctl({ throttle: 1, boost: true }), 6, (t) => {
      if (on < 0 && car.onGround && car.up.y < -0.9) on = t;
      if (on > 0 && off < 0 && !car.onGround) off = t;
      return off > 0;
    });
    rows.push(['ceiling hang time', `${(off - on).toFixed(2)} s`, 'boosting up the side wall onto the ceiling']);

    // step cost
    const wp = new World(config({ teamSize: 3, durationSec: 300, seed: 5, player: null }));
    const bots = new ChaseBots(6, 9);
    for (let i = 0; i < 4 * SIM_HZ; i++) wp.step(bots.update(wp));
    const log = [];
    for (let i = 0; i < 3000; i++) log.push(bots.update(wp).map((x) => ({ ...x })));
    // time replay on an identical world (inputs precomputed)
    const wq = new World(config({ teamSize: 3, durationSec: 300, seed: 5, player: null }));
    const bq = new ChaseBots(6, 9);
    for (let i = 0; i < 4 * SIM_HZ; i++) wq.step(bq.update(wq));
    const t0 = performance.now();
    for (let i = 0; i < 3000; i++) {
      wq.step(log[i]);
      wq.drainEvents();
    }
    const stepMs = (performance.now() - t0) / 3000;
    rows.push(['World.step() 3v3', `${(stepMs * 1000).toFixed(1)} µs`, 'budget 150 µs']);

    const table = ['| metric | value | notes |', '|---|---|---|', ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`)].join('\n');
    console.info('\nFEEL METRICS\n' + table + '\n');

    // bands (regression guard)
    expect(t14).toBeGreaterThan(1.8);
    expect(t14).toBeLessThan(3);
    expect(tSup).toBeGreaterThan(1.1);
    expect(tSup).toBeLessThan(1.9);
    expect(radius).toBeGreaterThan(3.5);
    expect(radius).toBeLessThan(5.2);
    expect(single).toBeGreaterThan(2.1);
    expect(single).toBeLessThan(2.7);
    expect(dbl).toBeGreaterThan(4.3);
    expect(dbl).toBeLessThan(5.4);
    expect(dvH).toBeCloseTo(5, 3);
    expect(upLand).toBeGreaterThan(0.95);
    expect(g20).toBeGreaterThan(30);
    expect(g20).toBeLessThan(38);
    expect(d20).toBeGreaterThan(40);
    expect(d20).toBeLessThan(50);
    expect(off - on).toBeGreaterThan(0.3);
    expect(off - on).toBeLessThan(1.2);
    expect(stepMs).toBeLessThan(0.15);
  });
});
