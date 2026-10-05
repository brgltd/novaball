/**
 * Cross-engine determinism scenario (bundled and executed by ./run.mjs in Node/V8 and headless Firefox/SpiderMonkey).
 * Inputs are derived from the sim state with arithmetic only (+ an integer LCG), so they are engine-independent too.
 */
import { World } from '../../../src/sim/world';
import { makeControlState } from '../../../src/sim/types';
import type { ControlState } from '../../../src/sim/types';

/** Deterministic scenario: 3v3, arithmetic-only chase inputs + LCG noise; hashes at checkpoints. */
export function runScenario(seconds = 60): { hashes: number[]; score: number[]; events: number; tick: number } {
  const w = new World({ teamSize: 3, durationSec: 125, difficulty: 'pro', seed: 20260928, freePlay: false,
    mutators: { charge: true, pulse: true, surges: true, demolitions: true }, player: null });
  const inputs: ControlState[] = w.cars.map(() => makeControlState());
  let lcg = 12345;
  const rnd = () => { lcg = (Math.imul(lcg, 1103515245) + 12345) | 0; return ((lcg >>> 8) & 0xffff) / 65536; };
  const hashes: number[] = [];
  let events = 0;
  for (let i = 0; i < seconds * 120; i++) {
    for (let k = 0; k < w.cars.length; k++) {
      const car = w.cars[k]; const c = inputs[k];
      const dx = w.ball.pos.x - car.pos.x, dz = w.ball.pos.z - car.pos.z;
      const f = dx * car.fwd.x + dz * car.fwd.z;
      const r = -(dx * car.left.x + dz * car.left.z);
      let s = (r / ((f < 0 ? -f : f) + 1)) * 3;
      if (f < 0) s = r >= 0 ? 1 : -1;
      c.steer = s > 1 ? 1 : s < -1 ? -1 : s;
      c.throttle = 1;
      c.boost = rnd() < 0.5;
      const dist2 = dx * dx + dz * dz;
      c.jump = dist2 < 36 ? (i % 40) < 10 || ((i % 40) > 16 && (i % 40) < 22) : false;
      c.pitch = dist2 < 36 ? 1 : 0;
      c.yaw = c.steer;
      c.pulse = rnd() < 0.003;
      c.powerslide = f < 0 && rnd() < 0.5;
    }
    w.step(inputs);
    events += w.drainEvents().length;
    if ((i + 1) % 600 === 0) hashes.push(w.hash());
  }
  return { hashes, score: w.match.score.slice(), events, tick: w.tick };
}
(globalThis as unknown as { __runScenario: typeof runScenario }).__runScenario = runScenario;
