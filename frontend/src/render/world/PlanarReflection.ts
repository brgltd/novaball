/**
 * NOVABALL render-world — planar reflection for the floor (y = 0).
 * Mirrored virtual camera with an oblique near plane (Lengyel). Renders LAYER 0 only (LAYER_MAIN_ONLY excluded)
 * into a half-float target, then a separable Gaussian blur at half resolution produces a smooth "glossy" version
 * (much nicer than box-filtered mip levels). The floor mixes the sharp and blurred reflections.
 */
import {
  BufferGeometry,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';

const BLUR_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
// 9-tap Gaussian using linear-sampling offsets (5 fetches)
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
  c += texture2D(tSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

function makeTarget(depth: boolean): WebGLRenderTarget {
  const t = new WebGLRenderTarget(2, 2, {
    type: HalfFloatType,
    generateMipmaps: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: depth,
    stencilBuffer: false,
    samples: 0,
  });
  return t;
}

export class PlanarReflection {
  /** Sharp reflection. */
  readonly target: WebGLRenderTarget;
  /** Blurred (glossy) reflection, half resolution. */
  readonly blurred: WebGLRenderTarget;
  private readonly blurTmp: WebGLRenderTarget;
  /** World position → reflection texture (projective) coordinates. */
  readonly textureMatrix = new Matrix4();
  readonly camera = new PerspectiveCamera();
  scale: number;
  clipBias = 0.02;
  /** Blur radius multiplier (in blurred-target texels). */
  blurRadius = 1.6;
  private readonly plane = new Plane();
  private readonly normal = new Vector3(0, 1, 0);
  private readonly planePoint = new Vector3(0, 0, 0);
  private readonly camPos = new Vector3();
  private readonly lookAt = new Vector3();
  private readonly target3 = new Vector3();
  private readonly view = new Vector3();
  private readonly rot = new Matrix4();
  private readonly clipPlane = new Vector4();
  private readonly q = new Vector4();
  private width = 2;
  private height = 2;
  private readonly blurMat: ShaderMaterial;
  private readonly blurQuad: Mesh;
  private readonly blurCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(scale: number) {
    this.scale = scale;
    this.target = makeTarget(true);
    this.target.texture.name = 'NovaFloorReflection';
    this.blurred = makeTarget(false);
    this.blurred.texture.name = 'NovaFloorReflectionBlur';
    this.blurTmp = makeTarget(false);
    this.camera.layers.set(0);
    this.blurMat = new ShaderMaterial({
      name: 'NovaReflBlur',
      uniforms: { tSrc: { value: null as Texture | null }, uDir: { value: new Vector2() } },
      vertexShader: BLUR_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.blurQuad = new Mesh(g, this.blurMat);
    this.blurQuad.frustumCulled = false;
  }

  setSize(drawW: number, drawH: number): void {
    const w = Math.max(2, Math.round(drawW * this.scale));
    const h = Math.max(2, Math.round(drawH * this.scale));
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.target.setSize(w, h);
      const bw = Math.max(2, Math.round(w / 2));
      const bh = Math.max(2, Math.round(h / 2));
      this.blurred.setSize(bw, bh);
      this.blurTmp.setSize(bw, bh);
    }
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** Update the mirrored camera + texture matrix and render the reflection. `hide` objects are hidden meanwhile. */
  render(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, hide: ReadonlyArray<Object3D>): void {
    const rc = this.camera;
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    if (this.camPos.y <= 0.01) return; // camera below the floor: nothing sensible to reflect

    this.rot.extractRotation(camera.matrixWorld);
    this.view.subVectors(this.planePoint, this.camPos);
    this.view.reflect(this.normal).negate().add(this.planePoint);

    this.lookAt.set(0, 0, -1).applyMatrix4(this.rot).add(this.camPos);
    this.target3.subVectors(this.planePoint, this.lookAt).reflect(this.normal).negate().add(this.planePoint);

    rc.position.copy(this.view);
    rc.up.set(0, 1, 0).applyMatrix4(this.rot).reflect(this.normal);
    rc.lookAt(this.target3);
    rc.near = camera.near;
    rc.far = camera.far;
    rc.fov = camera.fov;
    rc.aspect = camera.aspect;
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(camera.projectionMatrix);

    // texture matrix (world -> [0,1]^2 projective)
    this.textureMatrix.set(0.5, 0.0, 0.0, 0.5, 0.0, 0.5, 0.0, 0.5, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.0, 1.0);
    this.textureMatrix.multiply(rc.projectionMatrix);
    this.textureMatrix.multiply(rc.matrixWorldInverse);

    // oblique near plane clipping (Lengyel)
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.planePoint);
    this.plane.applyMatrix4(rc.matrixWorldInverse);
    this.clipPlane.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const e = rc.projectionMatrix.elements;
    this.q.x = (Math.sign(this.clipPlane.x) + e[8]) / e[0];
    this.q.y = (Math.sign(this.clipPlane.y) + e[9]) / e[5];
    this.q.z = -1.0;
    this.q.w = (1.0 + e[10]) / e[14];
    this.clipPlane.multiplyScalar(2.0 / this.clipPlane.dot(this.q));
    e[2] = this.clipPlane.x;
    e[6] = this.clipPlane.y;
    e[10] = this.clipPlane.z + 1.0 - this.clipBias;
    e[14] = this.clipPlane.w;
    rc.projectionMatrixInverse.copy(rc.projectionMatrix).invert();

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    for (let i = 0; i < hide.length; i++) hide[i].visible = false;
    renderer.setRenderTarget(this.target);
    renderer.autoClear = true;
    renderer.state.buffers.depth.setMask(true);
    renderer.render(scene, rc);
    for (let i = 0; i < hide.length; i++) hide[i].visible = true;

    // glossy blur: downsample + horizontal, then vertical (half resolution)
    const u = this.blurMat.uniforms;
    const bw = this.blurred.width;
    const bh = this.blurred.height;
    u.tSrc.value = this.target.texture;
    (u.uDir.value as Vector2).set(this.blurRadius / bw, 0);
    renderer.setRenderTarget(this.blurTmp);
    renderer.render(this.blurQuad, this.blurCam);
    u.tSrc.value = this.blurTmp.texture;
    (u.uDir.value as Vector2).set(0, this.blurRadius / bh);
    renderer.setRenderTarget(this.blurred);
    renderer.render(this.blurQuad, this.blurCam);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.target.dispose();
    this.blurred.dispose();
    this.blurTmp.dispose();
    this.blurQuad.geometry.dispose();
    this.blurMat.dispose();
  }
}
