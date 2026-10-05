/**
 * VFXSystem — every particle / trail / shockwave effect in the game, pooled and allocation-free per frame.
 *
 * Draw calls (only while something of that kind is alive):
 *   additive particles (1) + alpha particles/smoke (1) + ribbon trails (1) + shock rings (1) + shock spheres (1)
 *   + light beams (1) + debris shards (1).
 *
 * Continuous (update): boost exhaust + team ribbon trails from the thrusters, supersonic streaks, ball trail
 * (colored by charge; SUPERNOVA thicker + sparkling), hover shimmer dust, ZERO-G surge motes.
 * One-shot (handleEvent): hits, bounces, impacts, bumps, jumps, dodges, landings, pickups, demolitions,
 * respawns, pulses, charge changes, goals (the biggest effect in the game), surge start.
 */
import { Color, Group, Quaternion, Vector3, type Camera } from 'three';
import type { IVFXSystem } from '../contracts';
import type { QualityPreset } from '../settings';
import { goalFramePaths } from '../sim/arena';
import { BALL, CAR, PAD_LAYOUT, PULSE } from '../sim/constants';
import type { CarSnapshot, CarStyleId, SimEvent, Team, WorldSnapshot } from '../sim/types';
import { ARENA_THEME } from '../theme';
import { CAR_HARDPOINTS, type CarHardpoints } from './actors/carDesigns';
import { DebrisPool } from './actors/debris';
import {
  FLAG_FLOOR,
  FLAG_HOMING,
  ParticlePool,
  ParticleSpawn,
  SHAPE_EMBER,
  SHAPE_GLOW,
  SHAPE_HEX,
  SHAPE_RING,
  SHAPE_SMOKE,
  SHAPE_SPARK,
  type ParticleContext,
} from './actors/particles';
import { RibbonBuffer } from './actors/ribbons';
import { SHOCK_BEAM, SHOCK_RING, SHOCK_SPHERE, ShockPool } from './actors/shocks';
import { clamp, clamp01, FastRng, NEUTRAL_COLOR, smoothstep, TEAM_PRIMARY, TEAM_SECONDARY } from './actors/util';
import { BOOST_COLOR } from './BoostPadsView';

const QUALITY: Record<QualityPreset, { cap: number; alphaCap: number; k: number }> = {
  low: { cap: 3000, alphaCap: 500, k: 0.4 },
  medium: { cap: 6000, alphaCap: 900, k: 0.65 },
  high: { cap: 10000, alphaCap: 1400, k: 1.0 },
  ultra: { cap: 14000, alphaCap: 2000, k: 1.3 },
};
const MAX_CAP = 14000;
const MAX_ALPHA_CAP = 2000;

const MAX_CARS = 8;
const TRAIL_POINTS = 44;
const TRAIL_STRIPS = 40;
const BALL_TRAIL_KEY = MAX_CARS * 8;
const TRAIL_KEYS = BALL_TRAIL_KEY + 1;
const GRAVITY_VFX = 9.8;

const SURGE_COLOR = new Color(ARENA_THEME.surge);
const WHITE = new Color(1, 1, 1);
const FIRE = new Color(1.0, 0.42, 0.1);

const _v = new Vector3();
const _v2 = new Vector3();
const _n = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();
const _q = new Quaternion();
const _col = new Color();
const _col2 = new Color();

class TrailSlot {
  key = -1;
  attached = false;
  touched = -1;
  head = -1;
  count = 0;
  readonly xs = new Float32Array(TRAIL_POINTS);
  readonly ys = new Float32Array(TRAIL_POINTS);
  readonly zs = new Float32Array(TRAIL_POINTS);
  readonly ts = new Float32Array(TRAIL_POINTS);
  cx = 0;
  cy = 0;
  cz = 0;
  width = 0.1;
  life = 0.3;
  r = 1;
  g = 1;
  b = 1;
  minDist = 0.08;
  sparkle = 0;
}

const EMIT_FOUNTAIN = 1;
const EMIT_SMOKE = 2;
const EMIT_CONVERGE = 3;

class Emitter {
  type = 0;
  t = 0;
  dur = 1;
  x = 0;
  y = 0;
  z = 0;
  team: Team = 0;
  rate = 0;
  acc = 0;
  param = 0;
  /** Brightness multiplier of the emitted particles. */
  gain = 1;
}

export class VFXSystem implements IVFXSystem {
  readonly object = new Group();
  private readonly add = new ParticlePool(MAX_CAP, 'add');
  private readonly alpha = new ParticlePool(MAX_ALPHA_CAP, 'alpha');
  private readonly ribbons = new RibbonBuffer(TRAIL_STRIPS, TRAIL_POINTS + 1, { softness: 1.5, core: 0.6, nearFade: [1.2, 5.5] });
  private readonly shocks = new ShockPool(48);
  private readonly debris = new DebrisPool(96);
  private readonly P = new ParticleSpawn();
  private readonly rng = new FastRng(0x5eed);
  private k = 1;
  private time = 0;
  private frame = 0;
  private readonly camPos = new Vector3(0, 10, 30);

  // per-car state
  private readonly styles: CarStyleId[] = new Array<CarStyleId>(MAX_CARS).fill('striker');
  private readonly carPos = new Float32Array(MAX_CARS * 3);
  private readonly carVel = new Float32Array(MAX_CARS * 3);
  private readonly carValid = new Uint8Array(MAX_CARS);
  private readonly carTeam = new Uint8Array(MAX_CARS);
  private readonly prevThr = new Float32Array(MAX_CARS * 2 * 3);
  private readonly prevThrValid = new Uint8Array(MAX_CARS);
  private readonly exhaustAcc = new Float32Array(MAX_CARS);
  private readonly dustAcc = new Float32Array(MAX_CARS);
  private readonly carIndex = new Int16Array(MAX_CARS).fill(-1);
  private readonly ctx: ParticleContext;

  // trails
  private readonly slots: TrailSlot[] = [];
  /** Trail key -> slot index (-1 = none). Keys: carId * 8 + k (k 0-1 boost, 2-3 supersonic), BALL_TRAIL_KEY. */
  private readonly keyToSlot = new Int16Array(TRAIL_KEYS).fill(-1);

  // timed emitters
  private readonly emitters: Emitter[] = [];
  private readonly goalFrames: Array<{ pts: Float32Array; cum: Float32Array; total: number }> = [];

  // misc accumulators
  private moteAcc = 0;
  private ballSparkAcc = 0;

  constructor() {
    this.object.name = 'vfx';
    this.alpha.mesh.renderOrder = 7;
    this.add.mesh.renderOrder = 8;
    this.ribbons.mesh.renderOrder = 7;
    this.add.mesh.name = 'vfxAdditive';
    this.alpha.mesh.name = 'vfxAlpha';
    this.ribbons.mesh.name = 'vfxTrails';
    this.object.add(this.alpha.mesh, this.add.mesh, this.ribbons.mesh, this.shocks.object, this.debris.mesh);
    for (let i = 0; i < TRAIL_STRIPS; i++) this.slots.push(new TrailSlot());
    for (let i = 0; i < 12; i++) this.emitters.push(new Emitter());
    this.ctx = { carPos: this.carPos, carVel: this.carVel, carValid: this.carValid, gravity: GRAVITY_VFX, time: 0 };
    // goal frame polylines (for spark fountains), indexed by the DEFENDING team of that goal
    for (const path of goalFramePaths(10)) {
      const n = path.points.length;
      const pts = new Float32Array(n * 3);
      const cum = new Float32Array(n);
      let total = 0;
      for (let i = 0; i < n; i++) {
        const p = path.points[i];
        pts[i * 3] = p.x;
        pts[i * 3 + 1] = p.y;
        pts[i * 3 + 2] = p.z;
        if (i > 0) total += p.distanceTo(path.points[i - 1]);
        cum[i] = total;
      }
      this.goalFrames[path.goal] = { pts, cum, total };
    }
    this.setQuality('high');
  }

  // ------------------------------------------------------------------------------------------------
  // public API
  // ------------------------------------------------------------------------------------------------

  setQuality(q: QualityPreset): void {
    const c = QUALITY[q] ?? QUALITY.high;
    this.add.limit = Math.min(MAX_CAP, c.cap);
    this.alpha.limit = Math.min(MAX_ALPHA_CAP, c.alphaCap);
    if (this.add.count > this.add.limit) this.add.count = this.add.limit;
    if (this.alpha.count > this.alpha.limit) this.alpha.count = this.alpha.limit;
    this.k = c.k;
  }

  /** Optional: tell the VFX which body style each car id uses (exact thruster / pad positions). Default: striker. */
  setCarStyle(carId: number, style: CarStyleId): void {
    if (carId >= 0 && carId < MAX_CARS) this.styles[carId] = style;
  }

  setCarStyles(styles: ReadonlyArray<CarStyleId>): void {
    for (let i = 0; i < styles.length && i < MAX_CARS; i++) this.styles[i] = styles[i];
  }

  clear(): void {
    this.add.clear();
    this.alpha.clear();
    this.shocks.clear();
    this.debris.clear();
    for (const s of this.slots) {
      s.key = -1;
      s.attached = false;
      s.count = 0;
      s.head = -1;
    }
    this.keyToSlot.fill(-1);
    for (let i = 0; i < this.emitters.length; i++) this.emitters[i].type = 0;
    this.prevThrValid.fill(0);
    this.ribbons.beginFrame();
    for (let i = 0; i < TRAIL_STRIPS; i++) this.ribbons.clearStrip(i);
    this.ribbons.commit();
    this.add.update(0, this.ctx);
    this.alpha.update(0, this.ctx);
  }

  /** Debug: sample of live additive particles (GPU-side values). */
  debugParticles(n = 8): unknown {
    return this.add.debugSample(n);
  }

  /**
   * Make every pooled mesh visible (drawing nothing) so that a following renderer.compile()/compileAsync() compiles
   * all VFX shaders up front (no hitch on the first goal / demolition). Pools re-hide themselves on the next update().
   */
  prewarm(): void {
    this.add.mesh.visible = true;
    this.alpha.mesh.visible = true;
    this.ribbons.mesh.visible = true;
    this.debris.mesh.visible = true;
    this.shocks.prewarm();
  }

  /** Live counts (debug overlay). */
  stats(): { additive: number; alpha: number; shocks: number; debris: number; trails: number } {
    let trails = 0;
    for (const s of this.slots) if (s.count > 0) trails++;
    return { additive: this.add.count, alpha: this.alpha.count, shocks: this.shocks.active, debris: this.debris.active, trails };
  }

  update(dt: number, time: number, snap: WorldSnapshot, camera: Camera): void {
    this.time = time;
    this.frame++;
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    const surge = snap.surge;
    const g = GRAVITY_VFX * (1 - 0.72 * clamp01(surge));
    this.ctx.gravity = g;
    this.ctx.time = time;

    // car lookup
    this.carValid.fill(0);
    this.carIndex.fill(-1);
    for (let i = 0; i < snap.cars.length; i++) {
      const c = snap.cars[i];
      if (c.id < 0 || c.id >= MAX_CARS) continue;
      this.carIndex[c.id] = i;
      this.carTeam[c.id] = c.team;
      if (c.demolished) continue;
      this.carValid[c.id] = 1;
      this.carPos[c.id * 3] = c.pos.x;
      this.carPos[c.id * 3 + 1] = c.pos.y;
      this.carPos[c.id * 3 + 2] = c.pos.z;
      this.carVel[c.id * 3] = c.vel.x;
      this.carVel[c.id * 3 + 1] = c.vel.y;
      this.carVel[c.id * 3 + 2] = c.vel.z;
    }

    this.ribbons.beginFrame();
    if (dt > 0) {
      for (let i = 0; i < snap.cars.length; i++) this.carContinuous(snap.cars[i], dt);
      this.ballContinuous(snap, dt);
      if (surge > 0.02) this.surgeMotes(dt, surge);
      this.updateEmitters(dt);
    }
    this.add.update(dt, this.ctx);
    this.alpha.update(dt, this.ctx);
    this.updateTrails(dt > 0);
    this.shocks.update(dt);
    this.debris.update(dt, g);
  }

  handleEvent(e: SimEvent, snap: WorldSnapshot): void {
    switch (e.type) {
      case 'ballHit':
        this.fxBallHit(e.pos.x, e.pos.y, e.pos.z, e.normal.x, e.normal.y, e.normal.z, e.strength, e.team, e.dodge);
        break;
      case 'ballBounce':
        this.fxBallBounce(e.pos.x, e.pos.y, e.pos.z, e.normal.x, e.normal.y, e.normal.z, e.speed, snap);
        break;
      case 'carImpact':
        this.fxSparks(e.pos.x, e.pos.y, e.pos.z, e.normal.x, e.normal.y, e.normal.z, clamp(e.speed * 2, 6, 60), 3 + e.speed * 0.5, FIRE, 1.0, 0.8);
        break;
      case 'carBump':
        this.fxBump(e.aId, e.bId, e.pos.x, e.pos.y, e.pos.z, e.speed);
        break;
      case 'jump':
        this.fxJump(this.findCar(snap, e.carId), e.double);
        break;
      case 'dodge':
        this.fxDodge(this.findCar(snap, e.carId));
        break;
      case 'land':
        this.fxLand(this.findCar(snap, e.carId), e.speed);
        break;
      case 'boostPickup':
        this.fxPickup(e.carId, e.padIndex, e.big, snap);
        break;
      case 'demolish':
        this.fxDemolish(e.victimId, e.pos.x, e.pos.y, e.pos.z, e.vel.x, e.vel.y, e.vel.z, snap);
        break;
      case 'respawn':
        this.fxRespawn(this.findCar(snap, e.carId));
        break;
      case 'pulse':
        this.fxPulse(e.carId, e.pos.x, e.pos.y, e.pos.z, e.hitBall, e.hitCarIds, snap);
        break;
      case 'chargeChange':
        this.fxCharge(e.team, e.level, e.prevLevel, snap);
        break;
      case 'goal':
        this.fxGoal(e.team, e.pos.x, e.pos.y, e.pos.z, e.charge);
        break;
      case 'surgeStart':
        this.fxSurgeStart();
        break;
      default:
        break;
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.add.dispose();
    this.alpha.dispose();
    this.ribbons.dispose();
    this.shocks.dispose();
    this.debris.dispose();
  }

  // ------------------------------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------------------------------

  private n(base: number): number {
    return Math.max(1, Math.round(base * this.k));
  }

  private findCar(snap: WorldSnapshot, id: number): CarSnapshot | null {
    for (let i = 0; i < snap.cars.length; i++) if (snap.cars[i].id === id) return snap.cars[i];
    return null;
  }

  private hard(id: number): CarHardpoints {
    return CAR_HARDPOINTS[this.styles[id >= 0 && id < MAX_CARS ? id : 0]];
  }

  private randDir(out: Vector3): Vector3 {
    const u = this.rng.signed();
    const th = this.rng.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    return out.set(Math.cos(th) * r, u, Math.sin(th) * r);
  }

  /** Direction in the hemisphere around n (spread 0 = along n, 1 = wide). */
  private hemiDir(nx: number, ny: number, nz: number, spread: number, out: Vector3): Vector3 {
    this.randDir(out).multiplyScalar(spread).add(_n.set(nx, ny, nz));
    if (out.lengthSq() < 1e-6) out.set(nx, ny + 1, nz);
    return out.normalize();
  }

  /** Two unit vectors perpendicular to n. */
  private basis(nx: number, ny: number, nz: number): void {
    _n.set(nx, ny, nz).normalize();
    if (Math.abs(_n.y) < 0.9) _t1.set(0, 1, 0).cross(_n).normalize();
    else _t1.set(1, 0, 0).cross(_n).normalize();
    _t2.crossVectors(_n, _t1);
  }

  private flash(x: number, y: number, z: number, size: number, life: number, c: Color, k: number): void {
    const P = this.P.reset();
    P.x = x;
    P.y = y;
    P.z = z;
    P.life = life;
    P.size0 = size * 0.6;
    P.size1 = size;
    P.color0(c.r, c.g, c.b, k).color1(c.r, c.g, c.b, k * 0.3);
    P.fadeIn = 0.02;
    P.shape = SHAPE_GLOW;
    this.add.spawn(P);
  }

  /** Generic spark burst in the hemisphere around a normal. */
  private fxSparks(x: number, y: number, z: number, nx: number, ny: number, nz: number, count: number, speed: number, c: Color, k: number, spread: number): void {
    const P = this.P.reset();
    const n = this.n(count);
    for (let i = 0; i < n; i++) {
      this.hemiDir(nx, ny, nz, spread, _v);
      const sp = speed * (0.35 + this.rng.next() * 0.9);
      P.x = x;
      P.y = y;
      P.z = z;
      P.vx = _v.x * sp;
      P.vy = _v.y * sp;
      P.vz = _v.z * sp;
      P.life = 0.25 + this.rng.next() * 0.45;
      P.size0 = 0.03 + this.rng.next() * 0.025;
      P.size1 = 0.01;
      P.color0(1, 0.95, 0.85, 3.0).color1(c.r, c.g, c.b, 2.2 * k);
      P.drag = 1.6;
      P.grav = 1;
      P.stretch = 0.032;
      P.shape = SHAPE_SPARK;
      P.flags = FLAG_FLOOR;
      P.fadeIn = 0;
      this.add.spawn(P);
    }
  }

  private worldPoint(c: CarSnapshot, lx: number, ly: number, lz: number, out: Vector3): Vector3 {
    return out.set(lx, ly, lz).applyQuaternion(c.quat).add(c.pos);
  }

  // ------------------------------------------------------------------------------------------------
  // continuous effects
  // ------------------------------------------------------------------------------------------------

  private carContinuous(c: CarSnapshot, dt: number): void {
    const id = c.id;
    if (id < 0 || id >= MAX_CARS) return;
    if (c.demolished) {
      this.prevThrValid[id] = 0;
      return;
    }
    const hp = this.hard(id);
    const team = c.team;
    const tc = TEAM_PRIMARY[team];
    const ts = TEAM_SECONDARY[team];
    const speed = c.vel.length();
    const back = _v2.set(0, 0, -1).applyQuaternion(c.quat);
    const bx = back.x;
    const by = back.y;
    const bz = back.z;

    // ---- boost exhaust + trails ----
    if (c.boosting) {
      this.exhaustAcc[id] += dt * 95 * this.k;
      const count = Math.floor(this.exhaustAcc[id]);
      this.exhaustAcc[id] -= count;
      for (let ti = 0; ti < 2 && ti < hp.thrusters.length; ti++) {
        const th = hp.thrusters[ti];
        this.worldPoint(c, th.x, th.y, th.z - 0.05, _v);
        const o = (id * 2 + ti) * 3;
        const hasPrev = this.prevThrValid[id] === 1;
        const px0 = hasPrev ? this.prevThr[o] : _v.x;
        const py0 = hasPrev ? this.prevThr[o + 1] : _v.y;
        const pz0 = hasPrev ? this.prevThr[o + 2] : _v.z;
        const P = this.P.reset();
        for (let j = 0; j < count; j++) {
          const f = (j + this.rng.next()) / Math.max(1, count);
          const sp = 5 + this.rng.next() * 4;
          P.x = px0 + (_v.x - px0) * f;
          P.y = py0 + (_v.y - py0) * f;
          P.z = pz0 + (_v.z - pz0) * f;
          P.vx = c.vel.x * 0.35 + bx * sp + this.rng.signed() * 1.1;
          P.vy = c.vel.y * 0.35 + by * sp + this.rng.signed() * 1.1;
          P.vz = c.vel.z * 0.35 + bz * sp + this.rng.signed() * 1.1;
          P.life = 0.18 + this.rng.next() * 0.22;
          P.size0 = 0.1 + this.rng.next() * 0.05;
          P.size1 = 0.34 + this.rng.next() * 0.15;
          P.color0(ts.r * 0.5 + 0.5, ts.g * 0.5 + 0.5, ts.b * 0.5 + 0.5, 2.2).color1(tc.r, tc.g, tc.b, 0.35);
          P.alpha = 0.7;
          P.drag = 3;
          P.shape = SHAPE_GLOW;
          P.fadeIn = 0.04;
          this.add.spawn(P);
          if (this.rng.next() < 0.18) {
            // hot sparks
            const P2 = P;
            P2.size0 = 0.025;
            P2.size1 = 0.006;
            P2.stretch = 0.03;
            P2.shape = SHAPE_SPARK;
            P2.life = 0.25 + this.rng.next() * 0.2;
            P2.color0(1, 0.95, 0.85, 3).color1(tc.r, tc.g, tc.b, 1.5);
            P2.vx += this.rng.signed() * 2;
            P2.vy += this.rng.signed() * 2;
            P2.vz += this.rng.signed() * 2;
            P2.alpha = 1;
            P2.grav = 0.4;
            this.add.spawn(P2);
            P2.stretch = 0;
            P2.grav = 0;
          }
        }
        this.prevThr[o] = _v.x;
        this.prevThr[o + 1] = _v.y;
        this.prevThr[o + 2] = _v.z;
        this.attachTrail(id * 8 + ti, _v.x, _v.y, _v.z, 0.15, 0.3, tc.r * 1.15, tc.g * 1.15, tc.b * 1.15, 0.06);
      }
      this.prevThrValid[id] = 1;
    } else {
      this.prevThrValid[id] = 0;
    }

    // ---- supersonic streaks ----
    if (c.supersonic) {
      for (let wi = 0; wi < 2 && wi < hp.wingtips.length; wi++) {
        const w = hp.wingtips[wi];
        this.worldPoint(c, w.x, w.y, w.z, _v);
        this.attachTrail(id * 8 + 2 + wi, _v.x, _v.y, _v.z, 0.05, 0.28, 1.2 + ts.r * 1.2, 1.2 + ts.g * 1.2, 1.2 + ts.b * 1.2, 0.1);
      }
    }

    // ---- hover shimmer dust (fast, skimming the floor) ----
    if (c.onGround && speed > 11 && c.pos.y < 1.2) {
      this.dustAcc[id] += dt * 26 * this.k * clamp01((speed - 11) / 10);
      const count = Math.floor(this.dustAcc[id]);
      this.dustAcc[id] -= count;
      const P = this.P.reset();
      for (let j = 0; j < count; j++) {
        const pad = hp.pads[2 + (j & 1)] ?? hp.pads[0];
        this.worldPoint(c, pad.x, -0.43, pad.z, _v);
        P.x = _v.x;
        P.y = _v.y;
        P.z = _v.z;
        P.vx = -c.vel.x * 0.12 + this.rng.signed() * 0.6;
        P.vy = 0.4 + this.rng.next() * 0.6;
        P.vz = -c.vel.z * 0.12 + this.rng.signed() * 0.6;
        P.life = 0.35 + this.rng.next() * 0.3;
        P.size0 = 0.08;
        P.size1 = 0.26;
        P.color0(tc.r * 0.5 + 0.2, tc.g * 0.5 + 0.25, tc.b * 0.5 + 0.35, 0.9).color1(tc.r, tc.g, tc.b, 0.2);
        P.alpha = 0.45;
        P.drag = 2;
        P.shape = SHAPE_GLOW;
        P.fadeIn = 0.2;
        this.add.spawn(P);
      }
    }
  }

  private ballColor(snap: WorldSnapshot, out: Color, hot: Color): void {
    const b = snap.ball;
    if (b.charge <= 0 || b.chargeTeam === -1) {
      out.setRGB(0.45, 0.72, 1.0);
      hot.copy(NEUTRAL_COLOR);
    } else {
      out.copy(TEAM_PRIMARY[b.chargeTeam]);
      hot.copy(TEAM_SECONDARY[b.chargeTeam]);
      if (b.charge >= 3) hot.lerp(WHITE, 0.6);
    }
  }

  private ballContinuous(snap: WorldSnapshot, dt: number): void {
    const b = snap.ball;
    if (!b.visible) return;
    const speed = b.vel.length();
    const superNova = b.charge >= 3 && b.chargeTeam !== -1;
    if (speed > 18 || (superNova && speed > 8)) {
      this.ballColor(snap, _col, _col2);
      const fast = clamp01((speed - 18) / 25);
      const w = (superNova ? 1.35 : 0.9) * (0.75 + 0.3 * fast) * BALL.radius;
      const k = (superNova ? 1.3 : 0.75) * (0.5 + 0.5 * clamp01((speed - 12) / 20));
      this.attachTrail(BALL_TRAIL_KEY, b.pos.x, b.pos.y, b.pos.z, w, superNova ? 0.42 : 0.3, _col.r * k, _col.g * k, _col.b * k, 0.12);
    }
    if (superNova) {
      this.ballColor(snap, _col, _col2);
      this.ballSparkAcc += dt * (40 + speed * 3) * this.k;
      const count = Math.floor(this.ballSparkAcc);
      this.ballSparkAcc -= count;
      const P = this.P.reset();
      for (let j = 0; j < count; j++) {
        this.randDir(_v);
        P.x = b.pos.x + _v.x * BALL.radius * 1.05;
        P.y = b.pos.y + _v.y * BALL.radius * 1.05;
        P.z = b.pos.z + _v.z * BALL.radius * 1.05;
        const sp = 1.5 + this.rng.next() * 3;
        P.vx = b.vel.x * 0.25 + _v.x * sp;
        P.vy = b.vel.y * 0.25 + _v.y * sp;
        P.vz = b.vel.z * 0.25 + _v.z * sp;
        P.life = 0.3 + this.rng.next() * 0.4;
        P.size0 = 0.035;
        P.size1 = 0.01;
        P.stretch = 0.035;
        P.shape = SHAPE_SPARK;
        P.color0(_col2.r, _col2.g, _col2.b, 3).color1(_col.r, _col.g, _col.b, 2);
        P.drag = 1;
        P.fadeIn = 0;
        this.add.spawn(P);
      }
    }
  }

  private surgeMotes(dt: number, surge: number): void {
    this.moteAcc += dt * 70 * this.k * surge;
    const count = Math.floor(this.moteAcc);
    this.moteAcc -= count;
    for (let i = 0; i < count; i++) this.spawnMote(0.5 + this.rng.next() * 3);
  }

  private spawnMote(life: number): void {
    const P = this.P.reset();
    P.x = this.rng.signed() * 33;
    P.y = 0.3 + this.rng.next() * 14;
    P.z = this.rng.signed() * 47;
    P.vx = this.rng.signed() * 0.3;
    P.vy = 0.5 + this.rng.next() * 1.3;
    P.vz = this.rng.signed() * 0.3;
    P.life = life + 2;
    P.size0 = 0.14 + this.rng.next() * 0.16;
    P.size1 = P.size0 * 1.4;
    const c = SURGE_COLOR;
    const w = this.rng.next() < 0.3 ? 0.6 : 0;
    P.color0(c.r + w, c.g + w, c.b + w, 1.8).color1(c.r, c.g, c.b, 1.2);
    P.alpha = 0.9;
    P.turb = 1.2;
    P.seed = this.rng.next();
    P.shape = SHAPE_EMBER;
    P.fadeIn = 0.25;
    this.add.spawn(P);
  }

  // ------------------------------------------------------------------------------------------------
  // trails
  // ------------------------------------------------------------------------------------------------

  private attachTrail(key: number, x: number, y: number, z: number, width: number, life: number, r: number, g: number, b: number, minDist: number): void {
    if (key < 0 || key >= TRAIL_KEYS) return;
    let si = this.keyToSlot[key];
    let s: TrailSlot;
    if (si < 0) {
      // find a free slot (no points alive)
      si = -1;
      for (let i = 0; i < TRAIL_STRIPS; i++) {
        const t = this.slots[i];
        if (t.key === -1 && t.count === 0) {
          si = i;
          break;
        }
      }
      if (si < 0) return;
      s = this.slots[si];
      s.key = key;
      s.count = 0;
      s.head = -1;
      this.keyToSlot[key] = si;
    } else {
      s = this.slots[si];
    }
    s.attached = true;
    s.touched = this.frame;
    s.width = width;
    s.life = life;
    s.r = r;
    s.g = g;
    s.b = b;
    s.minDist = minDist;
    s.cx = x;
    s.cy = y;
    s.cz = z;
    // store a point when the emitter moved enough since the last stored point
    let push = s.count === 0;
    if (!push) {
      const h = s.head;
      const dx = x - s.xs[h];
      const dy = y - s.ys[h];
      const dz = z - s.zs[h];
      push = dx * dx + dy * dy + dz * dz > minDist * minDist;
    }
    if (push) {
      s.head = (s.head + 1) % TRAIL_POINTS;
      s.xs[s.head] = x;
      s.ys[s.head] = y;
      s.zs[s.head] = z;
      s.ts[s.head] = this.time;
      if (s.count < TRAIL_POINTS) s.count++;
    }
  }

  private updateTrails(advancing: boolean): void {
    const rb = this.ribbons;
    for (let si = 0; si < TRAIL_STRIPS; si++) {
      const s = this.slots[si];
      // (paused frames touch nothing: keep trails attached so they continue seamlessly on resume)
      if (advancing && s.key !== -1 && s.touched !== this.frame) {
        // emitter stopped: detach, let the points fade out
        this.keyToSlot[s.key] = -1;
        s.key = -1;
        s.attached = false;
      }
      if (s.count === 0) continue;
      rb.begin(si);
      const life = s.life;
      let alive = 0;
      if (s.attached) rb.push(si, s.cx, s.cy, s.cz, s.width, 1, s.r, s.g, s.b);
      let idx = s.head;
      for (let k = 0; k < s.count; k++) {
        const age = this.time - s.ts[idx];
        if (age > life) break;
        const f = 1 - age / life;
        const a = f * Math.sqrt(f);
        rb.push(si, s.xs[idx], s.ys[idx], s.zs[idx], s.width * (0.25 + 0.75 * f), a, s.r * a, s.g * a, s.b * a);
        alive++;
        idx = (idx - 1 + TRAIL_POINTS) % TRAIL_POINTS;
      }
      rb.end(si);
      if (alive === 0 && !s.attached) {
        s.count = 0;
        s.head = -1;
      }
    }
    rb.commit();
  }

  // ------------------------------------------------------------------------------------------------
  // timed emitters
  // ------------------------------------------------------------------------------------------------

  private addEmitter(type: number, dur: number, x: number, y: number, z: number, team: Team, rate: number, param = 0, gain = 1): void {
    for (let i = 0; i < this.emitters.length; i++) {
      const e = this.emitters[i];
      if (e.type !== 0) continue;
      e.type = type;
      e.t = dur;
      e.dur = dur;
      e.x = x;
      e.y = y;
      e.z = z;
      e.team = team;
      e.rate = rate;
      e.acc = 0;
      e.param = param;
      e.gain = gain;
      return;
    }
  }

  private updateEmitters(dt: number): void {
    for (let i = 0; i < this.emitters.length; i++) {
      const e = this.emitters[i];
      if (e.type === 0) continue;
      e.t -= dt;
      if (e.t <= 0) {
        e.type = 0;
        continue;
      }
      const f = e.t / e.dur; // 1 -> 0
      e.acc += dt * e.rate * this.k * (0.35 + 0.65 * f);
      const count = Math.floor(e.acc);
      e.acc -= count;
      if (e.type === EMIT_FOUNTAIN) this.emitFountain(e, count);
      else if (e.type === EMIT_SMOKE) this.emitSmoke(e, count);
      else if (e.type === EMIT_CONVERGE) this.emitConverge(e, count);
    }
  }

  private emitFountain(e: Emitter, count: number): void {
    const frame = this.goalFrames[e.param];
    if (!frame) return;
    const tc = TEAM_PRIMARY[e.team];
    const ts = TEAM_SECONDARY[e.team];
    const g = e.gain;
    const P = this.P.reset();
    for (let i = 0; i < count; i++) {
      // random point along the frame polyline (by arc length)
      const d = this.rng.next() * frame.total;
      let j = 1;
      while (j < frame.cum.length - 1 && frame.cum[j] < d) j++;
      const seg = frame.cum[j] - frame.cum[j - 1];
      const f = seg > 1e-6 ? (d - frame.cum[j - 1]) / seg : 0;
      const a = (j - 1) * 3;
      const b = j * 3;
      P.x = frame.pts[a] + (frame.pts[b] - frame.pts[a]) * f;
      P.y = frame.pts[a + 1] + (frame.pts[b + 1] - frame.pts[a + 1]) * f;
      P.z = frame.pts[a + 2] + (frame.pts[b + 2] - frame.pts[a + 2]) * f;
      const toField = P.z > 0 ? -1 : 1;
      P.vx = this.rng.signed() * 2.5;
      P.vy = 3 + this.rng.next() * 7;
      P.vz = toField * (1.5 + this.rng.next() * 4);
      P.life = 0.8 + this.rng.next() * 0.9;
      P.size0 = 0.08 + this.rng.next() * 0.07;
      P.size1 = 0.02;
      P.stretch = 0.045;
      P.shape = SHAPE_SPARK;
      const hot = this.rng.next() < 0.5;
      P.color0(1, 0.97, 0.9, 3.4 * g).color1(hot ? ts.r : tc.r, hot ? ts.g : tc.g, hot ? ts.b : tc.b, 2.4 * g);
      P.grav = 1;
      P.drag = 0.4;
      P.flags = FLAG_FLOOR;
      P.fadeIn = 0;
      this.add.spawn(P);
    }
  }

  private emitSmoke(e: Emitter, count: number): void {
    const P = this.P.reset();
    for (let i = 0; i < count; i++) {
      P.x = e.x + this.rng.signed() * 0.6;
      P.y = e.y + this.rng.next() * 0.5;
      P.z = e.z + this.rng.signed() * 0.6;
      P.vx = this.rng.signed() * 0.8;
      P.vy = 0.8 + this.rng.next() * 1.4;
      P.vz = this.rng.signed() * 0.8;
      P.life = 1.4 + this.rng.next() * 1.2;
      P.size0 = 0.6 + this.rng.next() * 0.4;
      P.size1 = 2.4 + this.rng.next() * 1.4;
      const gr = 0.07 + this.rng.next() * 0.05;
      P.color0(gr * 3.2, gr * 1.6, gr * 0.9).color1(gr, gr * 1.05, gr * 1.25);
      P.alpha = 0.55;
      P.drag = 1.2;
      P.turb = 0.8;
      P.seed = this.rng.next();
      P.rot = this.rng.next() * 6.28;
      P.rotVel = this.rng.signed() * 0.8;
      P.shape = SHAPE_SMOKE;
      P.fadeIn = 0.12;
      this.alpha.spawn(P);
    }
  }

  private emitConverge(e: Emitter, count: number): void {
    const tc = TEAM_PRIMARY[e.team];
    const ts = TEAM_SECONDARY[e.team];
    const P = this.P.reset();
    for (let i = 0; i < count; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = 1.6 + this.rng.next() * 1.2;
      P.x = e.x + Math.cos(a) * r;
      P.y = e.y + this.rng.next() * 2.5;
      P.z = e.z + Math.sin(a) * r;
      const sp = 3.5 + this.rng.next() * 2;
      P.vx = -Math.cos(a) * sp;
      P.vy = -0.8 - this.rng.next();
      P.vz = -Math.sin(a) * sp;
      P.life = 0.35 + this.rng.next() * 0.25;
      P.size0 = 0.045;
      P.size1 = 0.02;
      P.stretch = 0.035;
      P.shape = SHAPE_SPARK;
      P.color0(ts.r, ts.g, ts.b, 2.5).color1(tc.r, tc.g, tc.b, 2.5);
      P.fadeIn = 0.2;
      this.add.spawn(P);
    }
  }

  // ------------------------------------------------------------------------------------------------
  // one-shot effects
  // ------------------------------------------------------------------------------------------------

  private fxBallHit(x: number, y: number, z: number, nx: number, ny: number, nz: number, strength: number, team: Team, dodge: boolean): void {
    const tc = TEAM_PRIMARY[team];
    const ts = TEAM_SECONDARY[team];
    const s01 = clamp01(strength / 30);
    const P = this.P.reset();
    const count = Math.min(90, this.n(8 + strength * 2.4));
    // normal = car -> ball at the contact point: spray tangentially and back toward the hitter
    // (never into the ball, which would hide the sparks behind its core)
    this.basis(nx, ny, nz);
    for (let i = 0; i < count; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const u = -0.75 + this.rng.next() * 0.95;
      _v.copy(_t1).multiplyScalar(Math.cos(a)).addScaledVector(_t2, Math.sin(a)).addScaledVector(_n, u).normalize();
      const sp = (5 + strength * 0.75) * (0.35 + this.rng.next() * 0.85);
      P.x = x;
      P.y = y;
      P.z = z;
      P.vx = _v.x * sp;
      P.vy = _v.y * sp;
      P.vz = _v.z * sp;
      P.life = 0.22 + this.rng.next() * 0.4;
      P.size0 = 0.028 + this.rng.next() * 0.03;
      P.size1 = 0.008;
      P.stretch = 0.03;
      P.shape = SHAPE_SPARK;
      P.color0(1, 0.97, 0.92, 3.0).color1(ts.r * 0.4 + tc.r * 0.6, ts.g * 0.4 + tc.g * 0.6, ts.b * 0.4 + tc.b * 0.6, 2.6);
      P.drag = 1.8;
      P.grav = 0.8;
      P.flags = FLAG_FLOOR;
      P.fadeIn = 0;
      this.add.spawn(P);
    }
    // soft impact glow
    this.flash(x, y, z, 1.0 + s01 * 2.2, 0.16 + s01 * 0.1, tc, 1.2 + s01 * 1.5);
    if (strength > 13 || dodge) {
      this.shocks.spawn(SHOCK_RING, x, y, z, nx, ny, nz, 0.25, 1.1 + s01 * 1.3, 0.26, tc.r, tc.g, tc.b, 1.2 + s01 * 0.8, 0.09, 3, 1, 0.15);
      // a few hex shards
      const hs = this.n(6 + s01 * 10);
      for (let i = 0; i < hs; i++) {
        this.hemiDir(-nx, -ny, -nz, 1.2, _v);
        const sp = 3 + this.rng.next() * 6;
        P.x = x;
        P.y = y;
        P.z = z;
        P.vx = _v.x * sp;
        P.vy = _v.y * sp;
        P.vz = _v.z * sp;
        P.life = 0.35 + this.rng.next() * 0.3;
        P.size0 = 0.11 + this.rng.next() * 0.08;
        P.size1 = 0.03;
        P.stretch = 0;
        P.shape = SHAPE_HEX;
        P.rot = this.rng.next() * 6.28;
        P.rotVel = this.rng.signed() * 8;
        P.color0(ts.r, ts.g, ts.b, 2.2).color1(tc.r, tc.g, tc.b, 1.2);
        P.drag = 2.5;
        P.grav = 0.2;
        P.flags = 0;
        this.add.spawn(P);
      }
    }
  }

  private fxBallBounce(x: number, y: number, z: number, nx: number, ny: number, nz: number, speed: number, snap: WorldSnapshot): void {
    if (speed < 3) return;
    this.ballColor(snap, _col, _col2);
    const s01 = clamp01((speed - 3) / 20);
    const P = this.P.reset();
    const count = this.n(4 + speed * 1.6);
    this.basis(nx, ny, nz);
    for (let i = 0; i < Math.min(count, 60); i++) {
      // mostly tangential spray
      const a = this.rng.next() * Math.PI * 2;
      const up = 0.25 + this.rng.next() * 0.6;
      _v.copy(_t1).multiplyScalar(Math.cos(a)).addScaledVector(_t2, Math.sin(a)).addScaledVector(_n, up).normalize();
      const sp = (2 + speed * 0.45) * (0.4 + this.rng.next() * 0.8);
      P.x = x;
      P.y = y;
      P.z = z;
      P.vx = _v.x * sp;
      P.vy = _v.y * sp;
      P.vz = _v.z * sp;
      P.life = 0.25 + this.rng.next() * 0.35;
      P.size0 = 0.03;
      P.size1 = 0.008;
      P.stretch = 0.03;
      P.shape = SHAPE_SPARK;
      P.color0(_col2.r, _col2.g, _col2.b, 2.6).color1(_col.r, _col.g, _col.b, 1.8);
      P.drag = 1.5;
      P.grav = 1;
      P.flags = FLAG_FLOOR;
      P.fadeIn = 0;
      this.add.spawn(P);
    }
    if (speed > 9) {
      this.shocks.spawn(SHOCK_RING, x + nx * 0.04, y + ny * 0.04, z + nz * 0.04, nx, ny, nz, 0.4, 1.5 + s01 * 2.2, 0.4, _col.r, _col.g, _col.b, 0.9 + s01 * 0.8, 0.12, 3, 1, 0.1);
      // dust ring along the surface
      const dn = this.n(10 + s01 * 18);
      for (let i = 0; i < dn; i++) {
        const a = (i / dn) * Math.PI * 2 + this.rng.next() * 0.3;
        _v.copy(_t1).multiplyScalar(Math.cos(a)).addScaledVector(_t2, Math.sin(a));
        const sp = 2 + s01 * 4 + this.rng.next();
        P.x = x + _v.x * 0.6;
        P.y = y + _v.y * 0.6 + ny * 0.1;
        P.z = z + _v.z * 0.6;
        P.vx = _v.x * sp + nx * 0.4;
        P.vy = _v.y * sp + ny * 0.4;
        P.vz = _v.z * sp + nz * 0.4;
        P.life = 0.5 + this.rng.next() * 0.4;
        P.size0 = 0.25;
        P.size1 = 0.8;
        P.stretch = 0;
        P.shape = SHAPE_GLOW;
        P.color0(_col.r, _col.g, _col.b, 0.6).color1(_col.r, _col.g, _col.b, 0.1);
        P.alpha = 0.6;
        P.drag = 3;
        P.grav = 0;
        P.flags = 0;
        P.fadeIn = 0.1;
        this.add.spawn(P);
      }
    }
  }

  private fxBump(aId: number, bId: number, x: number, y: number, z: number, speed: number): void {
    const ta = TEAM_PRIMARY[(this.carTeam[aId] ?? 0) as Team];
    const tb = TEAM_PRIMARY[(this.carTeam[bId] ?? 1) as Team];
    const c = clamp(speed * 2.2, 14, 70);
    this.fxSparks(x, y, z, 0, 1, 0, c * 0.5, 4 + speed * 0.45, ta, 1, 1.2);
    this.fxSparks(x, y, z, 0, 1, 0, c * 0.5, 4 + speed * 0.45, tb, 1, 1.2);
    this.flash(x, y, z, 1.4 + speed * 0.05, 0.14, WHITE, 1.6);
  }

  private fxJump(c: CarSnapshot | null, double: boolean): void {
    if (!c) return;
    const hp = this.hard(c.id);
    const tc = TEAM_PRIMARY[c.team];
    const up = _n.set(0, 1, 0).applyQuaternion(c.quat);
    const ux = up.x;
    const uy = up.y;
    const uz = up.z;
    const P = this.P.reset();
    for (let pi = 0; pi < hp.pads.length; pi++) {
      const pad = hp.pads[pi];
      this.worldPoint(c, pad.x, pad.y - 0.05, pad.z, _v);
      const cnt = this.n(double ? 4 : 7);
      for (let j = 0; j < cnt; j++) {
        this.randDir(_v2);
        const sp = 2 + this.rng.next() * 2.5;
        P.x = _v.x;
        P.y = _v.y;
        P.z = _v.z;
        P.vx = -ux * sp * 1.2 + _v2.x * sp;
        P.vy = -uy * sp * 1.2 + _v2.y * sp;
        P.vz = -uz * sp * 1.2 + _v2.z * sp;
        P.life = 0.25 + this.rng.next() * 0.2;
        P.size0 = 0.12;
        P.size1 = 0.3;
        P.color0(tc.r * 0.6 + 0.4, tc.g * 0.6 + 0.4, tc.b * 0.6 + 0.4, 1.6).color1(tc.r, tc.g, tc.b, 0.3);
        P.alpha = 0.8;
        P.drag = 4;
        P.shape = SHAPE_GLOW;
        P.fadeIn = 0.02;
        this.add.spawn(P);
      }
    }
    if (double) {
      this.shocks.spawn(SHOCK_RING, c.pos.x - ux * 0.25, c.pos.y - uy * 0.25, c.pos.z - uz * 0.25, ux, uy, uz, 0.4, 1.5, 0.3, tc.r, tc.g, tc.b, 1.8, 0.25);
    } else {
      // ring on the surface the car jumped from
      this.shocks.spawn(SHOCK_RING, c.pos.x - ux * 0.43, c.pos.y - uy * 0.43, c.pos.z - uz * 0.43, ux, uy, uz, 0.5, 1.9, 0.35, tc.r, tc.g, tc.b, 1.5, 0.2);
    }
  }

  private fxDodge(c: CarSnapshot | null): void {
    if (!c) return;
    const tc = TEAM_PRIMARY[c.team];
    const P = this.P.reset();
    const cnt = this.n(14);
    for (let i = 0; i < cnt; i++) {
      this.randDir(_v);
      P.x = c.pos.x + _v.x * 0.5;
      P.y = c.pos.y + _v.y * 0.3;
      P.z = c.pos.z + _v.z * 0.5;
      P.vx = c.vel.x * 0.3 + _v.x * 2;
      P.vy = c.vel.y * 0.3 + _v.y * 2;
      P.vz = c.vel.z * 0.3 + _v.z * 2;
      P.life = 0.3;
      P.size0 = 0.08;
      P.size1 = 0.22;
      P.color0(tc.r, tc.g, tc.b, 1.4).color1(tc.r, tc.g, tc.b, 0.2);
      P.alpha = 0.7;
      P.drag = 3;
      P.shape = SHAPE_GLOW;
      this.add.spawn(P);
    }
  }

  private fxLand(c: CarSnapshot | null, speed: number): void {
    if (!c || speed < 2) return;
    const up = _n.set(0, 1, 0).applyQuaternion(c.quat);
    const ux = up.x;
    const uy = up.y;
    const uz = up.z;
    const s01 = clamp01((speed - 2) / 12);
    const gx = c.pos.x - ux * 0.43;
    const gy = c.pos.y - uy * 0.43;
    const gz = c.pos.z - uz * 0.43;
    this.basis(ux, uy, uz);
    const P = this.P.reset();
    const cnt = this.n(8 + s01 * 26);
    const tc = TEAM_PRIMARY[c.team];
    for (let i = 0; i < cnt; i++) {
      const a = (i / cnt) * Math.PI * 2 + this.rng.next() * 0.4;
      _v.copy(_t1).multiplyScalar(Math.cos(a)).addScaledVector(_t2, Math.sin(a));
      const sp = 1.5 + s01 * 4 + this.rng.next();
      P.x = gx + _v.x * 0.5;
      P.y = gy + _v.y * 0.5 + uy * 0.05;
      P.z = gz + _v.z * 0.5;
      P.vx = _v.x * sp + ux * 0.3;
      P.vy = _v.y * sp + uy * 0.3;
      P.vz = _v.z * sp + uz * 0.3;
      P.life = 0.4 + this.rng.next() * 0.35;
      P.size0 = 0.18;
      P.size1 = 0.55;
      P.color0(0.4 + tc.r * 0.3, 0.5 + tc.g * 0.3, 0.7 + tc.b * 0.3, 0.7).color1(0.3, 0.4, 0.6, 0.1);
      P.alpha = 0.55;
      P.drag = 3.2;
      P.shape = SHAPE_GLOW;
      P.fadeIn = 0.08;
      this.add.spawn(P);
    }
    this.shocks.spawn(SHOCK_RING, gx + ux * 0.02, gy + uy * 0.02, gz + uz * 0.02, ux, uy, uz, 0.5, 1.4 + s01 * 1.4, 0.35, 0.5 + tc.r * 0.4, 0.6 + tc.g * 0.4, 0.8 + tc.b * 0.4, 0.8 + s01, 0.2);
  }

  private fxPickup(carId: number, padIndex: number, big: boolean, snap: WorldSnapshot): void {
    const pad = PAD_LAYOUT[padIndex];
    if (!pad) return;
    const c = BOOST_COLOR;
    const y = big ? 1.3 : 0.62;
    const P = this.P.reset();
    const cnt = this.n(big ? 70 : 24);
    const target = carId >= 0 && carId < MAX_CARS ? carId : -1;
    // Gold sparks burst from the pad and swirl into the car. They ride along with it (inherit its velocity; the
    // homing chases the car in its own frame) and fade out as they reach the body, so nothing is left behind or piles
    // up between the car and the chase camera 3-4 m behind it.
    const car = this.findCar(snap, carId);
    const cvx = car ? car.vel.x : 0;
    const cvy = car ? car.vel.y : 0;
    const cvz = car ? car.vel.z : 0;
    for (let i = 0; i < cnt; i++) {
      this.randDir(_v);
      const r = big ? 0.6 : 0.25;
      P.x = pad.x + _v.x * r;
      P.y = y + _v.y * r * (big ? 1.6 : 1);
      P.z = pad.z + _v.z * r;
      const sp = 3 + this.rng.next() * 3.5;
      P.vx = cvx + _v.x * sp;
      P.vy = cvy + Math.abs(_v.y) * sp + 1.2;
      P.vz = cvz + _v.z * sp;
      P.life = 0.55 + this.rng.next() * 0.35;
      P.size0 = 0.03 + this.rng.next() * 0.02;
      P.size1 = 0.015;
      P.stretch = 0.012;
      P.shape = SHAPE_SPARK;
      P.color0(c.r, c.g, c.b, 2.2).color1(c.r, c.g, c.b, 1.6);
      P.flags = FLAG_HOMING;
      P.target = target;
      P.seed = this.rng.next();
      P.fadeIn = 0.05;
      this.add.spawn(P);
    }
    this.flash(pad.x, y, pad.z, big ? 3.6 : 1.6, big ? 0.3 : 0.2, c, big ? 2.4 : 1.8);
    this.shocks.spawn(SHOCK_RING, pad.x, 0.06, pad.z, 0, 1, 0, 0.5, big ? 3.2 : 1.8, big ? 0.5 : 0.35, c.r, c.g, c.b, big ? 2.2 : 1.5, 0.18);
    if (big) this.shocks.spawn(SHOCK_BEAM, pad.x, 0, pad.z, 0, 1, 0, 0.6, 0.9, 0.45, c.r, c.g, c.b, 1.6, 0.2, 2, 8);
  }

  private fxDemolish(victimId: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, snap: WorldSnapshot): void {
    const team = (victimId >= 0 && victimId < MAX_CARS ? this.carTeam[victimId] : 0) as Team;
    void snap;
    const tc = TEAM_PRIMARY[team];
    const P = this.P.reset();
    // flash
    this.flash(x, y, z, 5, 0.18, WHITE, 2.6);
    this.flash(x, y, z, 5.5, 0.45, FIRE, 2.0);
    // sparks
    const sc = this.n(200);
    for (let i = 0; i < sc; i++) {
      this.randDir(_v);
      if (_v.y < 0) _v.y *= -0.5;
      const sp = 7 + this.rng.next() * 20;
      P.x = x;
      P.y = y;
      P.z = z;
      P.vx = vx * 0.3 + _v.x * sp;
      P.vy = vy * 0.3 + _v.y * sp;
      P.vz = vz * 0.3 + _v.z * sp;
      P.life = 0.4 + this.rng.next() * 0.8;
      P.size0 = 0.04 + this.rng.next() * 0.04;
      P.size1 = 0.01;
      P.stretch = 0.038;
      P.shape = SHAPE_SPARK;
      const teamSpark = this.rng.next() < 0.35;
      if (teamSpark) P.color0(1, 0.95, 0.9, 3).color1(tc.r, tc.g, tc.b, 2.2);
      else P.color0(1, 0.9, 0.7, 3.4).color1(FIRE.r, FIRE.g, FIRE.b, 2);
      P.drag = 1.1;
      P.grav = 1;
      P.flags = FLAG_FLOOR;
      P.fadeIn = 0;
      this.add.spawn(P);
    }
    // fireball glows
    const fc = this.n(60);
    for (let i = 0; i < fc; i++) {
      this.randDir(_v);
      const sp = 1 + this.rng.next() * 6;
      P.x = x + _v.x * 0.3;
      P.y = y + _v.y * 0.3;
      P.z = z + _v.z * 0.3;
      P.vx = vx * 0.25 + _v.x * sp;
      P.vy = vy * 0.25 + _v.y * sp + 1;
      P.vz = vz * 0.25 + _v.z * sp;
      P.life = 0.45 + this.rng.next() * 0.55;
      P.size0 = 0.5 + this.rng.next() * 0.6;
      P.size1 = 1.6 + this.rng.next() * 1.2;
      P.stretch = 0;
      P.shape = SHAPE_GLOW;
      P.color0(1, 0.48, 0.14, 2.2).color1(0.5, 0.06, 0.02, 0.35);
      P.alpha = 0.8;
      P.drag = 2.6;
      P.grav = -0.15;
      P.flags = 0;
      P.fadeIn = 0.04;
      this.add.spawn(P);
    }
    // smoke column (alpha pool) + debris shards
    this.addEmitter(EMIT_SMOKE, 0.7, x, y, z, team, 60);
    const dc = Math.round(18 * Math.min(1.2, this.k + 0.2));
    for (let i = 0; i < dc; i++) {
      this.randDir(_v);
      if (_v.y < 0.1) _v.y = 0.1 + this.rng.next() * 0.5;
      const sp = 4 + this.rng.next() * 9;
      const hot = this.rng.next() < 0.5;
      this.debris.spawn(
        x,
        y,
        z,
        vx * 0.4 + _v.x * sp,
        vy * 0.4 + _v.y * sp + 2,
        vz * 0.4 + _v.z * sp,
        0.06 + this.rng.next() * 0.09,
        1.6 + this.rng.next() * 1.4,
        hot ? 1 : tc.r,
        hot ? 0.45 : tc.g,
        hot ? 0.12 : tc.b,
        hot ? 3.5 : 2.5,
        this.rng.signed() * 14,
      );
    }
    this.shocks.spawn(SHOCK_RING, x, Math.max(0.06, y - 0.4), z, 0, 1, 0, 0.5, 7, 0.55, FIRE.r, FIRE.g, FIRE.b, 2.2, 0.16);
    this.shocks.spawn(SHOCK_SPHERE, x, y, z, 0, 1, 0, 0.3, 4.2, 0.4, 1, 0.55, 0.2, 1.8, 0.2, 3, 1, 0.1);
  }

  private fxRespawn(c: CarSnapshot | null): void {
    if (!c) return;
    const tc = TEAM_PRIMARY[c.team];
    const ts = TEAM_SECONDARY[c.team];
    const gy = Math.max(0, c.pos.y - CAR.rideHeight);
    this.shocks.spawn(SHOCK_BEAM, c.pos.x, gy, c.pos.z, 0, 1, 0, 0.75, 0.35, 0.8, tc.r * 0.6 + ts.r * 0.4, tc.g * 0.6 + ts.g * 0.4, tc.b * 0.6 + ts.b * 0.4, 2.0, 0.2, 2, 11, 0.3);
    this.shocks.spawn(SHOCK_RING, c.pos.x, gy + 0.05, c.pos.z, 0, 1, 0, 2.6, 0.6, 0.6, tc.r, tc.g, tc.b, 2, 0.2, 2, 1, 0.4);
    this.flash(c.pos.x, c.pos.y, c.pos.z, 3, 0.35, ts, 2);
    this.addEmitter(EMIT_CONVERGE, 0.5, c.pos.x, gy, c.pos.z, c.team, 160);
  }

  private fxPulse(carId: number, x: number, y: number, z: number, hitBall: boolean, hitCarIds: number[], snap: WorldSnapshot): void {
    const team = (carId >= 0 && carId < MAX_CARS ? this.carTeam[carId] : 0) as Team;
    const tc = TEAM_PRIMARY[team];
    const ts = TEAM_SECONDARY[team];
    const R = PULSE.radius;
    this.shocks.spawn(SHOCK_SPHERE, x, y, z, 0, 1, 0, 0.6, R, 0.5, tc.r, tc.g, tc.b, 2.2, 0.2, 3.2, 1, 0.55);
    this.shocks.spawn(SHOCK_SPHERE, x, y, z, 0, 1, 0, 0.3, R * 0.72, 0.36, ts.r, ts.g, ts.b, 1.4, 0.2, 2.5, 1, 0.3);
    if (y < 3) this.shocks.spawn(SHOCK_RING, x, 0.07, z, 0, 1, 0, 0.6, R, 0.5, tc.r, tc.g, tc.b, 2.4, 0.1, 3.2, 1, 0.5);
    this.flash(x, y, z, 3.2, 0.2, ts, 2.4);
    // sparks riding the shock front
    const P = this.P.reset();
    const sc = this.n(140);
    for (let i = 0; i < sc; i++) {
      this.randDir(_v);
      if (y < 2 && _v.y < 0) _v.y *= -0.3;
      const sp = 18 + this.rng.next() * 8;
      P.x = x + _v.x * 0.6;
      P.y = y + _v.y * 0.6;
      P.z = z + _v.z * 0.6;
      P.vx = _v.x * sp;
      P.vy = _v.y * sp;
      P.vz = _v.z * sp;
      P.life = 0.3 + this.rng.next() * 0.18;
      P.size0 = 0.045;
      P.size1 = 0.015;
      P.stretch = 0.025;
      P.shape = SHAPE_SPARK;
      P.color0(ts.r, ts.g, ts.b, 3).color1(tc.r, tc.g, tc.b, 2.2);
      P.drag = 2.5;
      P.flags = 0;
      P.fadeIn = 0;
      this.add.spawn(P);
    }
    if (hitBall && snap.ball.visible) {
      const b = snap.ball.pos;
      this.fxSparks(b.x, b.y, b.z, b.x - x, b.y - y, b.z - z, 40, 10, tc, 1, 0.9);
      this.flash(b.x, b.y, b.z, 3, 0.2, tc, 2);
    }
    for (let i = 0; i < hitCarIds.length; i++) {
      const id = hitCarIds[i];
      if (id < 0 || id >= MAX_CARS || !this.carValid[id]) continue;
      const cx = this.carPos[id * 3];
      const cy = this.carPos[id * 3 + 1];
      const cz = this.carPos[id * 3 + 2];
      this.fxSparks(cx, cy, cz, cx - x, cy - y + 0.5, cz - z, 25, 7, tc, 1, 1);
    }
  }

  private fxCharge(team: Team | -1, level: number, prevLevel: number, snap: WorldSnapshot): void {
    const b = snap.ball;
    if (!b.visible) return;
    const x = b.pos.x;
    const y = b.pos.y;
    const z = b.pos.z;
    const tc = team === -1 ? NEUTRAL_COLOR : TEAM_PRIMARY[team];
    const ts = team === -1 ? NEUTRAL_COLOR : TEAM_SECONDARY[team];
    // ring facing the camera
    _v.subVectors(this.camPos, b.pos).normalize();
    const P = this.P.reset();
    if (level < prevLevel) {
      // decay / reset: small fizzle
      const cnt = this.n(22);
      for (let i = 0; i < cnt; i++) {
        this.randDir(_v2);
        P.x = x + _v2.x * 1.05;
        P.y = y + _v2.y * 1.05;
        P.z = z + _v2.z * 1.05;
        P.vx = _v2.x * 1.5;
        P.vy = _v2.y * 1.5 - 0.5;
        P.vz = _v2.z * 1.5;
        P.life = 0.4 + this.rng.next() * 0.3;
        P.size0 = 0.1;
        P.size1 = 0.02;
        P.color0(tc.r, tc.g, tc.b, 1.2).color1(0.2, 0.2, 0.25, 0.3);
        P.shape = SHAPE_EMBER;
        P.seed = this.rng.next();
        this.add.spawn(P);
      }
      return;
    }
    const supernova = level >= 3;
    this.shocks.spawn(SHOCK_RING, x, y, z, _v.x, _v.y, _v.z, 1.1, supernova ? 5.5 : 2.8 + level * 0.4, supernova ? 0.6 : 0.45, tc.r, tc.g, tc.b, supernova ? 3 : 2, 0.18);
    this.flash(x, y, z, supernova ? 7 : 3.2, supernova ? 0.4 : 0.25, supernova ? WHITE : ts, supernova ? 2.6 : 1.6);
    const cnt = this.n(supernova ? 260 : 50 + level * 35);
    for (let i = 0; i < cnt; i++) {
      this.randDir(_v2);
      const sp = (supernova ? 9 : 4) + this.rng.next() * (supernova ? 16 : 6);
      P.x = x + _v2.x * 1.05;
      P.y = y + _v2.y * 1.05;
      P.z = z + _v2.z * 1.05;
      P.vx = _v2.x * sp;
      P.vy = _v2.y * sp;
      P.vz = _v2.z * sp;
      P.life = 0.35 + this.rng.next() * (supernova ? 0.8 : 0.4);
      P.size0 = 0.04 + this.rng.next() * 0.035;
      P.size1 = 0.01;
      P.stretch = 0.03;
      P.shape = SHAPE_SPARK;
      P.color0(ts.r * 0.5 + 0.5, ts.g * 0.5 + 0.5, ts.b * 0.5 + 0.5, 3).color1(tc.r, tc.g, tc.b, 2.4);
      P.drag = 2;
      P.grav = supernova ? 0.3 : 0;
      P.flags = 0;
      P.fadeIn = 0;
      this.add.spawn(P);
    }
    if (supernova) {
      this.shocks.spawn(SHOCK_SPHERE, x, y, z, 0, 1, 0, 1, 7.5, 0.7, tc.r, tc.g, tc.b, 2.4, 0.2, 3, 1, 0.3);
      this.shocks.spawn(SHOCK_RING, x, y, z, 0, 1, 0, 1.2, 8, 0.8, ts.r, ts.g, ts.b, 2.2, 0.12);
      const ec = this.n(90);
      for (let i = 0; i < ec; i++) {
        this.randDir(_v2);
        const r = 1.2 + this.rng.next() * 2.5;
        P.x = x + _v2.x * r;
        P.y = y + _v2.y * r;
        P.z = z + _v2.z * r;
        P.vx = _v2.x * 0.8;
        P.vy = _v2.y * 0.8 + 0.4;
        P.vz = _v2.z * 0.8;
        P.life = 1.2 + this.rng.next() * 1.2;
        P.size0 = 0.08;
        P.size1 = 0.04;
        P.stretch = 0;
        P.shape = SHAPE_EMBER;
        P.seed = this.rng.next();
        P.turb = 1.5;
        P.color0(ts.r, ts.g, ts.b, 2.6).color1(tc.r, tc.g, tc.b, 1.6);
        P.drag = 0.8;
        this.add.spawn(P);
        P.turb = 0;
      }
    }
  }

  /** THE goal explosion. */
  private fxGoal(team: Team, x: number, y: number, z: number, charge: number): void {
    const tc = TEAM_PRIMARY[team];
    const ts = TEAM_SECONDARY[team];
    const fieldZ = z > 0 ? -1 : 1;
    const big = 1 + 0.15 * clamp(charge - 1, 0, 2);
    const P = this.P.reset();
    // Seen from close by (a player right at the goal, the replay hero shot) the additive layers stack up into a flat
    // white-out. What piles up on screen scales with the camera distance (ka = 0.22 at 15 m, 0.58 for the ~26 m replay
    // hero shot, ~1 from 40 m so the far burst is unchanged): the soft layers (flashes, glow puffs, beam, domes) dim
    // and the flashes shorten, and the spark burst thins out (fewer, thinner, fewer white-hot sparks) so it reads as
    // streaks, not a white mass.
    const dCam = Math.sqrt((x - this.camPos.x) ** 2 + (y - this.camPos.y) ** 2 + (z - this.camPos.z) ** 2);
    const ka = 0.2 + 0.8 * smoothstep(12, 42, dCam);
    const lk = 0.6 + 0.4 * ka;

    // flashes (the white-hot one falls off faster: the team-colored bloom carries the burst close by)
    this.flash(x, y, z, 14 * big, 0.28 * lk, WHITE, 3.5 * ka * Math.sqrt(ka));
    this.flash(x, y, z, 24 * big, 0.6 * lk, tc, 2.2 * ka);

    // core spark burst (biased toward the field), bursting from the ball's shell and fading in over the first few
    // frames (instead of piling up on the burst point)
    const sc = this.n(720 * big * (0.35 + 0.65 * ka));
    const sSize = 0.6 + 0.4 * ka;
    const sGain = 0.6 + 0.4 * ka;
    const sHot = 0.03 + 0.15 * ka; // pure white-hot share
    const sWarm = 0.25 + 0.35 * ka; // + white -> team share (the rest: secondary -> team)
    const r0 = BALL.radius * 0.8;
    for (let i = 0; i < sc; i++) {
      this.randDir(_v);
      _v.z += fieldZ * 0.25;
      _v.y = Math.abs(_v.y) * 1.1 + 0.15;
      _v.normalize();
      const sp = 14 + this.rng.next() * 34;
      P.x = x + _v.x * r0;
      P.y = y + _v.y * r0;
      P.z = z + _v.z * r0;
      P.vx = _v.x * sp;
      P.vy = _v.y * sp;
      P.vz = _v.z * sp;
      P.life = 0.9 + this.rng.next() * 1.4;
      P.size0 = (0.11 + this.rng.next() * 0.1) * sSize;
      P.size1 = 0.03 * sSize;
      P.stretch = 0.05;
      P.shape = SHAPE_SPARK;
      const w = this.rng.next();
      if (w < sHot) P.color0(1, 0.98, 0.94, 3.6 * sGain).color1(1, 1, 1, 1.6 * sGain);
      else if (w < sWarm) P.color0(1, 0.97, 0.9, 3.4 * sGain).color1(tc.r, tc.g, tc.b, 3.0 * sGain);
      else P.color0(ts.r, ts.g, ts.b, 3.2 * sGain).color1(tc.r, tc.g, tc.b, 2.6 * sGain);
      P.drag = 1.15;
      P.grav = 0.55;
      P.flags = FLAG_FLOOR;
      P.fadeIn = 0.035;
      this.add.spawn(P);
    }
    // volumetric glow puffs: the biggest overlapping layer, so the steepest falloff with distance (total haze energy
    // ~ka^1.5). Close by, every puff is a screen-sized quad: spawn fewer of them (fill cost) and keep the energy.
    const gn = 0.3 + 0.7 * ka;
    const kg = (ka * Math.sqrt(ka)) / gn;
    const gc = this.n(110 * big * gn);
    for (let i = 0; i < gc; i++) {
      this.randDir(_v);
      _v.z += fieldZ * 0.3;
      const sp = 2 + this.rng.next() * 12;
      P.x = x;
      P.y = y;
      P.z = z;
      P.vx = _v.x * sp;
      P.vy = _v.y * sp + 1.5;
      P.vz = _v.z * sp;
      P.life = 0.6 + this.rng.next() * 0.8;
      P.size0 = 0.9 + this.rng.next() * 1.0;
      P.size1 = 2.6 + this.rng.next() * 1.8;
      P.stretch = 0;
      P.shape = SHAPE_GLOW;
      const h = this.rng.next() < 0.3;
      P.color0(h ? ts.r : tc.r, h ? ts.g : tc.g, h ? ts.b : tc.b, 1.9 * kg).color1(tc.r, tc.g, tc.b, 0.2 * kg);
      P.alpha = 0.6;
      P.drag = 2.2;
      P.grav = 0;
      P.flags = 0;
      P.fadeIn = 0.03;
      this.add.spawn(P);
    }
    // hex shell fragments (particles) + 3D shards
    const hc = this.n(120 * big);
    for (let i = 0; i < hc; i++) {
      this.randDir(_v);
      _v.z += fieldZ * 0.4;
      _v.normalize();
      const sp = 6 + this.rng.next() * 16;
      P.x = x + _v.x;
      P.y = y + _v.y;
      P.z = z + _v.z;
      P.vx = _v.x * sp;
      P.vy = _v.y * sp + 2;
      P.vz = _v.z * sp;
      P.life = 1 + this.rng.next() * 1.2;
      P.size0 = 0.3 + this.rng.next() * 0.3;
      P.size1 = 0.1;
      P.rot = this.rng.next() * 6.28;
      P.rotVel = this.rng.signed() * 7;
      P.shape = SHAPE_HEX;
      P.color0(ts.r, ts.g, ts.b, 2.6).color1(tc.r, tc.g, tc.b, 1.4);
      P.drag = 1.4;
      P.grav = 0.5;
      P.flags = FLAG_FLOOR;
      P.alpha = 1;
      this.add.spawn(P);
    }
    P.rotVel = 0;
    const dc = Math.round(26 * Math.min(1.2, this.k + 0.2));
    for (let i = 0; i < dc; i++) {
      this.randDir(_v);
      _v.z += fieldZ * 0.6;
      _v.y = Math.abs(_v.y) + 0.2;
      _v.normalize();
      const sp = 6 + this.rng.next() * 14;
      this.debris.spawn(x, y, z, _v.x * sp, _v.y * sp, _v.z * sp, 0.1 + this.rng.next() * 0.14, 2.2 + this.rng.next() * 1.4, tc.r, tc.g, tc.b, 3.2, this.rng.signed() * 10);
    }
    // lingering embers
    const ec = this.n(320 * big);
    for (let i = 0; i < ec; i++) {
      this.randDir(_v);
      const r = this.rng.next() * 6;
      P.x = x + _v.x * r;
      P.y = Math.max(0.3, y + _v.y * r * 0.7 + 1);
      P.z = z + _v.z * r + fieldZ * 2;
      P.vx = _v.x * (0.5 + this.rng.next() * 2);
      P.vy = 0.4 + this.rng.next() * 1.8;
      P.vz = _v.z * (0.5 + this.rng.next() * 2) + fieldZ;
      P.life = 2.4 + this.rng.next() * 2.8;
      P.size0 = 0.1 + this.rng.next() * 0.1;
      P.size1 = 0.04;
      P.rot = 0;
      P.shape = SHAPE_EMBER;
      P.seed = this.rng.next();
      P.turb = 1.4;
      P.color0(ts.r, ts.g, ts.b, 2.6).color1(tc.r, tc.g, tc.b, 1.6);
      P.drag = 0.9;
      P.grav = 0;
      P.flags = 0;
      P.fadeIn = 0.15;
      this.add.spawn(P);
    }
    P.turb = 0;
    // shockwaves
    this.shocks.spawn(SHOCK_SPHERE, x, y, z, 0, 1, 0, 0.8, 16 * big, 0.9, tc.r, tc.g, tc.b, 2.0 * ka, 0.2, 3.2, 1, 0.25);
    this.shocks.spawn(SHOCK_SPHERE, x, y, z, 0, 1, 0, 0.5, 8 * big, 0.5, ts.r, ts.g, ts.b, 1.6 * ka, 0.2, 2.6, 1, 0.2);
    this.shocks.spawn(SHOCK_RING, x, y, z, 0, 0, fieldZ, 1, 20 * big, 1.0, tc.r, tc.g, tc.b, 2.6, 0.04, 3.4, 1, 0.3);
    this.shocks.spawn(SHOCK_RING, x, 0.1, z, 0, 1, 0, 1, 26 * big, 1.25, ts.r, ts.g, ts.b, 2.4, 0.025, 3, 1, 0.35);
    // light pillar: seen from close / mid range it is a screen-tall white column (plus its floor reflection)
    this.shocks.spawn(SHOCK_BEAM, x, 0, z, 0, 1, 0, 2.2, 3.5, 0.9, tc.r, tc.g, tc.b, 1.8 * ka * ka, 0.2, 2, 30, 0.2);
    // spark fountains from the scored goal's frame (goal defended by the other team)
    const goalIdx = team === 0 ? 1 : 0;
    this.addEmitter(EMIT_FOUNTAIN, 2.0, x, y, z, team, 380, goalIdx, 0.5 + 0.5 * ka);
  }

  private fxSurgeStart(): void {
    const cnt = this.n(320);
    for (let i = 0; i < cnt; i++) this.spawnMote(1 + this.rng.next() * 3);
    const c = SURGE_COLOR;
    this.shocks.spawn(SHOCK_RING, 0, 0.12, 0, 0, 1, 0, 2, 60, 1.6, c.r, c.g, c.b, 2, 0.05, 2.5, 1, 0.3);
  }
}

export { SHAPE_RING };
