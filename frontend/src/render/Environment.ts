/**
 * NOVABALL render-world — Environment: sky (baked nebula cube), gas giant + ring + sun, space dust, image-based
 * lighting (PMREM from a stadium light "environment scene") and the real lights (1 shadow-casting directional
 * key light that follows the action + a cool hemisphere fill).
 */
import {
  DirectionalLight,
  Group,
  HemisphereLight,
  PCFShadowMap,
  Vector3,
  type Matrix3,
  type PerspectiveCamera,
  type Scene,
  type WebGLCubeRenderTarget,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { ARENA } from '../sim/constants';
import { Dust } from './world/Dust';
import { buildEnvMap } from './world/EnvMap';
import { Planet } from './world/Planet';
import type { WorldQuality } from './world/quality';
import { bakeSkyCube, SkyDome } from './world/Sky';

/** Direction TO the key light (near overhead, slightly toward -Z / +X so shadows fall a bit forward). */
const KEY_DIR = new Vector3(0.16, 1.0, -0.2).normalize();
const KEY_DIST = 90;

export class Environment {
  readonly group = new Group();
  readonly keyLight: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly planet = new Planet();
  readonly sky = new SkyDome();
  private dust: Dust;
  private skyRT: WebGLCubeRenderTarget | null = null;
  private envRT: WebGLRenderTarget | null = null;
  private quality: WorldQuality;
  private skySize = 0;
  private skyStars = 0;
  private envDirty = true;
  private planetBaked = false;
  // shadow-follow scratch
  private readonly lightRight = new Vector3();
  private readonly lightUp = new Vector3();
  private readonly tmp = new Vector3();
  private bgDrift = 0;

  constructor(q: WorldQuality) {
    this.quality = q;
    this.group.name = 'Environment';
    this.keyLight = new DirectionalLight(0xfff1e4, 2.3);
    this.keyLight.name = 'KeyLight';
    this.keyLight.castShadow = true;
    const sh = this.keyLight.shadow;
    sh.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    sh.radius = q.shadowRadius;
    sh.bias = -0.00025;
    sh.normalBias = 0.025;
    const cam = sh.camera;
    cam.left = -q.shadowExtent;
    cam.right = q.shadowExtent;
    cam.top = q.shadowExtent;
    cam.bottom = -q.shadowExtent;
    cam.near = 20;
    cam.far = KEY_DIST + 40;
    cam.updateProjectionMatrix();
    this.keyLight.position.copy(KEY_DIR).multiplyScalar(KEY_DIST);
    this.keyLight.target.position.set(0, 0, 0);
    this.group.add(this.keyLight, this.keyLight.target);

    this.hemi = new HemisphereLight(0x4a5ea8, 0x0b0812, 0.5);
    this.hemi.name = 'HemiFill';
    this.group.add(this.hemi);

    // light-space basis for texel snapping
    this.lightRight.set(0, 1, 0).cross(KEY_DIR).normalize();
    this.lightUp.copy(KEY_DIR).cross(this.lightRight).normalize();

    this.group.add(this.sky.mesh);
    this.group.add(this.planet.group);
    this.dust = new Dust(q.dustCount);
    this.group.add(this.dust.points);
  }

  /** Renderer state the environment relies on (shadow map type). */
  prepare(renderer: WebGLRenderer): void {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
  }

  /**
   * Bake sky + env map + planet (once, and again if the sky resolution preset changes). `force` re-bakes everything,
   * e.g. after a WebGL context restore (render-target contents are lost with the context). Idempotent.
   * RenderSystem.init() runs the same steps one by one (bakeSky / bakeEnvMap / bakePlanet) to report progress.
   */
  build(renderer: WebGLRenderer, scene: Scene, force = false): void {
    this.prepare(renderer);
    this.bakeSky(renderer, scene, force);
    this.bakeEnvMap(renderer, scene, force);
    this.bakePlanet(renderer, force);
  }

  /**
   * After a WebGL context restore: the baked targets died with the old context. Forget them WITHOUT dispose() (their
   * GL objects belong to the dead context — deleting them only produced "object does not belong to this context"
   * warnings) and bake everything again.
   */
  rebuildAfterContextLoss(renderer: WebGLRenderer, scene: Scene): void {
    this.skyRT = null;
    this.envRT = null;
    this.planet.forgetBake();
    this.build(renderer, scene, true);
  }

  /** Bake the nebula/star cube (skipped when already baked with the current settings, unless `force`). */
  bakeSky(renderer: WebGLRenderer, scene: Scene, force = false): boolean {
    const q = this.quality;
    if (!force && this.skyRT && this.skySize === q.skyCubeSize && this.skyStars === q.starDensity) return false;
    const old = this.skyRT;
    this.skyRT = bakeSkyCube(renderer, q.skyCubeSize, q.starDensity);
    this.skySize = q.skyCubeSize;
    this.skyStars = q.starDensity;
    scene.background = null;
    this.sky.setTexture(this.skyRT.texture);
    old?.dispose();
    this.envDirty = true;
    return true;
  }

  /** Stadium-lights PMREM for the car/ball IBL (needs the sky cube). */
  bakeEnvMap(renderer: WebGLRenderer, scene: Scene, force = false): void {
    if (!force && !this.envDirty && this.envRT) return;
    const oldEnv = this.envRT;
    this.envRT = buildEnvMap(renderer, this.skyRT ? this.skyRT.texture : null);
    scene.environment = this.envRT.texture;
    scene.environmentIntensity = 1;
    oldEnv?.dispose();
    this.envDirty = false;
  }

  /** Planet albedo (baked once at the initial quality). */
  bakePlanet(renderer: WebGLRenderer, force = false): void {
    if (!force && this.planetBaked) return;
    this.planet.bake(renderer, this.quality.skyCubeSize >= 1024 ? 2048 : 1024);
    this.planetBaked = true;
  }

  setQuality(renderer: WebGLRenderer, scene: Scene, q: WorldQuality): void {
    this.quality = q;
    const sh = this.keyLight.shadow;
    if (sh.mapSize.x !== q.shadowMapSize) {
      sh.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      sh.map?.dispose();
      sh.map = null;
    }
    sh.radius = q.shadowRadius;
    const cam = sh.camera;
    cam.left = -q.shadowExtent;
    cam.right = q.shadowExtent;
    cam.top = q.shadowExtent;
    cam.bottom = -q.shadowExtent;
    cam.updateProjectionMatrix();
    if (this.skyRT && this.bakeSky(renderer, scene)) this.bakeEnvMap(renderer, scene);
    if (this.dust.points.geometry.getAttribute('position').count !== q.dustCount) {
      this.group.remove(this.dust.points);
      this.dust.dispose();
      this.dust = new Dust(q.dustCount);
      this.group.add(this.dust.points);
    }
  }

  /**
   * Per frame: sky objects follow the camera, dust drift, surge sky drift, shadow frustum follows `focus`
   * (a point on the floor in front of the camera), snapped to shadow texels to avoid shimmering.
   */
  update(dt: number, time: number, camera: PerspectiveCamera, scene: Scene, surge: number, focus: Vector3, pxScale: number): void {
    this.planet.update(time, camera, surge);
    this.dust.update(dt, time, surge, pxScale);
    if (surge > 0.001) {
      this.bgDrift += dt * surge * 0.02;
      const c = Math.cos(this.bgDrift);
      const s = Math.sin(this.bgDrift);
      // rotation about X (stars drift upward in front of the viewer)
      (this.sky.material.uniforms.uRot.value as Matrix3).set(1, 0, 0, 0, c, -s, 0, s, c);
    }
    void scene;
    // shadow follow
    const q = this.quality;
    const texel = (2 * q.shadowExtent) / q.shadowMapSize;
    const fr = Math.round(focus.dot(this.lightRight) / texel) * texel;
    const fu = Math.round(focus.dot(this.lightUp) / texel) * texel;
    const fd = focus.dot(KEY_DIR);
    this.tmp.copy(this.lightRight).multiplyScalar(fr).addScaledVector(this.lightUp, fu).addScaledVector(KEY_DIR, fd);
    this.keyLight.target.position.copy(this.tmp);
    this.keyLight.position.copy(this.tmp).addScaledVector(KEY_DIR, KEY_DIST);
    this.keyLight.target.updateMatrixWorld();
  }

  get skyTexture(): WebGLCubeRenderTarget | null {
    return this.skyRT;
  }

  dispose(): void {
    this.planet.dispose();
    this.sky.dispose();
    this.dust.dispose();
    this.skyRT?.dispose();
    this.envRT?.dispose();
    this.keyLight.shadow.map?.dispose();
    this.keyLight.dispose();
    this.hemi.dispose();
  }
}

/** Clamp a floor focus point to the arena footprint (shadow frustum center). */
export function clampToArena(v: Vector3): Vector3 {
  v.x = Math.max(-ARENA.halfWidth, Math.min(ARENA.halfWidth, v.x));
  v.z = Math.max(-(ARENA.halfLength + ARENA.goalDepth), Math.min(ARENA.halfLength + ARENA.goalDepth, v.z));
  v.y = 0;
  return v;
}
