/**
 * NOVABALL AI viewer (dev tool, not part of the game): runs World + BotManagers in the browser and draws a simple
 * 3D view (boxes / sphere) with each bot's role and mode — for eyeballing bot behaviour and browser compatibility.
 *
 *   npx vite --port <port> --strictPort   then open  /tests/ai/viewer/index.html?ts=2&d0=pro&d1=legend&seed=3&cam=chase:0
 * Params: ts (1..3), d0/d1 (rookie|pro|legend), seed, speed (time scale), t (fast-forward seconds), cam (top|side|chase:<id>)
 */
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { BotManager } from '../../../src/ai/BotManager';
import { ARENA, BALL, CAR, DT } from '../../../src/sim/constants';
import type { Difficulty, TeamSize } from '../../../src/sim/types';
import { makeControlState } from '../../../src/sim/types';
import { World } from '../../../src/sim/world';

const q = new URLSearchParams(location.search);
const ts = Math.min(3, Math.max(1, Number(q.get('ts') ?? 2))) as TeamSize;
const d0 = (q.get('d0') ?? 'pro') as Difficulty;
const d1 = (q.get('d1') ?? 'pro') as Difficulty;
const seed = Number(q.get('seed') ?? 1);
const speed = Number(q.get('speed') ?? 1);
const ff = Number(q.get('t') ?? 0);
const cam = q.get('cam') ?? 'side';

const world = new World({
  teamSize: ts,
  durationSec: 180,
  difficulty: d0,
  seed,
  freePlay: false,
  mutators: { charge: true, pulse: true, surges: true, demolitions: true },
  player: null,
});
const ids = (t: number) => world.cars.filter((c) => c.team === t).map((c) => c.id);
const managers = [new BotManager(world, ids(0), d0, seed * 31 + 7), new BotManager(world, ids(1), d1, seed * 57 + 3)];
const inputs = world.cars.map(() => makeControlState());
const events: string[] = [];

function step(): void {
  for (const m of managers) m.update(world, inputs);
  world.step(inputs);
  for (const e of world.drainEvents()) {
    if (e.type === 'goal' || e.type === 'demolish' || e.type === 'pulse' || e.type === 'save' || e.type === 'kickoff') {
      events.unshift(`${world.time.toFixed(1)}s ${e.type}${'carId' in e ? ' #' + e.carId : ''}${e.type === 'goal' ? ' team ' + e.team : ''}`);
      if (events.length > 6) events.pop();
    }
  }
}
for (let i = 0; i < Math.round(ff / DT); i++) step();

// ---- scene
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new Scene();
scene.background = new Color('#05070d');
scene.add(new AmbientLight('#8899bb', 1.2));
const sun = new DirectionalLight('#ffffff', 2.2);
sun.position.set(20, 40, 10);
scene.add(sun);
const camera = new PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);

const W = ARENA.halfWidth;
const L = ARENA.halfLength;
const floor = new Mesh(new PlaneGeometry(W * 2, L * 2), new MeshStandardMaterial({ color: '#0b1220', roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new GridHelper(L * 2, 20, '#1b2a44', '#131d30');
grid.scale.set(W / L, 1, 1);
grid.position.y = 0.01;
scene.add(grid);
const box = new LineSegments(new EdgesGeometry(new BoxGeometry(W * 2, ARENA.height, L * 2)), new LineBasicMaterial({ color: '#3d7bff' }));
box.position.y = ARENA.height / 2;
scene.add(box);
for (const [team, z] of [
  [0, -L],
  [1, L],
] as Array<[number, number]>) {
  const g = new LineSegments(
    new EdgesGeometry(new BoxGeometry(ARENA.goalHalfWidth * 2, ARENA.goalHeight, ARENA.goalDepth)),
    new LineBasicMaterial({ color: team === 0 ? '#1ec8ff' : '#ff6a1a' }),
  );
  g.position.set(0, ARENA.goalHeight / 2, z + Math.sign(z) * ARENA.goalDepth * 0.5);
  scene.add(g);
}
const hx = CAR.halfExtents;
const carMeshes = world.cars.map((c) => {
  const grp = new Group();
  const body = new Mesh(new BoxGeometry(hx.x * 2, hx.y * 2, hx.z * 2), new MeshStandardMaterial({ color: c.team === 0 ? '#1ec8ff' : '#ff6a1a', roughness: 0.4 }));
  const nose = new Mesh(new BoxGeometry(hx.x * 1.6, hx.y * 0.8, 0.12), new MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.6 }));
  nose.position.z = hx.z;
  grp.add(body, nose);
  scene.add(grp);
  return grp;
});
const ballMesh = new Mesh(new SphereGeometry(BALL.radius, 24, 16), new MeshStandardMaterial({ color: '#e6f3ff', emissive: '#88aaff', emissiveIntensity: 0.4 }));
scene.add(ballMesh);

const hud = document.getElementById('hud')!;
let acc = 0;
let last = performance.now();
const tmp = new Vector3();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt * speed;
  while (acc >= DT) {
    step();
    acc -= DT;
  }
  for (let i = 0; i < world.cars.length; i++) {
    const c = world.cars[i];
    const m = carMeshes[i];
    m.visible = !c.demolished;
    m.position.copy(c.pos);
    m.quaternion.copy(c.quat);
  }
  ballMesh.visible = !world.ball.exploded;
  ballMesh.position.copy(world.ball.pos);
  // camera
  if (cam.startsWith('chase:')) {
    const c = world.cars[Number(cam.split(':')[1]) || 0];
    tmp.copy(world.ball.pos).sub(c.pos).setY(0).normalize();
    camera.position.copy(c.pos).addScaledVector(tmp, -9).add(new Vector3(0, 4, 0));
    camera.lookAt(world.ball.pos);
  } else if (cam === 'top') {
    camera.position.set(0, 95, 0.01);
    camera.lookAt(0, 0, 0);
  } else {
    camera.position.set(-62, 38, world.ball.pos.z * 0.5);
    camera.lookAt(0, 2, world.ball.pos.z * 0.6);
  }
  const m = world.match;
  const lines = [`${ts}v${ts}  ${d0} vs ${d1}  seed ${seed}   score ${m.score[0]}-${m.score[1]}   clock ${m.clock.toFixed(0)}   ${m.phase}${m.surge.state !== 'idle' ? '  SURGE ' + m.surge.state : ''}`];
  for (const c of world.cars) {
    const st = managers[c.team].botState(c.id);
    lines.push(`#${c.id} ${c.team === 0 ? 'VOLT ' : 'BLAZE'} ${st ? st.role.padEnd(8) + ' ' + st.mode.padEnd(16) : ''} boost ${c.boost.toFixed(0).padStart(3)}  ${c.vel.length().toFixed(1)} m/s`);
  }
  hud.textContent = lines.concat(events).join('\n');
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
(globalThis as unknown as { __viewer: unknown }).__viewer = { world, managers };
