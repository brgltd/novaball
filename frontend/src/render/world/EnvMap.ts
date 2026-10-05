/**
 * NOVABALL render-world — image-based lighting.
 * Builds a small "environment scene" (dim nebula + bright stadium light banks, team-colored strips, LED
 * ribbons, the sun and the planet) and converts it to a PMREM once. Clearcoat car paint and the ball pick up
 * crisp, colorful reflections from it.
 */
import {
  CircleGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  Vector3,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
  CylinderGeometry,
  BackSide,
} from 'three';
import { TEAMS } from '../../theme';
import { PLANET_DIR, SUN_DIR } from './Planet';

const R = 40;

function dirFromAngles(azimuthDeg: number, elevationDeg: number, out = new Vector3()): Vector3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  // azimuth 0 = +Z, 90 = +X
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

export function buildEnvMap(renderer: WebGLRenderer, sky: Texture | null): WebGLRenderTarget {
  const scene = new Scene();
  if (sky) {
    scene.background = sky;
    scene.backgroundIntensity = 0.55;
  } else {
    scene.background = new Color(0x020308);
  }
  const disposables: Array<{ dispose(): void }> = [];
  const panel = (w: number, h: number, color: Color, dir: Vector3, dist = R) => {
    const g = new PlaneGeometry(w, h);
    const m = new MeshBasicMaterial({ color, side: DoubleSide, toneMapped: false });
    disposables.push(g, m);
    const mesh = new Mesh(g, m);
    mesh.position.copy(dir).multiplyScalar(dist);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
    return mesh;
  };

  // Floodlight banks at the 4 corner towers + fill banks in between.
  const white = new Color(1.0, 0.96, 0.9).multiplyScalar(16);
  for (const az of [40, 140, 220, 320]) panel(9, 4.2, white, dirFromAngles(az, 36));
  const fill = new Color(0.85, 0.9, 1.0).multiplyScalar(5);
  for (const az of [0, 90, 180, 270]) panel(12, 2.2, fill, dirFromAngles(az, 28));

  // Team strips at each end (VOLT defends -Z => azimuth 180, BLAZE defends +Z => azimuth 0).
  const volt = new Color(TEAMS[0].primary).multiplyScalar(3.2);
  const blaze = new Color(TEAMS[1].primary).multiplyScalar(3.2);
  panel(46, 2.6, volt, dirFromAngles(180, 9));
  panel(46, 2.6, blaze, dirFromAngles(0, 9));
  // Lower LED ribbon ring around the stands (cylinder band seen from inside).
  const ribbonGeo = new CylinderGeometry(R, R, 1.4, 64, 1, true);
  const ribbonMat = new MeshBasicMaterial({ color: new Color(0.45, 0.6, 1.0).multiplyScalar(1.1), side: BackSide, toneMapped: false });
  disposables.push(ribbonGeo, ribbonMat);
  const ribbon = new Mesh(ribbonGeo, ribbonMat);
  ribbon.position.y = 2.2;
  scene.add(ribbon);

  // Dark mirror floor below.
  const floorGeo = new CircleGeometry(R * 2, 48);
  const floorMat = new MeshBasicMaterial({ color: new Color(0.004, 0.005, 0.009), side: DoubleSide, toneMapped: false });
  disposables.push(floorGeo, floorMat);
  const floor = new Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -6;
  scene.add(floor);

  // Sun and planet.
  const sunGeo = new CircleGeometry(1.4, 24);
  const sunMat = new MeshBasicMaterial({ color: new Color(1.0, 0.9, 0.78).multiplyScalar(60), toneMapped: false });
  disposables.push(sunGeo, sunMat);
  const sun = new Mesh(sunGeo, sunMat);
  sun.position.copy(SUN_DIR).multiplyScalar(R);
  sun.lookAt(0, 0, 0);
  scene.add(sun);
  const planetGeo = new CircleGeometry(12, 40);
  const planetMat = new MeshBasicMaterial({ color: new Color(0.9, 0.6, 0.45).multiplyScalar(0.35), toneMapped: false });
  disposables.push(planetGeo, planetMat);
  const planet = new Mesh(planetGeo, planetMat);
  planet.position.copy(PLANET_DIR).multiplyScalar(R * 1.2);
  planet.lookAt(0, 0, 0);
  scene.add(planet);

  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.012, 0.1, 200, { size: 256 });
  rt.texture.name = 'NovaEnvPMREM';
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  return rt;
}
