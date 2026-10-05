/**
 * DebrisPool — tumbling hex-plate shards (demolitions, goal "shell fragments") in ONE instanced draw call.
 * Lit (MeshStandardMaterial, reflects the environment) with a per-instance emissive "heat" that cools down.
 */
import {
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';

const F = 20; // [x y z vx vy vz ax ay az ang angVel scale age life r g b heat, _, _]

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _a = new Vector3();

export class DebrisPool {
  readonly mesh: InstancedMesh;
  private readonly data: Float32Array;
  private readonly cap: number;
  private readonly heat: InstancedBufferAttribute;
  private readonly mat: MeshStandardMaterial;
  private n = 0;

  constructor(capacity = 96) {
    this.cap = capacity;
    this.data = new Float32Array(capacity * F);
    const geo = new CylinderGeometry(1, 1, 0.22, 6, 1).toNonIndexed();
    geo.computeVertexNormals();
    this.heat = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.heat.setUsage(DynamicDrawUsage);
    geo.setAttribute('iHeat', this.heat);
    this.mat = new MeshStandardMaterial({ color: new Color(0.16, 0.17, 0.2), roughness: 0.35, metalness: 0.85, emissive: new Color(1, 1, 1) });
    this.mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 iHeat;\nvarying vec4 vHeat;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = iHeat;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vHeat;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vHeat.rgb * vHeat.a;');
    };
    this.mat.customProgramCacheKey = () => 'novaball-debris-v1';
    this.mesh = new InstancedMesh(geo, this.mat, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'debris';
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, scale: number, life: number, r: number, g: number, b: number, heat: number, angVel: number): void {
    if (this.n >= this.cap) return;
    const o = this.n * F;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = vx;
    d[o + 4] = vy;
    d[o + 5] = vz;
    // random-ish axis from velocity
    _a.set(vy + 0.3, vz - 0.2, vx + 0.1).normalize();
    d[o + 6] = _a.x;
    d[o + 7] = _a.y;
    d[o + 8] = _a.z;
    d[o + 9] = 0;
    d[o + 10] = angVel;
    d[o + 11] = scale;
    d[o + 12] = 0;
    d[o + 13] = life;
    d[o + 14] = r;
    d[o + 15] = g;
    d[o + 16] = b;
    d[o + 17] = heat;
    this.n++;
  }

  clear(): void {
    this.n = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  update(dt: number, gravity: number): void {
    const d = this.data;
    const h = this.heat.array as Float32Array;
    let i = 0;
    while (i < this.n) {
      const o = i * F;
      const age = d[o + 12] + dt;
      if (age >= d[o + 13]) {
        this.n--;
        if (i !== this.n) d.copyWithin(o, this.n * F, this.n * F + F);
        continue;
      }
      d[o + 12] = age;
      const t = age / d[o + 13];
      d[o + 4] -= gravity * dt;
      const k = Math.max(0, 1 - 0.35 * dt);
      d[o + 3] *= k;
      d[o + 5] *= k;
      d[o] += d[o + 3] * dt;
      d[o + 1] += d[o + 4] * dt;
      d[o + 2] += d[o + 5] * dt;
      const sc = d[o + 11];
      if (d[o + 1] < sc * 0.12 && d[o + 4] < 0) {
        d[o + 1] = sc * 0.12;
        d[o + 4] = -d[o + 4] * 0.35;
        d[o + 3] *= 0.6;
        d[o + 5] *= 0.6;
        d[o + 10] *= 0.6;
      }
      d[o + 9] += d[o + 10] * dt;
      _p.set(d[o], d[o + 1], d[o + 2]);
      _a.set(d[o + 6], d[o + 7], d[o + 8]);
      _q.setFromAxisAngle(_a, d[o + 9]);
      const shrink = t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
      _s.set(sc, sc, sc).multiplyScalar(shrink);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
      const cool = Math.pow(1 - t, 2.2);
      h[i * 4] = d[o + 14];
      h[i * 4 + 1] = d[o + 15];
      h[i * 4 + 2] = d[o + 16];
      h[i * 4 + 3] = d[o + 17] * cool;
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, this.n * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.heat.clearUpdateRanges();
      this.heat.addUpdateRange(0, this.n * 4);
      this.heat.needsUpdate = true;
    }
  }

  get active(): number {
    return this.n;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}
