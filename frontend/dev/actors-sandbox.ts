/**
 * Render-actors sandbox: cars, ball, boost pads and every VFX, with a renderer setup approximating the final look
 * (HDR half-float composer, mipmap bloom, ACES, glossy reflective floor, emissive-panel environment map).
 *
 * URL params:
 *   focus=all|cars|ball|pads|vfx|goal|perf     what to show / frame
 *   car=striker|viper|titan  team=0|1  paint=<hex>   single-car focus (focus=cars)
 *   view=front34|rear|side|top|chase|overview  dist=<m>  yaw=<deg>  pitch=<deg>  fov=<deg>
 *   boost=1  supersonic=1                       force car states
 *   charge=0..3  bteam=0|1  ballmode=float|bounce|high|fast
 *   fire=<event>[,<event>]  every=<s>  at=<s>   VFX: fire named effects (ballHit, strongHit, bounce, impact, bump,
 *                                               jump, doubleJump, dodge, land, pickup, pickupBig, demolish,
 *                                               respawn, pulse, charge1, charge2, supernova, decay, goal, surge)
 *   freeze=<t>                                  stop simulation time at t (deterministic screenshots)
 *   fixeddt=1                                   fixed 1/60 s steps (with freeze: pixel-reproducible frames)
 *   q=low|medium|high|ultra  msaa=0|4  reflect=0|1  pr=<pixelRatio>  bloom=<intensity>
 *   hide=cars,ball,pads,vfx,<part names: carShell carGlow carFx nameplate ballCore ballShell ballCorona ballArcs
 *        ballMarker padBases padOrbs padCells padColumns>
 * window.__sb: { stats, time(), geo(), vfx(), parts(n), programs(), fire(name), showVfx(v), particleFill(), bench(n),
 *   gpuBench(n) }  (interleave showVfx(true/false) around gpuBench / bench to isolate VFX costs)
 */
import '@fontsource/orbitron/700.css';
import {
  BackSide,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  PMREMGenerator,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { LAYER_MAIN_ONLY } from '../src/contracts';
import { carGeometryStats } from '../src/render/actors/carDesigns';
import { FastRng } from '../src/render/actors/util';
import { BallView } from '../src/render/BallView';
import { BoostPadsView } from '../src/render/BoostPadsView';
import { CarView } from '../src/render/CarView';
import { VFXSystem } from '../src/render/VFXSystem';
import type { QualityPreset } from '../src/settings';
import { goalFramePaths } from '../src/sim/arena';
import { PAD_LAYOUT } from '../src/sim/constants';
import type { BallSnapshot, CarSnapshot, CarStyleId, SimEvent, Team, WorldSnapshot } from '../src/sim/types';
import { TEAMS } from '../src/theme';

// ------------------------------------------------------------------------------------------------
// params
// ------------------------------------------------------------------------------------------------
const P = new URLSearchParams(location.search);
const focus = P.get('focus') ?? 'all';
const msaa = Number(P.get('msaa') ?? '4');
const useReflect = (P.get('reflect') ?? '1') !== '0';
const pixelRatio = Number(P.get('pr') ?? '1');
const forceBoost = P.get('boost') === '1';
const forceSuper = P.get('supersonic') === '1';
const freezeAt = P.get('freeze') !== null ? Number(P.get('freeze')) : Infinity;
const fixedDt = P.get('fixeddt') === '1';
const quality = (P.get('q') ?? 'high') as QualityPreset;
const fireList = (P.get('fire') ?? '').split(',').filter(Boolean);
const fireEvery = Number(P.get('every') ?? '3');
const fireAt = Number(P.get('at') ?? '0.6');

// ------------------------------------------------------------------------------------------------
// renderer / scene / post
// ------------------------------------------------------------------------------------------------
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = NoToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
renderer.info.autoReset = false;

const scene = new Scene();
scene.background = new Color(0x010207);
const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 2000);
camera.layers.enable(LAYER_MAIN_ONLY);

function buildEnvScene(): Scene {
  const s = new Scene();
  const domeMat = new ShaderMaterial({
    side: BackSide,
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vDir; void main(){
      vec3 d = normalize(vDir); float h = d.y;
      vec3 col = mix(vec3(0.03,0.02,0.06), vec3(0.004,0.006,0.02), smoothstep(-0.1, 0.7, h));
      col += vec3(0.28,0.08,0.5) * exp(-abs(h - 0.04) * 10.0) * 0.5;
      col += vec3(0.0,0.22,0.26) * exp(-abs(h - 0.18) * 6.0) * max(0.0, d.x) * 0.5;
      col += vec3(0.02,0.02,0.03) * (1.0 - smoothstep(-0.2, 0.0, h));
      gl_FragColor = vec4(col, 1.0); }`,
  });
  s.add(new Mesh(new SphereGeometry(60, 48, 24), domeMat));
  const panel = (w: number, h: number, color: string, k: number, x: number, y: number, z: number) => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(color).multiplyScalar(k), side: DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    s.add(m);
  };
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.2;
    panel(7, 1.1, '#e6eeff', 9, Math.cos(a) * 34, 22, Math.sin(a) * 34);
  }
  panel(26, 2.2, '#1ec8ff', 2.2, 0, 5, -42);
  panel(26, 2.2, '#ff6a1a', 2.2, 0, 5, 42);
  panel(60, 1.2, '#6d7cff', 1.4, 42, 8, 0);
  panel(60, 1.2, '#6d7cff', 1.4, -42, 8, 0);
  panel(80, 3, '#1a2440', 1.0, 0, -6, 0);
  return s;
}
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(buildEnvScene(), 0.015).texture;

{
  const sky = new Mesh(
    new SphereGeometry(900, 32, 16),
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vDir; void main(){ vec3 d = normalize(vDir); float h = d.y;
        vec3 col = mix(vec3(0.02,0.012,0.04), vec3(0.002,0.003,0.01), smoothstep(-0.05, 0.6, h));
        col += vec3(0.2,0.05,0.35) * exp(-abs(h - 0.03) * 14.0) * 0.35;
        col += vec3(0.0,0.14,0.18) * exp(-abs(h - 0.2) * 5.0) * max(0.0, d.x) * 0.35;
        gl_FragColor = vec4(col, 1.0); }`,
    }),
  );
  sky.renderOrder = -10;
  sky.layers.set(LAYER_MAIN_ONLY);
  scene.add(sky);
  const n = 2500;
  const pos = new Float32Array(n * 3);
  const starRng = new FastRng(0x57a2); // seeded: identical frames across page loads (before/after comparisons)
  for (let i = 0; i < n; i++) {
    const u = starRng.next() * 2 - 1;
    const th = starRng.next() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    pos.set([Math.cos(th) * r * 800, Math.abs(u) * 800 + 20, Math.sin(th) * r * 800], i * 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const stars = new Points(g, new PointsMaterial({ color: 0xbfd6ff, size: 1.6, sizeAttenuation: false, depthWrite: false }));
  stars.layers.set(LAYER_MAIN_ONLY);
  scene.add(stars);
}

if (useReflect) {
  const refl = new Reflector(new PlaneGeometry(400, 400), {
    textureWidth: Math.floor((window.innerWidth * pixelRatio) / 2),
    textureHeight: Math.floor((window.innerHeight * pixelRatio) / 2),
    multisample: 0,
    color: 0xffffff,
  });
  refl.rotation.x = -Math.PI / 2;
  refl.getReflectionCamera(camera).layers.set(0);
  scene.add(refl);
}
{
  const floorMat = new MeshStandardMaterial({
    color: 0x05070d,
    roughness: 0.22,
    metalness: 0.2,
    transparent: useReflect,
    opacity: useReflect ? 0.8 : 1,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const floor = new Mesh(new PlaneGeometry(400, 400), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.renderOrder = -1;
  scene.add(floor);
  const gridMat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying vec3 vW; void main(){
      vec2 p = vW.xz / 2.0; vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
      float line = 1.0 - min(min(g.x, g.y), 1.0);
      float fade = 1.0 - smoothstep(30.0, 80.0, length(vW.xz));
      gl_FragColor = vec4(vec3(0.05,0.09,0.16) * line * fade, line * fade * 0.6); }`,
  });
  const grid = new Mesh(new PlaneGeometry(400, 400), gridMat);
  grid.rotation.x = -Math.PI / 2;
  grid.layers.set(LAYER_MAIN_ONLY);
  scene.add(grid);
}

const sun = new DirectionalLight(0xe4ecff, 2.4);
sun.position.set(14, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SH = focus === 'perf' || focus === 'goal' ? 40 : 16;
sun.shadow.camera.left = -SH;
sun.shadow.camera.right = SH;
sun.shadow.camera.top = SH;
sun.shadow.camera.bottom = -SH;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 120;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);
scene.add(new HemisphereLight(0x3b4c8a, 0x04050a, 0.55));

const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: msaa });
composer.addPass(new RenderPass(scene, camera));
const bloom = new BloomEffect({
  mipmapBlur: true,
  luminanceThreshold: 0.95,
  luminanceSmoothing: 0.25,
  intensity: Number(P.get('bloom') ?? '1.15'),
  radius: 0.72,
  levels: 7,
});
composer.addPass(new EffectPass(camera, bloom, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })));

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

// ------------------------------------------------------------------------------------------------
// fake world snapshot
// ------------------------------------------------------------------------------------------------
function makeCarSnap(id: number, team: Team): CarSnapshot {
  return {
    id,
    team,
    pos: new Vector3(),
    quat: new Quaternion(),
    vel: new Vector3(),
    angVel: new Vector3(),
    boost: 60,
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
const ballSnap: BallSnapshot = {
  pos: new Vector3(0, 1.6, 0),
  quat: new Quaternion(),
  vel: new Vector3(),
  angVel: new Vector3(),
  charge: 0,
  chargeTeam: -1,
  visible: true,
};
const world: WorldSnapshot = { tick: 0, time: 0, phase: 'playing', cars: [], ball: ballSnap, padsActive: [], surge: 0 };

// ------------------------------------------------------------------------------------------------
// cars
// ------------------------------------------------------------------------------------------------
type CarMode = 'show' | 'circle' | 'drive';
interface CarEntry {
  view: CarView;
  snap: CarSnapshot;
  style: CarStyleId;
  home: Vector3;
  heading: number;
  mode: CarMode;
  boost: boolean;
  radius: number;
  speed: number;
  phase: number;
}
const cars: CarEntry[] = [];
const names = ['PLAYER', 'ZEPHYR', 'QUASAR', 'VEGA', 'LYRA', 'ORION', 'NOVA-9'];

function addCar(
  style: CarStyleId,
  team: Team,
  x: number,
  z: number,
  heading: number,
  paint: string,
  mode: CarMode,
  boost: boolean,
  radius = 8,
  speed = 20,
  phase = 0,
): CarEntry {
  const id = cars.length;
  const view = new CarView({ team, style, paint, isPlayer: id === 0, name: names[id % names.length], nameplate: !(focus === 'cars' && P.get('car')) });
  const snap = makeCarSnap(id, team);
  snap.pos.set(x, 0.45, z);
  scene.add(view.object);
  const e: CarEntry = { view, snap, style, home: new Vector3(x, 0.45, z), heading, mode, boost, radius, speed, phase };
  cars.push(e);
  world.cars.push(snap);
  return e;
}

const singleCar = P.get('car') as CarStyleId | null;
const styles: CarStyleId[] = ['striker', 'viper', 'titan'];
const paints = ['#e8eef7', '#2a2f3a', '#b3122e', '#1947c2', '#0d0f14', '#ffcc33'];
if (focus === 'cars' && singleCar) {
  const team = Number(P.get('team') ?? '0') as Team;
  addCar(singleCar, team, 0, 0, 0, P.get('paint') ?? (team === 0 ? '#e8eef7' : '#2a2f3a'), 'show', forceBoost);
} else if (focus === 'cars' || focus === 'all') {
  for (let i = 0; i < 3; i++) {
    addCar(styles[i], 0, -3.2 + i * 3.2, 1.6, 0.35, paints[i], 'show', forceBoost || i === 1);
    addCar(styles[i], 1, -3.2 + i * 3.2, -1.8, Math.PI - 0.35, paints[3 + i], 'show', forceBoost || i === 2);
  }
  if (focus === 'all') addCar('viper', 0, 0, 0, 0, '#7a2cff', 'circle', true, 8.5, 22.5);
} else if (focus === 'vfx') {
  addCar('striker', 0, -2.5, -10.5, 0.6, '#e8eef7', 'show', false);
  addCar('titan', 1, 3.5, -3.5, Math.PI + 0.4, '#2a2f3a', 'show', false);
} else if (focus === 'perf') {
  for (let i = 0; i < 6; i++) {
    const team = (i < 3 ? 0 : 1) as Team;
    addCar(styles[i % 3], team, 0, 0, 0, paints[i], 'drive', i % 2 === 0, 6 + i * 3, 12 + i * 2.2, i * 1.1);
  }
}

// ------------------------------------------------------------------------------------------------
// ball
// ------------------------------------------------------------------------------------------------
const ballView = focus === 'cars' || focus === 'pads' ? null : new BallView();
const fixedCharge = P.get('charge');
const ballTeam = Number(P.get('bteam') ?? '0') as Team;
const ballMode =
  P.get('ballmode') ?? (focus === 'ball' ? 'float' : focus === 'perf' ? 'fast' : focus === 'vfx' ? 'vfx' : focus === 'goal' ? 'goal' : 'bounce');
if (ballView) scene.add(ballView.object);
const spinAxis = new Vector3(0.3, 1, 0.2).normalize();
const _dq = new Quaternion();
let ballHidden = false;
function updateBall(dt: number, t: number): void {
  const s = ballSnap;
  const lvl = fixedCharge !== null ? Number(fixedCharge) : Math.floor(t / 2.5) % 4;
  s.charge = lvl;
  s.chargeTeam = lvl > 0 ? ballTeam : -1;
  s.visible = !ballHidden;
  if (ballMode === 'float') {
    s.pos.set(0, 1.6 + Math.sin(t * 1.3) * 0.05, 0);
    s.vel.set(0, 0, 0);
  } else if (ballMode === 'high') {
    s.pos.set(0, 6 + Math.sin(t) * 0.5, 0);
    s.vel.set(0, 0, 0);
  } else if (ballMode === 'fast') {
    const a = t * 1.1;
    s.pos.set(Math.sin(a) * 16, 3 + Math.abs(Math.sin(a * 2.1)) * 6, Math.cos(a * 0.8) * 22);
    s.vel.set(Math.cos(a) * 17.6 * 1.6, Math.cos(a * 2.1) * 12 * Math.sign(Math.sin(a * 2.1)), -Math.sin(a * 0.8) * 31);
  } else if (ballMode === 'vfx') {
    s.pos.set(0, 1.2, -5);
    s.vel.set(0, 0, 0);
  } else if (ballMode === 'goal') {
    s.pos.set(0, 2.5, 49.5);
    s.vel.set(0, 0, 25);
  } else {
    const ph = (t * 0.9) % 2;
    const y = 1 + 9 * ph * (2 - ph) * 0.5;
    s.pos.set(Math.sin(t * 0.4) * 2, y, Math.cos(t * 0.3) * 1.5);
    s.vel.set(0, (1 - ph) * 9, 0);
  }
  s.quat.multiply(_dq.setFromAxisAngle(spinAxis, dt * (1.2 + s.vel.length() * 0.5)));
  ballView?.update(s, dt, t, camera);
}

// ------------------------------------------------------------------------------------------------
// boost pads
// ------------------------------------------------------------------------------------------------
const showcasePads = [
  { x: -3.2, z: 1.2, big: false },
  { x: 0, z: 1.2, big: false },
  { x: 3.2, z: 1.2, big: false },
  { x: -2.4, z: -3.2, big: true },
  { x: 2.4, z: -3.2, big: true },
];
const padList = focus === 'pads' ? showcasePads : focus === 'all' || focus === 'vfx' || focus === 'perf' ? PAD_LAYOUT : [];
const padsView = padList.length ? new BoostPadsView(padList) : null;
const padActive: boolean[] = padList.map(() => true);
world.padsActive = padActive;
if (padsView) scene.add(padsView.object);
function updatePads(dt: number, t: number): void {
  if (!padsView) return;
  if (focus === 'pads') {
    padActive[0] = true;
    padActive[1] = t % 6 > 4;
    padActive[2] = false;
    padActive[3] = true;
    padActive[4] = t % 12 > 10;
  } else if (focus !== 'vfx') {
    for (let i = 0; i < padActive.length; i++) {
      const period = padList[i].big ? 14 : 7;
      padActive[i] = (t + i * 1.37) % period > (padList[i].big ? 10 : 4);
    }
  }
  padsView.update(padActive, dt, t);
}

// ------------------------------------------------------------------------------------------------
// VFX + timeline
// ------------------------------------------------------------------------------------------------
const vfx = focus === 'cars' || focus === 'pads' || focus === 'ball' ? null : new VFXSystem();
if (vfx) {
  vfx.setQuality(quality);
  vfx.setCarStyles(cars.map((c) => c.style));
  scene.add(vfx.object);
}

// reference goal frames (the real ones belong to ArenaView)
if (focus === 'goal' || focus === 'perf' || fireList.includes('goal')) {
  for (const path of goalFramePaths(12)) {
    const curve = new CatmullRomCurve3(path.points);
    const tube = new Mesh(new TubeGeometry(curve, 80, 0.3, 10), new MeshBasicMaterial({ color: new Color(TEAMS[path.goal].primary).multiplyScalar(2.2) }));
    scene.add(tube);
  }
}

const V = (x: number, y: number, z: number) => ({ x, y, z });
function makeEvent(name: string): SimEvent | null {
  const c0 = cars[0]?.snap;
  const c1 = cars[1]?.snap ?? c0;
  const b = ballSnap.pos;
  switch (name) {
    case 'ballHit':
      return { type: 'ballHit', carId: 0, team: 0, pos: V(b.x + 0.37, b.y + 0.1, b.z + 0.93), normal: V(-0.37, -0.1, -0.93), strength: 9, dodge: false, aerial: false, ballSpeed: 14 };
    case 'strongHit':
      return { type: 'ballHit', carId: 0, team: 0, pos: V(b.x + 0.37, b.y + 0.1, b.z + 0.93), normal: V(-0.37, -0.1, -0.93), strength: 32, dodge: true, aerial: false, ballSpeed: 40 };
    case 'bounce':
      return { type: 'ballBounce', pos: V(b.x, 0.02, b.z), normal: V(0, 1, 0), speed: 16 };
    case 'impact':
      return c0 ? { type: 'carImpact', carId: 0, pos: V(c0.pos.x, 0.1, c0.pos.z), normal: V(0, 1, 0), speed: 14 } : null;
    case 'bump':
      return c0 && c1 ? { type: 'carBump', aId: 0, bId: 1, pos: V((c0.pos.x + c1.pos.x) / 2, 0.5, (c0.pos.z + c1.pos.z) / 2), speed: 18 } : null;
    case 'jump':
      return { type: 'jump', carId: 0, double: false };
    case 'doubleJump':
      return { type: 'jump', carId: 1, double: true };
    case 'dodge':
      return { type: 'dodge', carId: 1, fx: 1, rx: 0 };
    case 'land':
      return { type: 'land', carId: 1, speed: 12 };
    case 'pickup':
      return { type: 'boostPickup', carId: 0, padIndex: 6, big: false };
    case 'pickupBig':
      return { type: 'boostPickup', carId: 0, padIndex: 0, big: true };
    case 'demolish':
      return c1 ? { type: 'demolish', victimId: 1, attackerId: 0, pos: V(c1.pos.x, c1.pos.y, c1.pos.z), vel: V(-6, 1, 4) } : null;
    case 'respawn':
      return { type: 'respawn', carId: 1 };
    case 'pulse':
      return c0 ? { type: 'pulse', carId: 0, pos: V(c0.pos.x, c0.pos.y, c0.pos.z), hitBall: true, hitCarIds: [1] } : null;
    case 'charge1':
      return { type: 'chargeChange', team: 0, level: 1, prevLevel: 0 };
    case 'charge2':
      return { type: 'chargeChange', team: 0, level: 2, prevLevel: 1 };
    case 'supernova':
      return { type: 'chargeChange', team: 0, level: 3, prevLevel: 2 };
    case 'decay':
      return { type: 'chargeChange', team: 0, level: 1, prevLevel: 2 };
    case 'goal':
      return { type: 'goal', team: 0, scorerId: 0, assistId: -1, points: 3, charge: 3, ballSpeed: 30, pos: V(0, 2.4, 51.6), ownGoal: false };
    case 'goalBlaze':
      return { type: 'goal', team: 1, scorerId: 3, assistId: -1, points: 1, charge: 1, ballSpeed: 30, pos: V(0, 2.4, -51.6), ownGoal: false };
    case 'surge':
      return { type: 'surgeStart' };
    default:
      return null;
  }
}

let demolishedUntil = -1;
let ballHiddenUntil = -1;
let simTime = Number(P.get('t') ?? '0');

function fire(name: string): void {
  if (!vfx) return;
  if (name === 'pickupBig' && cars[0]) {
    cars[0].home.set(-28.2, 0.45, 0.8);
  }
  const e = makeEvent(name);
  if (!e) return;
  if (e.type === 'demolish' && cars[1]) {
    cars[1].snap.demolished = true;
    demolishedUntil = simTime + 1.6;
  }
  if (e.type === 'goal' && focus === 'goal') {
    ballHidden = true;
    ballHiddenUntil = simTime + 2.2;
  }
  vfx.handleEvent(e, world);
}

const defaultTimeline = [
  'ballHit',
  'bounce',
  'jump',
  'pickup',
  'strongHit',
  'land',
  'doubleJump',
  'charge1',
  'impact',
  'bump',
  'dodge',
  'charge2',
  'pulse',
  'demolish',
  'supernova',
  'decay',
];
const timeline = fireList.length ? fireList : focus === 'vfx' ? defaultTimeline : focus === 'goal' ? ['goal'] : focus === 'perf' ? ['goal', 'goalBlaze'] : [];
const step = fireList.length ? fireEvery : focus === 'vfx' ? 1.15 : focus === 'goal' ? 5 : 4;
let nextFire = fireAt;
let fireIdx = 0;
function updateTimeline(t: number): void {
  if (timeline.length) {
    while (t >= nextFire) {
      fire(timeline[fireIdx % timeline.length]);
      fireIdx++;
      nextFire += fireList.length > 1 ? step / fireList.length : step;
    }
  }
  if (demolishedUntil > 0 && t > demolishedUntil) {
    demolishedUntil = -1;
    if (cars[1]) cars[1].snap.demolished = false;
    fire('respawn');
  }
  if (ballHiddenUntil > 0 && t > ballHiddenUntil) {
    ballHiddenUntil = -1;
    ballHidden = false;
  }
}

// ------------------------------------------------------------------------------------------------
// camera presets
// ------------------------------------------------------------------------------------------------
function placeCamera(): void {
  let target = new Vector3(0, 0.6, 0);
  let dist = 11;
  let yaw = 25;
  let pitch = 24;
  let fov = 50;
  if (focus === 'cars' && singleCar) {
    target = new Vector3(0, 0.05, 0);
    dist = 3.0;
  } else if (focus === 'ball') {
    target = new Vector3(0, 1.6, 0);
    dist = 5.5;
  } else if (focus === 'pads') {
    target = new Vector3(0, 0.6, -1);
    dist = 9;
  } else if (focus === 'vfx') {
    target = new Vector3(0, 1, -6.5);
    dist = 13;
    yaw = 20;
    pitch = 22;
    if (fireList[0] === 'pickupBig') {
      target = new Vector3(-29, 1, 0.4);
      dist = 8;
    }
    if (fireList[0] === 'goal') {
      target = new Vector3(0, 3, 48);
      dist = 24;
      yaw = 200;
      pitch = 14;
      fov = 60;
    }
  } else if (focus === 'goal') {
    target = new Vector3(0, 3.5, 47);
    dist = 26;
    yaw = 205;
    pitch = 12;
    fov = 60;
  } else if (focus === 'perf') {
    target = new Vector3(0, 2, 20);
    dist = 42;
    yaw = 200;
    pitch = 22;
    fov = 72;
  }
  const preset = P.get('view');
  if (preset === 'front34') {
    yaw = 38;
    pitch = 14;
  } else if (preset === 'rear') {
    yaw = 202;
    pitch = 16;
  } else if (preset === 'chase') {
    yaw = 180;
    pitch = 17;
    fov = 72;
  } else if (preset === 'side') {
    yaw = 90;
    pitch = 6;
  } else if (preset === 'top') {
    yaw = 20;
    pitch = 70;
  }
  if (P.get('ty') !== null) target.y = Number(P.get('ty'));
  if (P.get('tz') !== null) target.z = Number(P.get('tz'));
  if (P.get('tx') !== null) target.x = Number(P.get('tx'));
  dist = Number(P.get('dist') ?? dist);
  yaw = Number(P.get('yaw') ?? yaw);
  pitch = Number(P.get('pitch') ?? pitch);
  fov = Number(P.get('fov') ?? fov);
  const y = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  camera.position.set(target.x + Math.sin(y) * Math.cos(p) * dist, target.y + Math.sin(p) * dist, target.z + Math.cos(y) * Math.cos(p) * dist);
  camera.lookAt(target);
  controls.target.copy(target);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  sun.target.position.copy(target);
  sun.position.copy(target).add(new Vector3(14, 30, 10));
}
placeCamera();

// warm every actor shader up front (what the integration layer should do before compileAsync)
// NOTE: compile with the composer's HDR input target bound — programs compiled for the screen (sRGB output) differ
// from the ones used inside the post-processing chain (linear output) and would be recompiled at first use.
vfx?.prewarm();
ballView?.prewarm();
renderer.setRenderTarget(composer.inputBuffer);
renderer.compile(scene, camera);
renderer.setRenderTarget(null);
const programsAfterWarmup = renderer.info.programs?.length ?? 0;
const warmNames = new Set((renderer.info.programs ?? []).map((p) => (p as unknown as { name: string; cacheKey: string }).cacheKey));

// ------------------------------------------------------------------------------------------------
// loop
// ------------------------------------------------------------------------------------------------
const hud = document.getElementById('hud') as HTMLDivElement;
if (P.get('clean') === '1') {
  hud.style.display = 'none';
  const fxBox = document.getElementById('fx');
  if (fxBox) fxBox.style.display = 'none';
}
const up = new Vector3(0, 1, 0);
const fwd = new Vector3(0, 0, 1);
const tmpV = new Vector3();
let last = performance.now();
const frameTimes: number[] = [];
const stats = { fps: 0, frameMs: 0, calls: 0, triangles: 0, cpuMs: 0, updateMs: 0 };

function updateCars(dt: number, t: number): void {
  for (const c of cars) {
    const s = c.snap;
    if (c.mode === 'circle' || c.mode === 'drive') {
      const R = c.radius;
      const sp = c.speed;
      const a = (t * sp) / R + c.phase;
      const cz = c.mode === 'drive' ? 10 : 0;
      s.pos.set(Math.cos(a) * R, 0.45, Math.sin(a) * R + cz);
      s.vel.set(-Math.sin(a) * sp, 0, Math.cos(a) * sp);
      s.quat.setFromUnitVectors(fwd, tmpV.copy(s.vel).normalize());
      const boostCycle = c.mode === 'circle' || (t * 0.3 + c.phase) % 2 < 1.2;
      s.boosting = c.boost && boostCycle;
      s.supersonic = sp > 21;
      // counter-clockwise seen from +Y: the circle center is on the car's right => steering right
      s.steer = 0.7;
      s.throttle = 1;
    } else {
      s.pos.copy(c.home);
      s.quat.setFromAxisAngle(up, c.heading);
      const cyc = (t * 0.25 + c.snap.id * 0.37) % 1;
      s.boosting = c.boost || forceBoost;
      s.supersonic = forceSuper;
      s.throttle = s.boosting ? 1 : cyc < 0.5 ? 0.6 : 0;
      s.steer = Math.sin(t * 0.8 + s.id) * 0.8;
      s.vel.set(0, 0, s.boosting ? 14 : 6).applyQuaternion(s.quat);
      if (forceSuper) s.vel.setLength(22);
    }
    c.view.update(s, dt, t, camera);
  }
}

const hideSet = new Set((P.get('hide') ?? '').split(',').filter(Boolean));
function applyHide(): void {
  if (hideSet.has('ball') && ballView) ballView.object.visible = false;
  if (hideSet.has('pads') && padsView) padsView.object.visible = false;
  if (padsView) {
    for (const part of ['padBases', 'padOrbs', 'padCells', 'padColumns']) {
      if (hideSet.has(part)) {
        const o = padsView.object.getObjectByName(part);
        if (o) o.visible = false;
      }
    }
  }
  if (hideSet.has('vfx') && vfx) vfx.object.visible = false;
  for (const c of cars) {
    if (hideSet.has('cars')) c.view.object.visible = false;
    for (const part of ['carShell', 'carGlow', 'carFx', 'nameplate']) {
      if (hideSet.has(part)) {
        const o = c.view.object.getObjectByName(part);
        if (o) o.visible = false;
      }
    }
  }
  if (ballView) {
    for (const part of ['ballCore', 'ballShell', 'ballCorona', 'ballArcs', 'ballMarker']) {
      if (hideSet.has(part)) {
        const o = ballView.object.getObjectByName(part);
        if (o) o.visible = false;
      }
    }
  }
}

// chase camera like the game's default (distance 3.4, height 1.25, 105° horizontal FOV)
const followIdx = P.get('follow') !== null ? Number(P.get('follow')) : -1;
const _camFwd = new Vector3();
const _camPos = new Vector3();
const _camLook = new Vector3();
function updateFollowCamera(): void {
  const c = cars[followIdx];
  if (!c) return;
  const s = c.snap;
  _camFwd.set(0, 0, 1).applyQuaternion(s.quat);
  _camFwd.y = 0;
  _camFwd.normalize();
  const dist = Number(P.get('cdist') ?? '3.4');
  const height = Number(P.get('cheight') ?? '1.25');
  _camPos.copy(s.pos).addScaledVector(_camFwd, -dist);
  _camPos.y += height;
  camera.position.copy(_camPos);
  _camLook.copy(s.pos).addScaledVector(_camFwd, 4);
  _camLook.y += 0.6;
  camera.lookAt(_camLook);
  const aspect = window.innerWidth / window.innerHeight;
  camera.fov = (2 * Math.atan(Math.tan((105 * Math.PI) / 360) / aspect) * 180) / Math.PI;
  camera.updateProjectionMatrix();
}

function frame(dt: number): void {
  const t0 = performance.now();
  if (simTime >= freezeAt) dt = 0;
  else if (fixedDt && simTime + dt > freezeAt) dt = freezeAt - simTime;
  simTime += dt;
  world.time = simTime;
  updateTimeline(simTime);
  updateCars(dt, simTime);
  if (followIdx >= 0) updateFollowCamera();
  updateBall(dt, simTime);
  updatePads(dt, simTime);
  vfx?.update(dt, simTime, world, camera);
  if (hideSet.size) applyHide();
  stats.updateMs = performance.now() - t0;
  if (followIdx < 0) controls.update();
  renderer.info.reset();
  composer.render(dt);
  stats.cpuMs = performance.now() - t0;
  stats.calls = renderer.info.render.calls;
  stats.triangles = renderer.info.render.triangles;
}

(window as unknown as { __sb: unknown }).__sb = {
  stats,
  /** Current sandbox time (s). */
  time: () => simTime,
  /**
   * Contention-free fill proxy: on-screen pixels covered by the live particle quads (additive + alpha pools), sized,
   * capped, culled and stretched exactly like the particle vertex shader, clipped to the viewport.
   */
  particleFill: () => {
    if (!vfx) return null;
    const W = renderer.domElement.width;
    const H = renderer.domElement.height;
    const p11 = camera.projectionMatrix.elements[5];
    const p00 = camera.projectionMatrix.elements[0];
    const view = camera.matrixWorldInverse;
    const pools = vfx as unknown as Record<'add' | 'alpha', { count: number; gpu: Float32Array }>;
    const pos = new Vector3();
    const vel = new Vector3();
    let px = 0;
    let n = 0;
    for (const key of ['add', 'alpha'] as const) {
      const pool = pools[key];
      for (let i = 0; i < pool.count; i++) {
        const q = i * 16;
        const g = pool.gpu;
        pos.set(g[q], g[q + 1], g[q + 2]).applyMatrix4(view);
        const depth = -pos.z;
        if (depth < 0.6) continue;
        const pxPerM = (0.5 * H * p11) / Math.max(depth, 0.05);
        let size = Math.max(g[q + 3], 1.6 / pxPerM);
        size = Math.min(size, (0.22 * H) / pxPerM);
        let len = 0;
        if (g[q + 7] > 0) {
          vel.set(g[q + 4], g[q + 5], g[q + 6]).transformDirection(view).multiplyScalar(Math.hypot(g[q + 4], g[q + 5], g[q + 6]));
          const z = Math.min(pos.z, -0.05);
          len = Math.hypot(vel.x - (pos.x / z) * vel.z, vel.y - (pos.y / z) * vel.z) * g[q + 7];
        }
        // screen-space bounding box of the (possibly stretched) quad, clipped to the viewport
        const cx = (0.5 + (0.5 * (pos.x * p00)) / depth) * W;
        const cy = (0.5 + (0.5 * (pos.y * p11)) / depth) * H;
        const half = 0.5 * (size + len) * pxPerM;
        const x0 = Math.max(0, cx - half);
        const x1 = Math.min(W, cx + half);
        const y0 = Math.max(0, cy - half);
        const y1 = Math.min(H, cy + half);
        if (x1 <= x0 || y1 <= y0) continue;
        const clip = ((x1 - x0) * (y1 - y0)) / (4 * half * half);
        px += (size + len) * size * pxPerM * pxPerM * clip;
        n++;
      }
    }
    return { pixels: Math.round(px), screens: +(px / (W * H)).toFixed(2), onScreen: n };
  },
  /** Show / hide every VFX (interleaved on/off benches: cost = difference). */
  showVfx: (v: boolean) => {
    if (vfx) vfx.object.visible = v;
  },
  geo: () => ({ striker: carGeometryStats('striker'), viper: carGeometryStats('viper'), titan: carGeometryStats('titan') }),
  vfx: () => vfx?.stats(),
  programs: () => ({
    afterWarmup: programsAfterWarmup,
    now: renderer.info.programs?.length ?? 0,
    added: (renderer.info.programs ?? [])
      .map((p) => p as unknown as { name: string; cacheKey: string })
      .filter((p) => !warmNames.has(p.cacheKey))
      .map((p) => p.name),
  }),
  parts: (n = 8) => vfx?.debugParticles(n),
  fire,
  /**
   * GPU time per frame (ms, median of n frames) from EXT_disjoint_timer_query_webgl2 around the whole frame render;
   * -1 when the extension is missing. Less sensitive to CPU load than bench(). Interleave with showVfx() for costs.
   */
  async gpuBench(n = 30): Promise<number> {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    if (!ext) return -1;
    const qs: WebGLQuery[] = [];
    for (let i = 0; i < n; i++) {
      const q = gl.createQuery();
      if (!q) break;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      frame(1 / 60);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      qs.push(q);
    }
    const ms: number[] = [];
    for (let tries = 0; tries < 200 && qs.length; tries++) {
      await new Promise((r) => setTimeout(r, 10));
      while (qs.length && gl.getQueryParameter(qs[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = qs.shift() as WebGLQuery;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) ms.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
    }
    for (const q of qs) gl.deleteQuery(q);
    ms.sort((a, b) => a - b);
    return ms.length ? +ms[Math.floor(ms.length / 2)].toFixed(3) : -1;
  },
  /** GPU-synchronous benchmark: average ms per frame over n frames (CPU update + full render, readPixels sync). */
  bench(n = 60) {
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) frame(1 / 60);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return +((performance.now() - t0) / n).toFixed(2);
  },
};

function loop(): void {
  const now = performance.now();
  // fixeddt=1: exactly 1/60 s per frame (with freeze=<t>: pixel-reproducible frames across page loads)
  const dt = fixedDt ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
  last = now;
  frameTimes.push(dt);
  if (frameTimes.length > 120) frameTimes.shift();
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  stats.fps = Math.round(1 / avg);
  stats.frameMs = +(avg * 1000).toFixed(2);
  frame(dt);
  const vs = vfx?.stats();
  hud.textContent =
    `focus=${focus} q=${quality} t=${simTime.toFixed(2)}\nfps ${stats.fps}  frame ${stats.frameMs} ms  cpu ${stats.cpuMs.toFixed(2)} ms (update ${stats.updateMs.toFixed(2)})\n` +
    `calls ${stats.calls}  tris ${stats.triangles}` +
    (vs ? `\nparticles ${vs.additive}+${vs.alpha}  shocks ${vs.shocks}  debris ${vs.debris}  trails ${vs.trails}` : '');
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

{
  const box = document.getElementById('fx');
  if (box && vfx) {
    for (const name of [...defaultTimeline, 'respawn', 'pickupBig', 'goal', 'surge']) {
      const b = document.createElement('button');
      b.textContent = name;
      b.onclick = () => fire(name);
      box.appendChild(b);
    }
  }
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
