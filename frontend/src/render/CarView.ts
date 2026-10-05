/**
 * CarView — procedural sci-fi hover car (3 styles), fully GPU-cheap:
 *   shell (1 draw call, casts shadows) + emissive trims (1) + additive plumes/hover cones (1) + nameplate sprite (1).
 * Geometry is shared between cars of the same style; materials are per car (paint / team / animated uniforms).
 */
import { Color, Group, Mesh, Quaternion, Sprite, SpriteMaterial, Vector3, type Camera } from 'three';
import { LAYER_MAIN_ONLY, type CarViewOptions, type ICarView } from '../contracts';
import { CAR } from '../sim/constants';
import type { CarSnapshot, CarStyleId, Team } from '../sim/types';
import { TEAMS } from '../theme';
import { acquireCarGeometry, releaseCarGeometry, type CarGeometrySet } from './actors/carDesigns';
import {
  createCarBodyMaterial,
  createCarFxMaterial,
  createCarGlowMaterial,
  type BodyMaterialHandle,
  type FxUniforms,
  type GlowUniforms,
} from './actors/carMaterials';
import { NameplateTexture } from './actors/textures';
import { clamp, clamp01, damp, smoothstep } from './actors/util';

const DEG = Math.PI / 180;
const MAX_BANK = 10 * DEG;
const MAX_PITCH = 3 * DEG;
const NAMEPLATE_HEIGHT = 1.3;

const _v = new Vector3();
const _cam = new Vector3();
const _q = new Quaternion();

let seedCounter = 0;

export class CarView implements ICarView {
  readonly object = new Group();
  /** Inner group: visual-only bank / pitch / hover bob (the root carries the exact sim transform). */
  private readonly body = new Group();
  private readonly shell: Mesh;
  private readonly glow: Mesh;
  private readonly fx: Mesh;
  private readonly bodyMat: BodyMaterialHandle;
  private readonly glowMat: ReturnType<typeof createCarGlowMaterial>;
  private readonly fxMat: ReturnType<typeof createCarFxMaterial>;
  private readonly gu: GlowUniforms;
  private readonly fu: FxUniforms;
  private readonly geo: CarGeometrySet;
  private readonly style: CarStyleId;
  private readonly team: Team;
  private readonly teamColor: Color;
  private readonly nameplate: Sprite | null = null;
  private readonly nameTex: NameplateTexture | null = null;
  private readonly seed: number;

  // smoothed visual state
  private bank = 0;
  private pitch = 0;
  private boost = 0;
  private brake = 0;
  private ground = 1;
  private superAmt = 0;
  private chase = 0;
  private wasDemolished = false;

  constructor(opts: CarViewOptions) {
    this.style = opts.style;
    this.team = opts.team;
    this.seed = (seedCounter++ * 2.399963) % (Math.PI * 2);
    this.teamColor = new Color(TEAMS[opts.team].primary);
    this.geo = acquireCarGeometry(opts.style);

    this.bodyMat = createCarBodyMaterial(new Color(opts.paint));
    this.glowMat = createCarGlowMaterial(this.teamColor);
    this.fxMat = createCarFxMaterial(this.teamColor);
    this.gu = this.glowMat.uniforms;
    this.fu = this.fxMat.uniforms;
    this.fu.uSeed.value = this.seed * 10;
    this.gu.uIntensity.value = 2.6;

    this.shell = new Mesh(this.geo.shell, this.bodyMat.material);
    this.shell.castShadow = true;
    this.shell.receiveShadow = false;
    this.shell.name = 'carShell';
    this.glow = new Mesh(this.geo.glow, this.glowMat);
    this.glow.name = 'carGlow';
    this.fx = new Mesh(this.geo.fx, this.fxMat);
    this.fx.name = 'carFx';
    this.fx.renderOrder = 2;
    this.body.add(this.shell, this.glow, this.fx);
    this.object.add(this.body);
    this.object.name = `car:${opts.name}`;

    if (opts.nameplate) {
      this.nameTex = new NameplateTexture(opts.name, TEAMS[opts.team].primary, false);
      const mat = new SpriteMaterial({
        map: this.nameTex.texture,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        fog: false,
        color: 0xe8e8e8,
      });
      const sp = new Sprite(mat);
      sp.center.set(0.5, 0.15);
      sp.layers.set(LAYER_MAIN_ONLY);
      sp.renderOrder = 10;
      sp.name = 'nameplate';
      this.nameplate = sp;
      this.object.add(sp);
    }
  }

  update(s: CarSnapshot, dt: number, time: number, camera: Camera): void {
    if (s.demolished) {
      this.object.visible = false;
      this.wasDemolished = true;
      return;
    }
    this.object.visible = true;
    this.object.position.copy(s.pos);
    this.object.quaternion.copy(s.quat);
    if (this.wasDemolished) {
      // respawned: reset smoothing so nothing "swings" in
      this.wasDemolished = false;
      this.bank = this.pitch = 0;
      this.boost = 0;
    }

    // local-frame velocity
    _q.copy(s.quat).invert();
    _v.copy(s.vel).applyQuaternion(_q);
    const fwd = _v.z;
    const speed = s.vel.length();
    const speed01 = clamp01(speed / CAR.maxSpeed);

    // ---- visual-only juice on the inner body group ----
    const g = s.onGround ? 1 : 0;
    this.ground += (g - this.ground) * damp(g > this.ground ? 20 : 6, dt);
    const lean = clamp(Math.abs(fwd) / 12, 0, 1) * (s.powersliding ? 1.25 : 1);
    const bankTarget = clamp(s.steer * lean, -1, 1) * MAX_BANK * (0.35 + 0.65 * this.ground);
    const accel = s.boosting ? 1 : s.throttle;
    const braking = s.throttle < -0.1 && fwd > 1.5 ? 1 : 0;
    const pitchTarget = (-clamp(accel, -1, 1) * MAX_PITCH + braking * MAX_PITCH * 0.6) * this.ground;
    this.bank += (bankTarget - this.bank) * damp(7, dt);
    this.pitch += (pitchTarget - this.pitch) * damp(6, dt);
    this.body.rotation.set(this.pitch, 0, this.bank);
    const bob = (Math.sin(time * 2.2 + this.seed) * 0.007 + Math.sin(time * 3.9 + this.seed * 2.3) * 0.0035) * this.ground;
    this.body.position.y = bob;

    // ---- thrusters / pads / lights ----
    const boostT = s.boosting ? 1 : 0;
    this.boost += (boostT - this.boost) * damp(boostT > this.boost ? 16 : 7, dt);
    this.brake += (braking - this.brake) * damp(12, dt);
    const superT = s.supersonic ? 1 : 0;
    this.superAmt += (superT - this.superAmt) * damp(superT > this.superAmt ? 6 : 3, dt);
    this.chase = (this.chase + dt * (0.55 + 1.6 * speed01 + 1.2 * this.boost)) % 1;

    const flicker = 0.92 + 0.08 * Math.sin(time * 61 + this.seed) * Math.sin(time * 37.3);
    const idleLen = 0.14 + 0.08 * clamp01(Math.abs(s.throttle)) + 0.05 * speed01;
    const boostLen = (1.05 + 0.25 * this.superAmt) * flicker;
    this.fu.uTime.value = time;
    this.fu.uBoost.value = this.boost;
    this.fu.uPlumeLen.value = idleLen + (boostLen - idleLen) * this.boost;
    this.fu.uPlumeWidth.value = 0.72 + 0.34 * this.boost + 0.08 * this.superAmt;
    this.fu.uPlumeGain.value = 1 + 0.35 * this.superAmt;
    const pulse = 0.5 + 0.5 * Math.sin(time * 5.5 + this.seed * 3);
    this.fu.uPad.value = 0.75 + 0.25 * pulse;
    this.fu.uGround.value = 0.18 + 0.82 * this.ground;

    this.gu.uTime.value = time;
    this.gu.uBoost.value = this.boost;
    this.gu.uBrake.value = this.brake;
    this.gu.uPad.value = pulse;
    this.gu.uChase.value = this.chase;

    // supersonic shimmer: team-colored fresnel rim on the paint
    const shimmer = this.superAmt * (0.75 + 0.25 * Math.sin(time * 23 + this.seed));
    this.bodyMat.rim.value.copy(this.teamColor).multiplyScalar(1.6 * shimmer);

    // ---- nameplate ----
    const np = this.nameplate;
    if (np) {
      _cam.setFromMatrixPosition(camera.matrixWorld);
      const d = _cam.distanceTo(s.pos);
      const alpha = smoothstep(2.6, 5.5, d) * (1 - smoothstep(60, 85, d));
      if (alpha <= 0.01) {
        np.visible = false;
      } else {
        np.visible = true;
        (np.material as SpriteMaterial).opacity = alpha;
        const k = clamp(d * 0.07, 1, 4.2);
        np.scale.set(1.28 * k, 0.32 * k, 1);
        // world-up offset expressed in the (rotating) root's local frame
        _v.set(0, NAMEPLATE_HEIGHT + 0.08 * (k - 1), 0).applyQuaternion(_q);
        np.position.copy(_v);
      }
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.bodyMat.material.dispose();
    this.glowMat.dispose();
    this.fxMat.dispose();
    if (this.nameplate) (this.nameplate.material as SpriteMaterial).dispose();
    this.nameTex?.dispose();
    releaseCarGeometry(this.style);
  }

  /** Team of this car (debug / integration convenience). */
  get teamId(): Team {
    return this.team;
  }
}
