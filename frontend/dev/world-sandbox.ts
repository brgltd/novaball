/**
 * NOVABALL — render-world sandbox. Uses RenderSystem with a FAKE WorldSnapshot and placeholder actors.
 *
 * URL params:
 *   cam=orbit|car|broadcast|goal|replay|endPodium   (default orbit)
 *   ballcam=0|1   q=low|medium|high|ultra   surge=0..1   replay=1   paused=1   speed=0..1 (fake player speed fx)
 *   ripples=1 (periodic random wall ripples)   goal=1 (periodic goal celebration)   tm=agx|aces|neutral
 *   dyn=0 (disable dynamic resolution)   t=<sec> (start time)   freeze=1 (stop time)   hud=1   actors=0
 *   fov=<deg>   bloom=<intensity>   exposure=<x>
 * window.__stats() -> RenderStats, window.__debug() -> GPU timing etc, window.__verify() -> SDF check of meshes.
 */
// display font for the canvas textures (in the game the UI imports these)
import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/900.css';
import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PointLight,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { CameraContext, CameraMode, FrameFx, IBallView, IBoostPadsView, ICarView, IVFXSystem } from '../src/contracts';
import { RenderSystem } from '../src/render/RenderSystem';
import { buildForceFieldGeometry, buildGoalFrameGeometry, buildGoalGeometries, verifyAgainstSDF } from '../src/render/world/ArenaGeometry';
import { DEFAULT_SETTINGS, type QualityPreset, type Settings } from '../src/settings';
import { arenaNormal, arenaSDF, goalScoredBy } from '../src/sim/arena';
import { ARENA, BALL, CAR, GRAVITY, PAD_LAYOUT } from '../src/sim/constants';
import type { BallSnapshot, CarSnapshot, Team, WorldSnapshot } from '../src/sim/types';
import { TEAMS } from '../src/theme';

const P = new URLSearchParams(location.search);
const num = (k: string, d: number) => (P.has(k) ? Number(P.get(k)) : d);
const camMode = (P.get('cam') ?? 'orbit') as CameraMode;
const quality = (P.get('q') ?? 'high') as QualityPreset;
const surgeParam = num('surge', 0);
const freeze = P.get('freeze') === '1';
const showActors = P.get('actors') !== '0';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const loading = document.getElementById('loading') as HTMLDivElement;

const settings: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  quality,
  dynamicResolution: P.get('dyn') !== '0',
  fov: num('fov', DEFAULT_SETTINGS.fov),
  ballCamDefault: P.get('ballcam') !== '0',
};

const render = new RenderSystem(canvas, settings);
if (P.has('tm')) render.setToneMapping(P.get('tm') as 'agx' | 'aces' | 'neutral');
if (P.has('bloom')) render.post.bloomIntensity = num('bloom', 1.25);
if (P.has('exposure')) render.post.exposure = num('exposure', 1);

// ------------------------------------------------------------------------------------------ fake world
function makeCar(id: number, team: Team): CarSnapshot {
  return {
    id,
    team,
    pos: new Vector3(),
    quat: new Quaternion(),
    vel: new Vector3(),
    angVel: new Vector3(),
    boost: 50,
    boosting: false,
    supersonic: false,
    onGround: true,
    demolished: false,
    dodging: false,
    powersliding: false,
    steer: 0,
    throttle: 1,
    pulseReady01: 1,
  };
}

const useReal = P.get('real') === '1';
const real: { cars: ICarView[]; ball: IBallView | null; pads: IBoostPadsView | null; vfx: IVFXSystem | null } = {
  cars: [],
  ball: null,
  pads: null,
  vfx: null,
};
const ball: BallSnapshot = {
  pos: new Vector3(0, P.get('kick') === '1' ? BALL.radius : 6, 0),
  quat: new Quaternion(),
  vel: new Vector3(9, 6, 14),
  angVel: new Vector3(),
  charge: 0,
  chargeTeam: -1,
  visible: true,
};
const snap: WorldSnapshot = {
  tick: 0,
  time: 0,
  phase: 'playing',
  cars: [makeCar(0, 0), makeCar(1, 1), makeCar(2, 0), makeCar(3, 1)],
  ball,
  padsActive: PAD_LAYOUT.map(() => true),
  surge: surgeParam,
};

// placeholder actor meshes
const actors = new Group();
const carMeshes: Group[] = [];
const carGeo = new BoxGeometry(CAR.halfExtents.x * 2, CAR.halfExtents.y * 2, CAR.halfExtents.z * 2);
const stripeGeo = new BoxGeometry(CAR.halfExtents.x * 2.04, 0.06, CAR.halfExtents.z * 2.04);
for (const car of snap.cars) {
  const g = new Group();
  const paint = new MeshPhysicalMaterial({
    color: new Color(car.id === 0 ? '#e8eef7' : car.team === 0 ? '#2a2f3a' : '#b3122e'),
    metalness: 0.55,
    roughness: 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  });
  const body = new Mesh(carGeo, paint);
  body.castShadow = true;
  const stripe = new Mesh(stripeGeo, new MeshStandardMaterial({ color: 0x000000, emissive: new Color(TEAMS[car.team].primary), emissiveIntensity: 3 }));
  stripe.position.y = -0.05;
  g.add(body, stripe);
  carMeshes.push(g);
  actors.add(g);
}
const ballMat = new MeshStandardMaterial({ color: 0x223344, emissive: new Color('#cfe8ff'), emissiveIntensity: 2.2, roughness: 0.3, metalness: 0.1 });
const ballMesh = new Mesh(new SphereGeometry(BALL.radius, 48, 32), ballMat);
ballMesh.castShadow = true;
const ballLight = new PointLight(0xcfe8ff, 60, 22, 2);
actors.add(ballMesh, ballLight);
if (showActors && !useReal) render.scene.add(actors);

/** Optional integration smoke test with the real actor modules (?real=1), loaded dynamically. */
async function loadRealActors(): Promise<void> {
  const [{ CarView }, { BallView }, { BoostPadsView }, { VFXSystem }] = await Promise.all([
    import('../src/render/CarView'),
    import('../src/render/BallView'),
    import('../src/render/BoostPadsView'),
    import('../src/render/VFXSystem'),
  ]);
  const styles = ['striker', 'viper', 'titan'] as const;
  const paints = ['#e8eef7', '#2a2f3a', '#b3122e', '#1947c2'];
  for (const c of snap.cars) {
    const v = new CarView({ team: c.team, style: styles[c.id % 3], paint: paints[c.id % 4], isPlayer: c.id === 0, name: 'BOT ' + c.id, nameplate: c.id !== 0 });
    real.cars.push(v);
    render.scene.add(v.object);
  }
  real.ball = new BallView();
  render.scene.add(real.ball.object);
  real.pads = new BoostPadsView(PAD_LAYOUT);
  render.scene.add(real.pads.object);
  real.vfx = new VFXSystem();
  render.scene.add(real.vfx.object);
  await render.precompile();
}

// ------------------------------------------------------------------------------------------ fake motion
const up = new Vector3();
const fwd = new Vector3();
const right = new Vector3();
const mtx = new (class {
  set(f: Vector3, u: Vector3, q: Quaternion) {
    // car local frame: +Z forward, +Y up, +X left
    right.crossVectors(u, f).normalize(); // = +X (left)
    const m = [right.x, u.x, f.x, right.y, u.y, f.y, right.z, u.z, f.z];
    // rotation matrix columns (x=left, y=up, z=forward) -> quaternion
    const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
    const tr = m00 + m11 + m22;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1);
      q.set((m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s);
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      q.set(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s);
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      q.set((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s);
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      q.set((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s);
    }
    q.normalize();
  }
})();

const kickoffPose = P.get('kick') === '1';
function updateCars(t: number): void {
  const ride = CAR.rideHeight;
  if (kickoffPose) {
    // kickoff: player at the back spot facing +Z, others on their spots, ball at center
    const spots: Array<[number, number, Team]> = [
      [0, -44, 0],
      [0, 44, 1],
      [-20, -26, 0],
      [20, 26, 1],
    ];
    snap.cars.forEach((c, i) => {
      const [x, z, team] = spots[i];
      c.pos.set(x, ride, z);
      c.vel.set(0, 0, 0);
      fwd.set(-x, 0, -z).normalize();
      up.set(0, 1, 0);
      mtx.set(fwd, up, c.quat);
      c.team = team;
      c.boosting = false;
      c.supersonic = false;
      c.onGround = true;
    });
    return;
  }
  // car 0: big oval on the floor, boosts on the straights
  {
    const c = snap.cars[0];
    const w = 0.42;
    const a = t * w;
    c.pos.set(Math.cos(a) * 20, ride, Math.sin(a) * 30);
    c.vel.set(-Math.sin(a) * 20 * w, 0, Math.cos(a) * 30 * w);
    fwd.copy(c.vel).normalize();
    up.set(0, 1, 0);
    mtx.set(fwd, up, c.quat);
    const sp = c.vel.length();
    c.boosting = Math.sin(a * 2) > 0.2;
    c.supersonic = sp > CAR.supersonicSpeed;
    c.onGround = true;
  }
  // car 1: riding the +X side wall
  {
    const c = snap.cars[1];
    const a = t * 0.35;
    const x = ARENA.halfWidth - ride;
    c.pos.set(x, 8 + Math.sin(a * 2.0) * 3.5, Math.sin(a) * 26);
    c.vel.set(0, Math.cos(a * 2.0) * 3.5 * 0.7, Math.cos(a) * 26 * 0.35);
    fwd.copy(c.vel).normalize();
    up.set(-1, 0, 0);
    mtx.set(fwd, up, c.quat);
    c.boosting = false;
    c.onGround = true;
  }
  // car 2: jumping near the center
  {
    const c = snap.cars[2];
    const ph = (t * 0.5) % 1;
    const air = Math.max(0, Math.sin(ph * Math.PI)) * 7;
    c.pos.set(-10 + Math.sin(t * 0.3) * 6, ride + air, -14 + ph * 20);
    c.vel.set(0, Math.cos(ph * Math.PI) * 7, 10);
    fwd.set(0, Math.cos(ph * Math.PI) * 0.4, 1).normalize();
    up.set(0, 1, 0);
    mtx.set(fwd, up, c.quat);
    c.onGround = air < 0.05;
    c.boosting = air > 1;
  }
  // car 3: circling near the +Z goal
  {
    const c = snap.cars[3];
    const a = -t * 0.8;
    c.pos.set(Math.cos(a) * 9, ride, 36 + Math.sin(a) * 6);
    c.vel.set(-Math.sin(a) * 9 * -0.8, 0, Math.cos(a) * 6 * -0.8);
    fwd.copy(c.vel).normalize();
    up.set(0, 1, 0);
    mtx.set(fwd, up, c.quat);
    c.onGround = true;
    c.boosting = true;
  }
}

const nrm = new Vector3();
let lastGoalAt = -10;
function stepBall(dt: number, time: number): void {
  const b = ball;
  const sub = 4;
  const h = dt / sub;
  for (let i = 0; i < sub; i++) {
    b.vel.y -= GRAVITY * (1 - 0.7 * snap.surge) * h;
    b.pos.addScaledVector(b.vel, h);
    const d = arenaSDF(b.pos.x, b.pos.y, b.pos.z);
    if (d < BALL.radius) {
      arenaNormal(b.pos.x, b.pos.y, b.pos.z, nrm);
      const vn = b.vel.dot(nrm);
      if (vn < 0) {
        b.vel.addScaledVector(nrm, -(1 + 0.78) * vn);
        const s = Math.min(1, -vn / 22);
        if (-vn > 2.5) render.arena.onImpact({ x: b.pos.x - nrm.x, y: b.pos.y - nrm.y, z: b.pos.z - nrm.z }, nrm, s);
      }
      b.pos.addScaledVector(nrm, BALL.radius - d);
    }
  }
  // keep it lively
  if (b.vel.length() < 9 && b.pos.y < 2) b.vel.set((Math.random() - 0.5) * 30, 12 + Math.random() * 8, (Math.random() - 0.5) * 40);
  const g = goalScoredBy(b.pos);
  if (g !== -1 && time - lastGoalAt > 2) {
    lastGoalAt = time;
    render.arena.onGoal(g, b.pos);
    render.flash(TEAMS[g].secondary, 0.8);
    render.cameraRig.shake(0.8);
    b.pos.set(0, 6, 0);
    b.vel.set((Math.random() - 0.5) * 20, 8, (Math.random() - 0.5) * 30);
  }
  // cycle the charge for visuals
  const lvl = Math.floor((time / 5) % 4);
  b.charge = lvl;
  b.chargeTeam = lvl === 0 ? -1 : ((Math.floor(time / 20) % 2) as Team);
}

function syncActorMeshes(): void {
  for (let i = 0; i < snap.cars.length; i++) {
    const c = snap.cars[i];
    carMeshes[i].position.copy(c.pos);
    carMeshes[i].quaternion.copy(c.quat);
  }
  ballMesh.position.copy(ball.pos);
  ballLight.position.copy(ball.pos);
  const col = ball.chargeTeam === -1 ? new Color('#cfe8ff') : new Color(TEAMS[ball.chargeTeam].primary);
  ballMat.emissive.copy(col);
  ballLight.color.copy(col);
}

// ------------------------------------------------------------------------------------------ loop
const fx: FrameFx = {
  speed01: num('speed', 0),
  boosting: num('speed', 0) > 0.6,
  supersonic: num('speed', 0) > 0.9,
  surge: surgeParam,
  replay: P.get('replay') === '1',
  paused: P.get('paused') === '1',
};
const ctx: CameraContext = {
  mode: camMode,
  target: snap.cars[Math.min(3, Math.max(0, num('follow', 0)))],
  ball,
  snap,
  ballCam: settings.ballCamDefault,
  time: 0,
  focus: camMode === 'goal' ? { x: 0, y: 2, z: ARENA.halfLength + 2 } : camMode === 'endPodium' ? { x: 0, y: 0.5, z: 0 } : undefined,
  team: 0,
};

let time = num('t', 0);
let last = performance.now();
let nextRipple = 1;
let nextGoal = 3;

// deterministic initial state for screenshots
updateCars(time);
syncActorMeshes();

async function main(): Promise<void> {
  if (useReal) await loadRealActors();
  const t0 = performance.now();
  await render.init((p, label) => {
    loading.textContent = `${label} — ${Math.round(p * 100)}%`;
  });
  (window as unknown as { __initMs: number }).__initMs = Math.round(performance.now() - t0);
  loading.remove();
  if (P.get('hud') === '1') hud.hidden = false;
  ctx.time = time;
  render.arena.update(0, time, snap);
  render.cameraRig.snap(ctx);
  render.renderer.setAnimationLoop(frame);
}

function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!freeze) time += dt;
  snap.time = time;
  snap.surge = P.has('surge') ? surgeParam : 0;
  updateCars(time);
  if (!freeze && !kickoffPose) stepBall(dt, time);
  syncActorMeshes();

  if (P.get('ripples') === '1' && time > nextRipple) {
    nextRipple = time + 0.45;
    const a = Math.random() * Math.PI * 2;
    const y = 1 + Math.random() * 14;
    const x = Math.cos(a) * ARENA.halfWidth;
    const z = Math.sin(a) * ARENA.halfLength;
    const p = new Vector3(x, y, z);
    // project onto the wall roughly
    const s = arenaSDF(p.x, p.y, p.z);
    arenaNormal(p.x, p.y, p.z, nrm);
    p.addScaledVector(nrm, -s);
    render.arena.onImpact(p, nrm, 0.3 + Math.random() * 0.7);
  }
  if (P.get('goal') === '1' && time > nextGoal) {
    nextGoal = time + 6;
    const team = (Math.floor(time / 6) % 2) as Team;
    render.arena.onGoal(team, { x: 0, y: 2, z: team === 0 ? ARENA.halfLength + 2 : -ARENA.halfLength - 2 });
    render.flash(TEAMS[team].secondary, 0.9);
    render.cameraRig.shake(0.9);
  }
  if (useReal) {
    const cam = render.camera;
    for (let i = 0; i < real.cars.length; i++) real.cars[i].update(snap.cars[i], dt, time, cam);
    real.ball?.update(ball, dt, time, cam);
    real.pads?.update(snap.padsActive, dt, time);
    real.vfx?.update(dt, time, snap, cam);
  }
  render.arena.setScoreboard([2, 1], 154 - Math.floor(time), false);
  render.arena.update(dt, time, snap);
  ctx.time = time;
  render.cameraRig.update(dt, ctx);
  render.render(dt, time, fx);

  if (!hud.hidden) {
    const s = render.getStats();
    const d = render.getDebugStats();
    hud.textContent = `fps ${s.fps.toFixed(1)}  frame ${s.frameMs.toFixed(1)}ms  gpu ${d.gpuMs.toFixed(2)}ms  cpu ${d.cpuMs.toFixed(2)}ms\ncalls ${s.drawCalls}  tris ${s.triangles}\npr ${s.pixelRatio}  ${d.drawW}x${d.drawH}  refl ${d.reflW}x${d.reflH}\nq ${s.quality}  cam ${camMode}`;
  }
}

declare global {
  interface Window {
    __stats: () => unknown;
    __debug: () => unknown;
    __verify: () => unknown;
    __render: RenderSystem;
  }
}
window.__stats = () => render.getStats();
window.__debug = () => ({ ...render.getStats(), ...render.getDebugStats() });
window.__verify = () => {
  const ff = buildForceFieldGeometry();
  const { net, portal } = buildGoalGeometries();
  const frame = buildGoalFrameGeometry();
  // force field: exclude vertices inside goal mouths (carved) — those are discarded per pixel
  const G = ARENA.goalHalfWidth;
  const res = {
    forceField: verifyAgainstSDF(ff, (x, y, z) => !(Math.abs(x) < G + 0.5 && y < ARENA.goalHeight + 0.5 && Math.abs(z) > ARENA.halfLength - ARENA.edgeRadius - 0.5)),
    goalNet: verifyAgainstSDF(net, (x, y, z) => Math.abs(z) > ARENA.halfLength + 0.3 && arenaSDF(x, y, z) < 2),
    goalPortal: verifyAgainstSDF(portal),
    // frame: exposed vertices lie ON the tube surface => SDF ~ 0 (the halves buried in the end wall are skipped;
    // the two crossbar corners are intentionally rounded by ~0.45 m for looks)
    goalFrame: verifyAgainstSDF(frame, (x, y, z) => y > 0.05 && arenaSDF(x, y, z) > -0.02 && !(y > ARENA.goalHeight - 0.8 && Math.abs(Math.abs(x) - ARENA.goalHalfWidth) < 0.8)),
  };
  ff.dispose();
  net.dispose();
  portal.dispose();
  frame.dispose();
  return res;
};
window.__render = render;

/**
 * Dev GPU profiler: per-draw timer queries (onBeforeRender/onAfterRender) + composer passes + reflection.
 * Usage: await window.__profile(3000) -> sorted list of [name, avg ms per frame].
 */
(window as unknown as { __profile: (ms: number) => Promise<string> }).__profile = async (ms: number) => {
  const gl = render.renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number } | null;
  if (!ext) return 'no timer ext';
  const totals = new Map<string, number>();
  const pending: Array<{ q: WebGLQuery; name: string }> = [];
  let active: WebGLQuery | null = null;
  const begin = (name: string) => {
    if (active) return;
    const q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    active = q;
    pending.push({ q, name });
  };
  const end = () => {
    if (!active) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    active = null;
  };
  const poll = () => {
    while (pending.length && pending[0].q !== active && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, name } = pending.shift()!;
      totals.set(name, (totals.get(name) ?? 0) + gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  };
  // disable the frame-level timer while profiling
  const rs = render as unknown as { timerExt: unknown };
  const savedExt = rs.timerExt;
  rs.timerExt = null;
  const restore: Array<() => void> = [];
  render.scene.traverse((o) => {
    const m = o as Mesh;
    if (!(m as unknown as { isMesh?: boolean; isPoints?: boolean }).isMesh && !(m as unknown as { isPoints?: boolean }).isPoints) return;
    const name = o.name || o.parent?.name || o.type;
    const ob = o.onBeforeRender;
    const oa = o.onAfterRender;
    o.onBeforeRender = (...a) => {
      begin(name);
      (ob as (...x: unknown[]) => void).apply(o, a);
    };
    o.onAfterRender = (...a) => {
      (oa as (...x: unknown[]) => void).apply(o, a);
      end();
    };
    restore.push(() => {
      o.onBeforeRender = ob;
      o.onAfterRender = oa;
    });
  });
  // composer passes
  const passes = (render.post.composer as unknown as { passes: Array<{ name: string; render: (...a: unknown[]) => void }> }).passes;
  for (const pass of passes) {
    const orig = pass.render;
    const label = 'PASS ' + pass.name;
    pass.render = function (this: unknown, ...a: unknown[]) {
      if (label === 'PASS RenderPass') {
        orig.apply(this, a);
        return;
      }
      begin(label);
      orig.apply(this, a);
      end();
    } as typeof orig;
    restore.push(() => {
      pass.render = orig;
    });
  }
  let frames = 0;
  const t0 = performance.now();
  await new Promise<void>((res) => {
    const f = () => {
      poll();
      frames++;
      if (performance.now() - t0 < ms) requestAnimationFrame(f);
      else res();
    };
    requestAnimationFrame(f);
  });
  await new Promise((r) => setTimeout(r, 200));
  poll();
  for (const r of restore) r();
  rs.timerExt = savedExt;
  const rows = [...totals.entries()].map(([k, v]) => [k, v / frames] as [string, number]).sort((a, b) => b[1] - a[1]);
  const sum = rows.reduce((a, b) => a + b[1], 0);
  return `frames=${frames} sum=${sum.toFixed(2)}ms\n` + rows.map(([k, v]) => `${k}: ${v.toFixed(3)}`).join('\n');
};

main().catch((e) => {
  loading.textContent = 'init failed: ' + (e as Error).message;
  console.error(e);
});
