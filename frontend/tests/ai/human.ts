/**
 * Scripted "human" stand-in for tests: an eager ball-chaser (drives at the ball, boosts on straights, flips into
 * it when close) — the most common way a real player plays, and the hardest teammate for bots to not collide with.
 */
import type { ControlState } from '../../src/sim/types';
import type { World } from '../../src/sim/world';

export function makeChaser(): (w: World, out: ControlState) => void {
  let flipAt = -1;
  return (w: World, c: ControlState) => {
    const car = w.cars[0];
    const b = w.ball;
    const dx = b.pos.x - car.pos.x;
    const dz = b.pos.z - car.pos.z;
    const dist = Math.hypot(dx, dz);
    const f = dx * car.fwd.x + dz * car.fwd.z;
    const r = -(dx * car.left.x + dz * car.left.z);
    const ang = Math.atan2(r, f);
    c.steer = Math.max(-1, Math.min(1, ang * 2.5));
    c.throttle = 1;
    c.yaw = 0;
    c.pitch = 0;
    c.roll = 0;
    c.pulse = false;
    c.powerslide = Math.abs(ang) > 1.8;
    c.boost = Math.abs(ang) < 0.3 && car.boost > 5 && dist > 10;
    const t = w.time;
    if (flipAt < 0 && car.onGround && dist < 5.5 && Math.abs(ang) < 0.3 && b.pos.y < 2.2 && w.match.phase === 'playing') {
      flipAt = t + 0.1;
      c.jump = true;
    } else if (flipAt >= 0) {
      if (t < flipAt - 0.05) c.jump = true;
      else if (t < flipAt) c.jump = false;
      else if (t < flipAt + 0.05) {
        c.jump = true;
        c.pitch = 1;
      } else {
        c.jump = false;
        if (car.onGround && t > flipAt + 0.3) flipAt = -1;
      }
    } else c.jump = false;
  };
}
