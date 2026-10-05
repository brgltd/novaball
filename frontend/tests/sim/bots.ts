/**
 * Tiny deterministic "chase the ball" input generator for tests (NOT the game AI).
 * Drives every car at the ball with seeded noise, boosts on straights, dodges into the ball when close,
 * occasionally pulses — so a test world sees touches, bumps, pulses, pads, surges and goals.
 */
import type { ControlState } from '../../src/sim/types';
import { makeControlState } from '../../src/sim/types';
import { Rng } from '../../src/sim/rng';
import type { World } from '../../src/sim/world';

export class ChaseBots {
  readonly inputs: ControlState[];
  private readonly rng: Rng;
  private readonly noise: number[];
  private readonly flipAt: number[];

  constructor(numCars: number, seed: number) {
    this.rng = new Rng(seed);
    this.inputs = [];
    this.noise = [];
    this.flipAt = [];
    for (let i = 0; i < numCars; i++) {
      this.inputs.push(makeControlState());
      this.noise.push(0);
      this.flipAt.push(-1);
    }
  }

  update(w: World): ControlState[] {
    const ball = w.ball;
    for (let i = 0; i < w.cars.length; i++) {
      const car = w.cars[i];
      const c = this.inputs[i];
      if (w.tick % 60 === (i * 7) % 60) this.noise[i] = this.rng.range(-0.25, 0.25);
      const dx = ball.pos.x - car.pos.x;
      const dz = ball.pos.z - car.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      // local frame (ground plane approximation): forward f, right r (= −left)
      const f = dx * car.fwd.x + dz * car.fwd.z;
      const r = -(dx * car.left.x + dz * car.left.z);
      const ang = Math.atan2(r, f); // + = ball to the right
      c.steer = Math.max(-1, Math.min(1, ang * 2.5 + this.noise[i]));
      c.yaw = 0;
      c.pitch = 0;
      c.roll = 0;
      c.throttle = 1;
      c.powerslide = Math.abs(ang) > 1.6;
      c.boost = Math.abs(ang) < 0.3 && car.boost > 5 && dist > 8;
      // flip into the ball: jump when close & facing it, dodge ~0.1 s later
      const t = w.time;
      if (this.flipAt[i] < 0 && car.onGround && dist < 6 && Math.abs(ang) < 0.35 && ball.pos.y < 2.5) {
        this.flipAt[i] = t + 0.1;
        c.jump = true;
      } else if (this.flipAt[i] >= 0) {
        if (t < this.flipAt[i] - 0.05) c.jump = true;
        else if (t < this.flipAt[i]) c.jump = false;
        else if (t < this.flipAt[i] + 0.06) {
          c.jump = true;
          c.pitch = 1;
          c.yaw = Math.max(-1, Math.min(1, ang));
        } else {
          c.jump = false;
          if (car.onGround) this.flipAt[i] = -1;
        }
      } else c.jump = false;
      c.pulse = dist < 7 && this.rng.next() < 0.004;
    }
    return this.inputs;
  }
}
