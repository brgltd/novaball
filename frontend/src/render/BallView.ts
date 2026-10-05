/**
 * BallView — the plasma "Nova Core":
 *   core     animated domain-warped 3D-noise plasma (HDR emissive, hot center, colored limb)
 *   shell    geodesic hex energy shell (Goldberg cells) spinning with the ball; cells light up with charge
 *   corona   additive glow sprite
 *   arcs     SUPERNOVA electric arcs (camera-facing ribbons, regenerated ~18x/s)
 *   marker   ground ring projected under the ball (depth cue), LAYER_MAIN_ONLY
 *   light    ONE point light (no shadows), color/intensity by charge — never removed (no shader recompiles)
 * Charge: 0 neutral pearl-cyan, 1-2 team tinted, 3 SUPERNOVA (white-hot core, team corona, pulsing, arcs).
 */
import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  PointLight,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Camera,
} from 'three';
import { LAYER_MAIN_ONLY, type IBallView } from '../contracts';
import { arenaSDF } from '../sim/arena';
import { BALL } from '../sim/constants';
import type { BallSnapshot, Team } from '../sim/types';
import { BALL_THEME } from '../theme';
import { buildHexShellGeometry } from './actors/ballGeometry';
import { GLSL_SNOISE } from './actors/glsl';
import { RibbonBuffer } from './actors/ribbons';
import { getGlowTexture, getRaysTexture } from './actors/textures';
import { clamp01, damp, FastRng, smoothstep, TEAM_PRIMARY, TEAM_SECONDARY } from './actors/util';

const R = BALL.radius;
const ARC_STRIPS = 8;
const ARC_POINTS = 14;

const NEUTRAL_DEEP = new Color(0.32, 0.62, 1.0);
const NEUTRAL_HOT = new Color(BALL_THEME.neutral);
const WHITE = new Color(1, 1, 1);

const _c0 = new Color();
const _c1 = new Color();
const _v = new Vector3();
const _axis = new Vector3();
const _dir = new Vector3();

export class BallView implements IBallView {
  readonly object = new Group();
  private readonly ball = new Group();
  private readonly spin = new Group();
  private readonly core: Mesh;
  private readonly shell: Mesh;
  private readonly corona: Sprite;
  private readonly rays: Sprite;
  private readonly raysMat: SpriteMaterial;
  private readonly marker: Mesh;
  private readonly light: PointLight;
  private readonly arcs: RibbonBuffer;
  private readonly coreMat: ShaderMaterial;
  private readonly shellMat: ShaderMaterial;
  private readonly markerMat: ShaderMaterial;
  private readonly coronaMat: SpriteMaterial;
  private readonly rng = new FastRng(0xba11);

  // smoothed visual state
  private level = 0; // smoothed charge 0..3
  private readonly deep = new Color().copy(NEUTRAL_DEEP);
  private readonly hot = new Color().copy(NEUTRAL_HOT);
  /** Team secondary (or neutral) — used for coronas so they stay saturated even when the core goes white-hot. */
  private readonly accent = new Color().copy(NEUTRAL_HOT);
  private flash = 0;
  private hitPulse = 0;
  private prevCharge = 0;
  private readonly prevVel = new Vector3();
  private readonly prevPos = new Vector3();
  private hasPrev = false;
  private wasHidden = true;
  private arcTimer = 0;
  private readonly arcData = new Float32Array(ARC_STRIPS * ARC_POINTS * 3);
  private readonly arcAlpha = new Float32Array(ARC_STRIPS);
  private superAmt = 0;

  constructor() {
    this.object.name = 'ball';
    // ---- core ----
    this.coreMat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new Color() },
        uHot: { value: new Color() },
        uIntensity: { value: 1 },
        uFlash: { value: 0 },
        uSuper: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vPos = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        ${GLSL_SNOISE}
        uniform float uTime, uIntensity, uFlash, uSuper;
        uniform vec3 uDeep, uHot;
        varying vec3 vPos;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vec3 p = normalize(vPos);
          float sp = 1.0 + uSuper * 1.6;
          float t = uTime * sp;
          vec3 q = p * 1.9;
          float w = snoise(q * 1.1 + vec3(0.0, t * 0.23, t * 0.11));
          float n = snoise(q + vec3(w * 0.9, t * 0.37, -t * 0.19));
          float n2 = snoise(q * 2.6 + vec3(-t * 0.5, w, t * 0.3));
          // snoise can slightly exceed [-1, 1]: clamp before pow (pow of a negative base is NaN)
          float fil = clamp(1.0 - abs(n), 0.0, 1.0);
          fil = pow(fil, 4.0 - 1.5 * uSuper) * 0.8 + pow(clamp(1.0 - abs(n2), 0.0, 1.0), 6.0) * 0.45;
          float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
          float center = pow(ndv, 2.5);
          float limb = pow(max(1.0 - ndv, 0.0), 2.2);
          vec3 col = uDeep * (0.22 + 0.55 * limb) + mix(uDeep, uHot, clamp(fil * 1.2, 0.0, 1.0)) * fil * 1.25 + uHot * center * (0.3 + 1.1 * uSuper);
          col *= uIntensity;
          col += uHot * uFlash * 2.5;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.core = new Mesh(new SphereGeometry(R * 0.8, 48, 32), this.coreMat);
    this.core.name = 'ballCore';

    // ---- hex shell ----
    this.shellMat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLine: { value: new Color() },
        uRim: { value: new Color() },
        uFill: { value: 0 },
        uIntensity: { value: 1 },
        uFlash: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aBary;
        attribute vec3 aCell;
        varying vec3 vBary;
        varying vec3 vCell;
        varying vec3 vN;
        varying vec3 vV;
        varying vec3 vObj;
        void main() {
          vBary = aBary;
          vCell = aCell;
          vObj = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime, uFill, uIntensity, uFlash;
        uniform vec3 uLine, uRim;
        varying vec3 vBary;
        varying vec3 vCell;
        varying vec3 vN;
        varying vec3 vV;
        varying vec3 vObj;
        void main() {
          vec3 b = vBary;
          float mx = max(max(b.x, b.y), b.z);
          float mn = min(min(b.x, b.y), b.z);
          float mid = b.x + b.y + b.z - mx - mn;
          float edge = mx - mid;
          float fw = max(fwidth(edge), 1e-4);
          float line = 1.0 - smoothstep(0.012, 0.012 + fw * 1.5, edge);
          float cr = (b.x >= b.y && b.x >= b.z) ? vCell.x : ((b.y >= b.z) ? vCell.y : vCell.z);
          float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
          float fres = pow(max(1.0 - ndv, 0.0), 2.2);
          // charge fill: cells light up (random order) with a travelling shimmer
          float lit = smoothstep(cr - 0.08, cr, uFill);
          float wave = 0.5 + 0.5 * sin(uTime * 4.0 + cr * 40.0 + vObj.y * 3.0);
          float cellGlow = lit * (0.1 + 0.16 * wave) * smoothstep(0.0, 0.5, edge);
          float scan = pow(clamp(0.5 + 0.5 * sin(vObj.y * 5.0 - uTime * 2.2), 0.0, 1.0), 12.0) * 0.35;
          vec3 col = uLine * line * (0.55 + 1.3 * fres + scan) + uLine * cellGlow + uRim * fres * 0.55;
          col *= uIntensity * (1.0 + uFlash * 1.5);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.shell = new Mesh(buildHexShellGeometry(R, 2, 4), this.shellMat);
    this.shell.name = 'ballShell';
    this.shell.castShadow = true;
    this.shell.renderOrder = 3;

    // ---- corona ----
    this.coronaMat = new SpriteMaterial({
      map: getGlowTexture(),
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    this.corona = new Sprite(this.coronaMat);
    this.corona.renderOrder = 4;
    this.corona.name = 'ballCorona';
    // SUPERNOVA star flare (only drawn while supernova)
    this.raysMat = new SpriteMaterial({
      map: getRaysTexture(),
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    this.rays = new Sprite(this.raysMat);
    this.rays.renderOrder = 4;
    this.rays.name = 'ballRays';
    this.rays.visible = false;

    this.spin.add(this.core, this.shell);
    this.ball.add(this.spin, this.corona, this.rays);
    this.object.add(this.ball);

    // ---- SUPERNOVA arcs (world-space ribbons) ----
    this.arcs = new RibbonBuffer(ARC_STRIPS, ARC_POINTS, { softness: 1.2, core: 1.4 });
    this.arcs.mesh.renderOrder = 5;
    this.arcs.mesh.name = 'ballArcs';
    this.object.add(this.arcs.mesh);

    // ---- ground marker ----
    this.markerMat = new ShaderMaterial({
      uniforms: { uColor: { value: new Color() }, uAlpha: { value: 0 }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uAlpha, uTime;
        varying vec2 vUv;
        void main() {
          float r = length(vUv);
          float ring = smoothstep(0.8, 0.88, r) * (1.0 - smoothstep(0.95, 1.0, r));
          float inner = (1.0 - smoothstep(0.0, 0.8, r)) * 0.16;
          float ang = atan(vUv.y, vUv.x + 1e-5);
          float dash = 0.55 + 0.45 * step(0.5, fract(ang * 3.8197 + uTime * 0.35));
          float dot0 = 1.0 - smoothstep(0.05, 0.09, r);
          float a = (ring * dash + inner + dot0 * 0.8) * uAlpha;
          gl_FragColor = vec4(uColor * a, 1.0);
        }
      `,
    });
    const mg = new PlaneGeometry(2, 2);
    mg.rotateX(-Math.PI / 2);
    this.marker = new Mesh(mg, this.markerMat);
    this.marker.layers.set(LAYER_MAIN_ONLY);
    this.marker.renderOrder = 1;
    this.marker.name = 'ballMarker';
    this.object.add(this.marker);

    // ---- light (always in the scene; intensity 0 when hidden) ----
    this.light = new PointLight(0xffffff, 0, 18, 2);
    this.light.castShadow = false;
    this.light.name = 'ballLight';
    this.object.add(this.light);
  }

  update(s: BallSnapshot, dt: number, time: number, camera: Camera): void {
    void camera;
    if (!s.visible) {
      this.ball.visible = false;
      this.marker.visible = false;
      this.arcs.mesh.visible = false;
      this.light.intensity = 0;
      this.hasPrev = false;
      this.wasHidden = true;
      return;
    }
    this.ball.visible = true;
    if (this.wasHidden) {
      // (re)appearing (first frame / after a goal): snap the smoothed charge state, no fade from the old state
      this.wasHidden = false;
      this.level = Math.max(0, Math.min(3, s.charge));
      this.prevCharge = this.level;
      this.superAmt = this.level >= 3 ? 1 : 0;
      this.flash = 0;
      this.hitPulse = 0;
      const t = this.level > 0 ? s.chargeTeam : -1;
      if (t === -1) {
        this.deep.copy(NEUTRAL_DEEP);
        this.hot.copy(NEUTRAL_HOT);
        this.accent.copy(NEUTRAL_HOT);
      } else {
        this.deep.copy(TEAM_PRIMARY[t]);
        this.hot.copy(TEAM_SECONDARY[t]);
        this.accent.copy(TEAM_SECONDARY[t]);
      }
    }
    this.ball.position.copy(s.pos);
    this.spin.quaternion.copy(s.quat);

    // ---- charge smoothing ----
    const lvl = Math.max(0, Math.min(3, s.charge));
    if (lvl > this.prevCharge) this.flash = 1;
    this.prevCharge = lvl;
    this.level += (lvl - this.level) * damp(lvl > this.level ? 7 : 3, dt);
    const team: Team | -1 = lvl > 0 ? s.chargeTeam : -1;
    // target colors
    if (team === -1) {
      _c0.copy(NEUTRAL_DEEP);
      _c1.copy(NEUTRAL_HOT);
    } else if (lvl >= 3) {
      _c0.copy(TEAM_PRIMARY[team]).multiplyScalar(1.5);
      _c1.copy(WHITE);
    } else {
      _c0.copy(TEAM_PRIMARY[team]).multiplyScalar(lvl >= 2 ? 1.2 : 1.0);
      _c1.copy(TEAM_SECONDARY[team]).lerp(WHITE, lvl >= 2 ? 0.15 : 0.0);
    }
    const ck = damp(6, dt);
    this.deep.lerp(_c0, ck);
    this.hot.lerp(_c1, ck);
    this.accent.lerp(team === -1 ? NEUTRAL_HOT : TEAM_SECONDARY[team], ck);
    const superT = lvl >= 3 ? 1 : 0;
    this.superAmt += (superT - this.superAmt) * damp(superT > this.superAmt ? 5 : 2.5, dt);
    this.flash = Math.max(0, this.flash - dt * 2.4);

    // ---- impact pulse from velocity discontinuities ----
    // (a teleport — kickoff reset, replay cut — is not an impact)
    if (this.hasPrev && s.pos.distanceToSquared(this.prevPos) < 36) {
      const dv = _v.subVectors(s.vel, this.prevVel).length();
      if (dv > 6) this.hitPulse = Math.max(this.hitPulse, clamp01(dv / 30));
    }
    this.prevVel.copy(s.vel);
    this.prevPos.copy(s.pos);
    this.hasPrev = true;
    this.hitPulse = Math.max(0, this.hitPulse - dt * 3.5);

    const li = Math.min(3, this.level);
    const i0 = Math.floor(li);
    const i1 = Math.min(3, i0 + 1);
    const lf = li - i0;
    const levelI = BALL_THEME.levelIntensity[i0] + (BALL_THEME.levelIntensity[i1] - BALL_THEME.levelIntensity[i0]) * lf;
    const pulse = 0.5 + 0.5 * Math.sin(time * 9.0);
    const superPulse = 1 + this.superAmt * (0.25 * pulse + 0.1 * Math.sin(time * 23));

    // core
    const cu = this.coreMat.uniforms;
    cu.uTime.value = time;
    cu.uDeep.value.copy(this.deep);
    cu.uHot.value.copy(this.hot);
    cu.uIntensity.value = (0.75 + 0.42 * levelI) * superPulse;
    cu.uFlash.value = this.flash * 0.6 + this.hitPulse * 0.5;
    cu.uSuper.value = this.superAmt;

    // shell
    const su = this.shellMat.uniforms;
    su.uTime.value = time;
    su.uLine.value.copy(this.hot).lerp(this.deep, this.level > 0.05 ? 0.75 : 0.35);
    su.uRim.value.copy(this.deep);
    su.uFill.value = this.level / 3 + 0.02;
    su.uIntensity.value = (1.1 + 0.45 * this.level) * superPulse;
    su.uFlash.value = this.flash + this.hitPulse;
    const wob = 1 + this.hitPulse * 0.05 * Math.sin(time * 42);
    this.spin.scale.setScalar(wob);

    // corona
    const cs = R * (3.1 + 0.35 * this.level + 0.9 * this.superAmt * superPulse) * (1 + this.hitPulse * 0.3);
    this.corona.scale.set(cs, cs, 1);
    // warm the corona toward the secondary color: keeps orange from drifting pink over purple skies
    this.coronaMat.color
      .copy(this.deep)
      .lerp(this.accent, 0.3)
      .multiplyScalar(0.26 + 0.1 * this.level + 0.16 * this.superAmt + this.flash * 0.45);
    if (this.superAmt > 0.01) {
      this.rays.visible = true;
      const rs = R * (5.5 + 1.2 * pulse) * this.superAmt;
      this.rays.scale.set(rs, rs, 1);
      this.raysMat.rotation = time * 0.35;
      this.raysMat.color.copy(this.deep).lerp(this.accent, 0.35).multiplyScalar(0.5 * this.superAmt * superPulse);
    } else {
      this.rays.visible = false;
    }

    // light
    this.light.position.copy(s.pos);
    this.light.color.copy(this.deep).lerp(this.hot, 0.35);
    this.light.intensity = (26 + 16 * this.level + 60 * this.superAmt * superPulse) * (1 + this.flash * 0.8 + this.hitPulse * 0.6);

    // ---- SUPERNOVA arcs ----
    this.updateArcs(s, dt, time);

    // ---- ground marker ----
    const h = s.pos.y;
    let a = 0;
    if (h > R * 1.25) {
      const flat = smoothstep(0.93, 0.995, arenaSDF(s.pos.x, 1.0, s.pos.z));
      a = smoothstep(R * 1.25, R * 2.2, h) * (1 - 0.65 * smoothstep(4, 16, h)) * flat;
    }
    if (a > 0.01) {
      this.marker.visible = true;
      this.marker.position.set(s.pos.x, 0.03, s.pos.z);
      const ms = R * (1.0 + 0.35 * smoothstep(2, 14, h));
      this.marker.scale.set(ms, 1, ms);
      const mu = this.markerMat.uniforms;
      mu.uAlpha.value = a * 0.9;
      mu.uColor.value.copy(this.deep).lerp(this.hot, 0.4).multiplyScalar(1.2);
      mu.uTime.value = time;
    } else {
      this.marker.visible = false;
    }
  }

  private updateArcs(s: BallSnapshot, dt: number, time: number): void {
    const active = this.superAmt > 0.02 ? ARC_STRIPS : this.level > 1.6 ? 2 : 0;
    const arcs = this.arcs;
    if (active === 0) {
      this.arcs.mesh.visible = false;
      return;
    }
    arcs.mesh.visible = true;
    this.arcTimer -= dt;
    if (this.arcTimer <= 0) {
      this.arcTimer = 0.045 + this.rng.next() * 0.04;
      for (let k = 0; k < ARC_STRIPS; k++) this.regenArc(k);
    }
    arcs.beginFrame();
    const gain = this.superAmt > 0.02 ? this.superAmt : 0.35;
    const col = this.hot;
    const dc = this.deep;
    for (let k = 0; k < ARC_STRIPS; k++) {
      arcs.begin(k);
      if (k < active && this.arcAlpha[k] > 0) {
        const flick = this.arcAlpha[k] * gain * (0.6 + 0.4 * Math.sin(time * 60 + k * 1.7));
        for (let i = 0; i < ARC_POINTS; i++) {
          const o = (k * ARC_POINTS + i) * 3;
          const f = i / (ARC_POINTS - 1);
          const taper = Math.sin(Math.PI * f);
          const w = (0.014 + 0.022 * taper) * (1 + 0.6 * this.superAmt);
          arcs.push(
            k,
            s.pos.x + this.arcData[o],
            s.pos.y + this.arcData[o + 1],
            s.pos.z + this.arcData[o + 2],
            w,
            flick,
            (col.r * 0.5 + dc.r * 1.2) * 2.4,
            (col.g * 0.5 + dc.g * 1.2) * 2.4,
            (col.b * 0.5 + dc.b * 1.2) * 2.4,
          );
        }
      }
      arcs.end(k);
    }
    arcs.commit();
  }

  /** Jagged arc between two points on the shell, bulging outward (ball-local offsets). */
  private regenArc(k: number): void {
    const rng = this.rng;
    this.arcAlpha[k] = rng.next() < 0.8 ? 0.6 + rng.next() * 0.6 : 0;
    // random start direction
    const u = rng.signed();
    const th = rng.next() * Math.PI * 2;
    const rr = Math.sqrt(1 - u * u);
    _dir.set(Math.cos(th) * rr, u, Math.sin(th) * rr);
    // random axis perpendicular to dir
    _axis.set(rng.signed(), rng.signed(), rng.signed()).cross(_dir);
    if (_axis.lengthSq() < 1e-6) _axis.set(0, 1, 0).cross(_dir);
    _axis.normalize();
    const span = 0.5 + rng.next() * 0.7;
    const bulge = 0.05 + rng.next() * 0.16;
    for (let i = 0; i < ARC_POINTS; i++) {
      const f = i / (ARC_POINTS - 1);
      _v.copy(_dir).applyAxisAngle(_axis, span * f);
      const jit = i === 0 || i === ARC_POINTS - 1 ? 0 : 0.045;
      const rad = R * (1.0 + bulge * Math.sin(Math.PI * f)) + rng.signed() * jit;
      const o = (k * ARC_POINTS + i) * 3;
      this.arcData[o] = _v.x * rad + rng.signed() * jit;
      this.arcData[o + 1] = _v.y * rad + rng.signed() * jit;
      this.arcData[o + 2] = _v.z * rad + rng.signed() * jit;
    }
  }

  /** Make every sub-mesh visible so a following renderer.compile()/compileAsync() warms all ball shaders. */
  prewarm(): void {
    this.ball.visible = true;
    this.arcs.mesh.visible = true;
    this.marker.visible = true;
    this.rays.visible = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.core.geometry.dispose();
    this.coreMat.dispose();
    this.shell.geometry.dispose();
    this.shellMat.dispose();
    this.coronaMat.dispose();
    this.raysMat.dispose();
    this.marker.geometry.dispose();
    this.markerMat.dispose();
    this.arcs.dispose();
    this.light.dispose();
  }
}
