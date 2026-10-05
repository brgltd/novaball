/**
 * NOVABALL audio — a tiny scripted world for the audio sandbox and offline render checks.
 * Produces WorldSnapshot + AudioFrame objects shaped exactly like the real game's, without the sim.
 * (Dev/test helper only; not used by the game.)
 */
import { Quaternion, Vector3 } from 'three';
import type { AudioFrame } from '../../contracts';
import { ARENA, BALL, CAR, GRAVITY } from '../../sim/constants';
import type { BallSnapshot, CarSnapshot, MatchPhase, SimEvent, Team, WorldSnapshot } from '../../sim/types';

export interface FakeControls {
  throttle: number;
  steer: number;
  boost: boolean;
  powerslide: boolean;
  jump: boolean;
}

export function makeCarSnapshot(id: number, team: Team): CarSnapshot {
  return {
    id,
    team,
    pos: new Vector3(0, CAR.rideHeight, 0),
    quat: new Quaternion(),
    vel: new Vector3(),
    angVel: new Vector3(),
    boost: 33,
    boosting: false,
    supersonic: false,
    onGround: true,
    demolished: false,
    dodging: false,
    powersliding: false,
    steer: 0,
    throttle: 0,
    pulseReady01: 1,
  };
}

export function makeBallSnapshot(): BallSnapshot {
  return {
    pos: new Vector3(BALL.spawn.x, BALL.spawn.y, BALL.spawn.z),
    quat: new Quaternion(),
    vel: new Vector3(),
    angVel: new Vector3(),
    charge: 0,
    chargeTeam: -1,
    visible: true,
  };
}

const UP = new Vector3(0, 1, 0);

export class FakeWorld {
  readonly snap: WorldSnapshot;
  readonly frame: AudioFrame;
  readonly controls: FakeControls = { throttle: 0, steer: 0, boost: false, powerslide: false, jump: false };
  /** Emitted by step() (ball bounces, bot hits...) when autoEvents is on. */
  readonly events: SimEvent[] = [];
  autoEvents = false;
  time = 0;
  private heading = 0;
  private speed = 0;
  private vy = 0;
  private botPhase: number[] = [];
  private readonly tmp = new Vector3();
  private hitCooldown = 0;

  constructor(teamSize = 3, phase: MatchPhase = 'playing') {
    const cars: CarSnapshot[] = [];
    for (let i = 0; i < teamSize * 2; i++) cars.push(makeCarSnapshot(i, i < teamSize ? 0 : 1));
    this.snap = { tick: 0, time: 0, phase, cars, ball: makeBallSnapshot(), padsActive: [], surge: 0 };
    for (let i = 0; i < cars.length; i++) this.botPhase.push(i * 1.7);
    cars[0].pos.set(0, CAR.rideHeight, -30);
    this.frame = {
      listenerPos: new Vector3(),
      listenerQuat: new Quaternion(),
      snap: this.snap,
      playerCarId: 0,
      phase,
      timeScale: 1,
      paused: false,
      replay: false,
    };
    this.ballKick(new Vector3(6, 9, 14));
    this.updateCamera();
  }

  ballKick(v: Vector3): void {
    this.snap.ball.vel.copy(v);
  }

  step(dt: number): void {
    this.time += dt;
    this.snap.time = this.time;
    this.snap.tick++;
    this.events.length = 0;
    this.stepPlayer(dt);
    this.stepBots(dt);
    this.stepBall(dt);
    this.updateCamera();
  }

  private stepPlayer(dt: number): void {
    const c = this.snap.cars[0];
    const k = this.controls;
    const onGround = c.pos.y <= CAR.rideHeight + 1e-3;
    if (k.jump && onGround) {
      this.vy = 5.5;
      if (this.autoEvents) this.events.push({ type: 'jump', carId: 0, double: false });
    }
    let accel = 0;
    if (k.throttle > 0) accel += this.speed < CAR.maxThrottleSpeed ? 16 * (1 - this.speed / 14.5) * k.throttle : 0;
    else if (k.throttle < 0) accel -= this.speed > 0 ? CAR.brakeAccel : 5;
    else accel -= Math.sign(this.speed) * CAR.coastDecel;
    if (k.boost) accel += CAR.boostAccel;
    this.speed = Math.max(-CAR.reverseMaxSpeed, Math.min(CAR.maxSpeed, this.speed + accel * dt));
    if (Math.abs(this.speed) < 0.05 && k.throttle === 0) this.speed = 0;
    this.heading += k.steer * dt * (k.powerslide ? 2.4 : 1.5) * Math.min(1, Math.abs(this.speed) / 6);
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    c.vel.set(fx * this.speed, this.vy, fz * this.speed);
    c.pos.addScaledVector(c.vel, dt);
    this.vy -= GRAVITY * 2 * dt;
    if (c.pos.y <= CAR.rideHeight) {
      if (this.vy < -3 && this.autoEvents) this.events.push({ type: 'land', carId: 0, speed: -this.vy });
      c.pos.y = CAR.rideHeight;
      this.vy = 0;
    }
    // Wrap around the arena (keep it inside).
    const W = ARENA.halfWidth - 4;
    const L = ARENA.halfLength - 4;
    if (c.pos.x > W) c.pos.x = -W;
    if (c.pos.x < -W) c.pos.x = W;
    if (c.pos.z > L) c.pos.z = -L;
    if (c.pos.z < -L) c.pos.z = L;
    c.quat.setFromAxisAngle(UP, this.heading);
    c.onGround = c.pos.y <= CAR.rideHeight + 1e-3;
    c.boosting = k.boost;
    c.throttle = k.throttle;
    c.steer = k.steer;
    c.powersliding = k.powerslide;
    const sp = Math.abs(this.speed);
    c.supersonic = c.supersonic ? sp > CAR.supersonicHoldSpeed : sp >= CAR.supersonicSpeed;
  }

  private stepBots(dt: number): void {
    const cars = this.snap.cars;
    for (let i = 1; i < cars.length; i++) {
      const c = cars[i];
      const ph = (this.botPhase[i] += dt * (0.25 + 0.05 * i));
      const r = 12 + 5 * i;
      const x = Math.sin(ph) * Math.min(r, ARENA.halfWidth - 3);
      const z = Math.cos(ph * 0.8) * Math.min(r * 1.4, ARENA.halfLength - 3);
      this.tmp.set(x, CAR.rideHeight, z);
      c.vel.subVectors(this.tmp, c.pos).divideScalar(Math.max(dt, 1e-3));
      if (c.vel.length() > 40) c.vel.set(0, 0, 0);
      c.pos.copy(this.tmp);
      c.boosting = Math.sin(ph * 2.3 + i) > 0.6;
      c.throttle = 1;
      const sp = c.vel.length();
      c.supersonic = sp > CAR.supersonicSpeed;
    }
  }

  private stepBall(dt: number): void {
    const b = this.snap.ball;
    const g = GRAVITY * (1 - 0.7 * this.snap.surge);
    b.vel.y -= g * dt;
    b.pos.addScaledVector(b.vel, dt);
    const R = BALL.radius;
    const bounce = (nx: number, ny: number, nz: number, vn: number) => {
      if (this.autoEvents && vn > 2) this.events.push({ type: 'ballBounce', pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z }, normal: { x: nx, y: ny, z: nz }, speed: vn });
    };
    if (b.pos.y < R) {
      const vn = -b.vel.y;
      b.pos.y = R;
      b.vel.y = vn * BALL.restitution;
      b.vel.x *= 0.98;
      b.vel.z *= 0.98;
      bounce(0, 1, 0, vn);
    }
    if (b.pos.y > ARENA.height - R) {
      const vn = b.vel.y;
      b.pos.y = ARENA.height - R;
      b.vel.y = -vn * BALL.restitution;
      bounce(0, -1, 0, vn);
    }
    const W = ARENA.halfWidth - R;
    if (Math.abs(b.pos.x) > W) {
      const vn = Math.abs(b.vel.x);
      b.pos.x = Math.sign(b.pos.x) * W;
      b.vel.x = -b.vel.x * BALL.restitution;
      bounce(-Math.sign(b.pos.x), 0, 0, vn);
    }
    const L = ARENA.halfLength - R;
    if (Math.abs(b.pos.z) > L) {
      const vn = Math.abs(b.vel.z);
      b.pos.z = Math.sign(b.pos.z) * L;
      b.vel.z = -b.vel.z * BALL.restitution;
      bounce(0, 0, -Math.sign(b.pos.z), vn);
    }
    // Keep it lively: occasional bot "hits".
    this.hitCooldown -= dt;
    const speed = b.vel.length();
    if (this.hitCooldown <= 0 && speed < 6 && b.pos.y < 2) {
      this.hitCooldown = 2.5;
      const dir = new Vector3(Math.random() - 0.5, 0.4 + Math.random() * 0.4, Math.random() - 0.5).normalize();
      b.vel.addScaledVector(dir, 18 + Math.random() * 16);
      if (this.autoEvents) {
        const strength = 18 + Math.random() * 16;
        this.events.push({ type: 'ballHit', carId: 1 + Math.floor(Math.random() * (this.snap.cars.length - 1)), team: 1, pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z }, normal: { x: dir.x, y: dir.y, z: dir.z }, strength, dodge: Math.random() < 0.3, aerial: false, ballSpeed: speed + strength });
      }
    }
  }

  /** Chase camera: 3.4 m behind, 1.25 m above the player car, looking along its heading. */
  updateCamera(): void {
    const c = this.snap.cars[0];
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    (this.frame.listenerPos as Vector3).set(c.pos.x - fx * 3.4, c.pos.y + 1.25, c.pos.z - fz * 3.4);
    // Camera looks down its local -Z: rotate by heading + π around Y.
    (this.frame.listenerQuat as Quaternion).setFromAxisAngle(UP, this.heading + Math.PI);
  }

  setPhase(p: MatchPhase): void {
    this.snap.phase = p;
    this.frame.phase = p;
  }
}
