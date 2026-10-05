/**
 * NOVABALL render-world — ArenaView: floor (planar reflection), force field, goals and stadium.
 * Implements IArenaView. Owned by RenderSystem (render.arena).
 */
import { Color, Group, Vector3, type Object3D, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import type { IArenaView } from '../contracts';
import { arenaSDF } from '../sim/arena';
import { ARENA } from '../sim/constants';
import type { Team, Vec3Like, WorldSnapshot } from '../sim/types';
import { ARENA_THEME, BALL_THEME, TEAMS } from '../theme';
import { CORE_HX, CORE_HZ, CORE_R } from './world/ArenaGeometry';
import { createArenaUniforms, MAX_POOLS, MAX_RIPPLES, type ArenaUniforms } from './world/ArenaUniforms';
import { Floor } from './world/Floor';
import { ForceField } from './world/ForceField';
import { Goals } from './world/Goals';
import { PlanarReflection } from './world/PlanarReflection';
import type { WorldQuality } from './world/quality';
import { ScoreboardCanvas } from './world/Scoreboard';
import { Stadium } from './world/Stadium';

/** Must match NB_RIPPLE_LIFE in ArenaUniforms GLSL. */
const RIPPLE_LIFE = 1.9;
const TEAM_COLORS: [Color, Color] = [new Color(TEAMS[0].primary), new Color(TEAMS[1].primary)];
const NEUTRAL = new Color(BALL_THEME.neutral);
const IMPACT_WALL = new Color(ARENA_THEME.forceField).lerp(new Color(0.8, 0.9, 1.0), 0.35);

export class ArenaView implements IArenaView {
  readonly object = new Group();
  readonly uniforms: ArenaUniforms;
  readonly floor: Floor;
  readonly forceField: ForceField;
  readonly goals: Goals;
  readonly stadium: Stadium;
  readonly reflection: PlanarReflection;
  readonly scoreboard: ScoreboardCanvas;
  /** Last ball position / visibility seen in update() (used by RenderSystem for the shadow focus). */
  readonly ballPos = new Vector3(0, 1, 0);
  ballVisible = false;
  private quality: WorldQuality;
  private ripIdx = 0;
  /** JS-side ripple ring buffer: [x, y, z, t0, r, g, b, strength] per slot; packed into uniforms each frame. */
  private readonly ripStore = new Float32Array(MAX_RIPPLES * 8).fill(-1000);
  private lastTime = 0;
  private readonly goalFlash = [0, 0];
  private stadiumFlash = 0;
  private readonly excite = [0, 0];
  private readonly tmpC = new Color();
  /**
   * Objects hidden while rendering the floor reflection: the floor itself and the sky dome (the mirror only showed it
   * at 30 % — invisible against the arena lights — yet it cost a full-screen pass in the reflection, ~0.23 ms).
   */
  private readonly hideForReflection: Object3D[] = [];
  private lastRipple = { t: -10, x: 0, y: 0, z: 0 };
  private readonly poolSrc: PoolSource[] = Array.from({ length: MAX_POOLS }, () => new PoolSource());
  /** Goal-celebration flash decay (1/s): ~1.25 s, so the goal / net / portal read again well before the replay. */
  goalFlashDecay = 0.8;

  constructor(quality: WorldQuality) {
    this.quality = quality;
    this.object.name = 'ArenaView';
    this.uniforms = createArenaUniforms();
    this.scoreboard = new ScoreboardCanvas();
    this.floor = new Floor({ uniforms: this.uniforms, anisotropy: quality.anisotropy });
    this.floor.setLite(quality.floorLite);
    this.forceField = new ForceField(this.uniforms, quality.forceFieldDetail);
    this.goals = new Goals(this.uniforms);
    this.stadium = new Stadium(this.uniforms, quality.crowdCount, quality.beams, this.scoreboard.texture);
    this.reflection = new PlanarReflection(quality.reflectionScale > 0 ? quality.reflectionScale : 0.25);
    this.setFloorReflection(quality.reflectionScale > 0);
    this.object.add(this.floor.mesh, this.forceField.mesh, this.goals.group, this.stadium.group);
    this.hideForReflection.push(this.floor.mesh);
  }

  get reflectionEnabled(): boolean {
    return this.quality.reflectionScale > 0;
  }

  /** Render the planar floor reflection for this frame (call before the main render). */
  renderReflection(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void {
    if (!this.reflectionEnabled) return;
    const ff = this.forceField;
    ff.mesh.material = ff.reflectionMaterial;
    this.uniforms.uReflPass.value = 1;
    this.reflection.render(renderer, scene, camera, this.hideForReflection);
    this.uniforms.uReflPass.value = 0;
    ff.mesh.material = ff.material;
  }

  private setFloorReflection(on: boolean): void {
    const r = this.reflection;
    if (on) this.floor.setReflection(r.target.texture, r.blurred.texture, r.textureMatrix);
    else this.floor.setReflection(null, null, r.textureMatrix);
  }

  /** The sky dome (owned by Environment) is skipped in the floor reflection pass. */
  setSkyMesh(sky: Object3D): void {
    if (!this.hideForReflection.includes(sky)) this.hideForReflection.push(sky);
  }

  setQuality(q: WorldQuality): void {
    this.quality = q;
    if (q.reflectionScale > 0) this.reflection.scale = q.reflectionScale;
    this.setFloorReflection(q.reflectionScale > 0);
    this.stadium.setQuality(q.crowdCount, q.beams);
    this.forceField.setDetail(q.forceFieldDetail);
    this.floor.setLite(q.floorLite);
  }

  /** Drawing-buffer size changes (reflection target) and the point-size scale (px per meter at 1 m). */
  setSize(drawW: number, drawH: number, pxScale: number): void {
    this.reflection.setSize(drawW, drawH);
    this.stadium.setPixelScale(pxScale);
  }

  /** Per-frame point-size scale (tracks FOV changes such as the boost FOV kick). */
  setPointScale(pxScale: number): void {
    this.stadium.setPixelScale(pxScale);
  }

  update(dt: number, time: number, snap: WorldSnapshot): void {
    const u = this.uniforms;
    if (time < this.lastTime - 0.25) this.clearRipples(); // time went backwards (replay seek)
    this.lastTime = time;
    u.uTime.value = time;
    u.uSurge.value = snap.surge;

    // ---- light pools: ball + cars. Sources near the FORCE FIELD (walls / fillets / ceiling) are packed first (the
    // force field only evaluates those: uWallPoolCount), the floor evaluates all of them.
    const ball = snap.ball;
    this.ballVisible = ball.visible;
    this.ballPos.copy(ball.pos);
    const src = this.poolSrc;
    let ns = 0;
    if (ball.visible) {
      const lvl = Math.max(0, Math.min(3, Math.round(ball.charge)));
      const c = ball.charge > 0 && ball.chargeTeam !== -1 ? TEAM_COLORS[ball.chargeTeam] : NEUTRAL;
      const k = 0.45 * BALL_THEME.levelIntensity[lvl];
      src[ns++].set(ball.pos.x, ball.pos.y, ball.pos.z, 5.0 + lvl * 0.8, c.r * k, c.g * k, c.b * k);
    }
    for (let i = 0; i < snap.cars.length && ns < MAX_POOLS; i++) {
      const car = snap.cars[i];
      if (car.demolished) continue;
      const c = TEAM_COLORS[car.team];
      const k = 0.2 + (car.boosting ? 0.28 : 0) + (car.supersonic ? 0.12 : 0);
      src[ns++].set(car.pos.x, car.pos.y, car.pos.z, car.boosting ? 2.7 : 2.2, c.r * k, c.g * k, c.b * k);
    }
    const pp = u.uPoolPos.value;
    const pc = u.uPoolCol.value;
    let n = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < ns; i++) {
        const sp = src[i];
        const nearWall = forceFieldDistance(sp.x, sp.y, sp.z) < sp.r * 2.6;
        if (nearWall !== (pass === 0)) continue;
        pp[n].set(sp.x, sp.y, sp.z, sp.r);
        pc[n].set(sp.cr, sp.cg, sp.cb, 0);
        n++;
      }
      if (pass === 0) u.uWallPoolCount.value = n;
    }
    u.uPoolCount.value = n;
    for (; n < MAX_POOLS; n++) pp[n].w = 0;
    this.packRipples(time);

    // ---- crowd excitement (ball near a goal), smoothed
    const bz = ball.visible ? ball.pos.z : 0;
    const t0 = smoothstep(ARENA.halfLength * 0.45, ARENA.halfLength * 0.92, -bz);
    const t1 = smoothstep(ARENA.halfLength * 0.45, ARENA.halfLength * 0.92, bz);
    const k = 1 - Math.exp(-dt * 2.5);
    this.excite[0] += (t0 - this.excite[0]) * k;
    this.excite[1] += (t1 - this.excite[1]) * k;
    u.uExcite.value.set(this.excite[0], this.excite[1]);

    // ---- goal celebration decay
    this.goalFlash[0] = Math.max(0, this.goalFlash[0] - dt * this.goalFlashDecay);
    this.goalFlash[1] = Math.max(0, this.goalFlash[1] - dt * this.goalFlashDecay);
    this.stadiumFlash = Math.max(0, this.stadiumFlash - dt * 0.35);
    u.uGoalFlash.value.set(easeFlash(this.goalFlash[0]), easeFlash(this.goalFlash[1]));
    u.uStadiumFlash.value = easeFlash(this.stadiumFlash);
  }

  onImpact(pos: Vec3Like, normal: Vec3Like, strength: number, color?: string): void {
    const s = Math.max(0, Math.min(1, strength));
    if (s <= 0.01) return;
    const t = this.lastTime;
    const lr = this.lastRipple;
    // merge bursts of contacts at the same spot (rolling / multi-contact frames)
    if (t - lr.t < 0.08 && (pos.x - lr.x) ** 2 + (pos.y - lr.y) ** 2 + (pos.z - lr.z) ** 2 < 4) return;
    lr.t = t;
    lr.x = pos.x;
    lr.y = pos.y;
    lr.z = pos.z;
    const i = this.ripIdx;
    this.ripIdx = (this.ripIdx + 1) % MAX_RIPPLES;
    const c = this.tmpC;
    if (color) c.set(color);
    else if (normal.y > 0.7) c.setRGB(0.55, 0.75, 1.0);
    else c.copy(IMPACT_WALL);
    const k = 0.8 + s * 1.7;
    const r = this.ripStore;
    const o = i * 8;
    r[o] = pos.x;
    r[o + 1] = pos.y;
    r[o + 2] = pos.z;
    r[o + 3] = t;
    r[o + 4] = c.r * k;
    r[o + 5] = c.g * k;
    r[o + 6] = c.b * k;
    r[o + 7] = s;
    this.packRipples(t);
  }

  /** Copy the live ripples (age < lifetime) to the front of the uniform arrays + count. */
  private packRipples(time: number): void {
    const u = this.uniforms;
    const rp = u.uRipplePos.value;
    const rc = u.uRippleCol.value;
    const r = this.ripStore;
    let n = 0;
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const o = i * 8;
      const age = time - r[o + 3];
      if (age < 0 || age > RIPPLE_LIFE) continue;
      rp[n].set(r[o], r[o + 1], r[o + 2], r[o + 3]);
      rc[n].set(r[o + 4], r[o + 5], r[o + 6], r[o + 7]);
      n++;
    }
    u.uRippleCount.value = n;
  }

  onGoal(scoringTeam: Team, pos: Vec3Like): void {
    // team 0 attacks +Z => the +Z goal (index 1) was scored in
    const goalIdx = scoringTeam === 0 ? 1 : 0;
    this.goalFlash[goalIdx] = 1;
    this.stadiumFlash = 1;
    this.uniforms.uFlashColor.value.copy(TEAM_COLORS[scoringTeam]);
    this.onImpact(pos, { x: 0, y: 0, z: scoringTeam === 0 ? -1 : 1 }, 1, TEAMS[scoringTeam].secondary);
    this.lastRipple.t = -10;
  }

  setScoreboard(score: [number, number], clock: number, overtime: boolean): void {
    this.scoreboard.draw(score, clock, overtime);
  }

  /** Redraw canvas textures after the display font has loaded. */
  refreshCanvases(): void {
    this.scoreboard.redraw();
    this.floor.refreshEmblem();
  }

  clearRipples(): void {
    this.ripStore.fill(-1000);
    this.uniforms.uRippleCount.value = 0;
  }

  dispose(): void {
    this.floor.dispose();
    this.forceField.dispose();
    this.goals.dispose();
    this.stadium.dispose();
    this.reflection.dispose();
    this.scoreboard.dispose();
  }
}

class PoolSource {
  x = 0;
  y = 0;
  z = 0;
  r = 0;
  cr = 0;
  cg = 0;
  cb = 0;
  set(x: number, y: number, z: number, r: number, cr: number, cg: number, cb: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.r = r;
    this.cr = cr;
    this.cg = cg;
    this.cb = cb;
  }
}

/**
 * Distance from a point to the force-field surfaces (walls, fillets, ceiling — NOT the flat floor). arenaSDF alone
 * counted the floor, so every car on the pitch was "near a wall" and the force field evaluated every light pool on
 * every pixel (~0.7 ms of a ~8 ms frame).
 */
function forceFieldDistance(x: number, y: number, z: number): number {
  // signed horizontal distance to the flat-floor footprint (where the fillet ramps start); > 0 over the fillets
  const qx = Math.abs(x) - CORE_HX + CORE_R;
  const qz = Math.abs(z) - CORE_HZ + CORE_R;
  const d2 = Math.min(Math.max(qx, qz), 0) + Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) - CORE_R;
  if (d2 >= 0) return arenaSDF(x, y, z);
  // over the flat floor: the nearest force field is the ceiling or the foot of a fillet
  return Math.min(ARENA.height - y, Math.hypot(d2, Math.max(0, y)));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Flash envelope: instant attack, eased release. */
function easeFlash(x: number): number {
  return x * x * (3 - 2 * x);
}
