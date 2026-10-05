/**
 * NOVABALL render-world — post-processing (pmndrs postprocessing).
 *
 * EffectComposer (HalfFloat buffers, MSAA per quality) → RenderPass → ONE merged EffectPass:
 *   [SMAA or FXAA when MSAA is off] → NovaHDR (supersonic radial CA, speed lines, saturation, surge grade, flash, exposure)
 *   → mipmap Bloom (ADD) → ToneMapping (ACES filmic) → NovaLDR (pause, replay grain/letterbox, surge pulse)
 *   → Vignette → NovaOutput (linear → sRGB). Dithering on to kill banding in the dark gradients.
 *
 * Dynamic resolution: everything renders at the internal render size. At full size the EffectPass draws straight to
 * the canvas; below it, it renders into a buffer too and a final upscale pass (bilinear + light contrast-adaptive
 * sharpening) draws to the canvas, so the heavy merged pass never runs at more pixels than the scene. The renderer's
 * output colour space is LINEAR and NovaOutput encodes to sRGB itself: the EffectPass program is then identical
 * whether it targets the canvas or the buffer, so switching costs no shader compile.
 */
import {
  BlendFunction,
  BloomEffect,
  EdgeDetectionMode,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  RenderPass,
  ShaderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  type Effect,
} from 'postprocessing';
import { Color, HalfFloatType, ShaderMaterial, Vector2, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import type { FrameFx } from '../contracts';
import { NovaHDREffect, NovaLDREffect, NovaOutputEffect, UPSCALE_FRAG, UPSCALE_VERT } from './world/PostEffects';
import type { WorldQuality } from './world/quality';

export type ToneMapName = 'agx' | 'aces' | 'neutral';

export class PostFX {
  composer!: EffectComposer;
  private renderPass!: RenderPass;
  private effectPass!: EffectPass;
  private bloom!: BloomEffect;
  private smaa: SMAAEffect | null = null;
  private tone!: ToneMappingEffect;
  private vignette!: VignetteEffect;
  private output!: NovaOutputEffect;
  private upscalePass!: ShaderPass;
  private upscaleMat!: ShaderMaterial;
  hdr!: NovaHDREffect;
  ldr!: NovaLDREffect;
  private quality: WorldQuality;
  /** Internal render size (px). The canvas can be larger: the upscale pass fills it (dynamic resolution). */
  private renderW = 1;
  private renderH = 1;
  private outW = 1;
  private outH = 1;
  private scaled = false;
  /** Sharpening of the upscale at the current render scale (0 = off). */
  private sharpen = 0;
  /** ACES reads best for the dark/neon look (deeper blacks, punchier emissives); AgX/Neutral kept as options. */
  private toneMap: ToneMapName = 'aces';
  // animated state
  private flashAmt = 0;
  private readonly flashColor = new Color(1, 1, 1);
  private lines = 0;
  private ca = 0;
  private letterbox = 0;
  private grain = 0;
  private pause = 0;
  private surge = 0;
  /** Bloom tuning (exposed for dev tweaking). */
  bloomIntensity = 1.25;
  exposure = 1.0;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
    q: WorldQuality,
  ) {
    this.quality = q;
    this.build();
  }

  private build(): void {
    const q = this.quality;
    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: HalfFloatType,
      multisampling: q.msaa,
      stencilBuffer: false,
      depthBuffer: true,
    });
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloom = new BloomEffect({
      blendFunction: BlendFunction.ADD,
      mipmapBlur: true,
      luminanceThreshold: 0.9,
      luminanceSmoothing: 0.35,
      intensity: this.bloomIntensity,
      radius: 0.74,
      levels: q.bloomLevels,
    });
    this.bloom.luminancePass.resolution.scale = q.bloomLuminanceScale;
    sanitizeBloomInput(this.bloom);
    this.tone = new ToneMappingEffect({ mode: this.toneModeValue() });
    this.hdr = new NovaHDREffect();
    this.ldr = new NovaLDREffect();
    this.vignette = new VignetteEffect({ offset: 0.3, darkness: 0.62 });
    this.output = new NovaOutputEffect();
    const effects: Effect[] = [];
    this.smaa = null;
    if (q.msaa === 0 && q.smaa) {
      this.smaa = new SMAAEffect({ preset: q.smaaPreset, edgeDetectionMode: q.smaaLuma ? EdgeDetectionMode.LUMA : EdgeDetectionMode.COLOR });
      // The input is LINEAR HDR: the presets' 0.1 threshold (meant for gamma-space LDR) missed ~40% of the dark and
      // mid-tone edges (car silhouettes against the dark floor / stands).
      this.smaa.edgeDetectionMaterial.edgeDetectionThreshold = q.smaaThreshold;
      effects.push(this.smaa);
    } else if (q.msaa === 0 && q.fxaa) {
      effects.push(new FXAAEffect());
    }
    effects.push(this.hdr, this.bloom, this.tone, this.ldr, this.vignette, this.output);
    this.effectPass = new EffectPass(this.camera, ...effects);
    this.effectPass.dithering = true;
    this.upscaleMat = new ShaderMaterial({
      name: 'NovaUpscale',
      uniforms: { inputBuffer: { value: null }, uTexel: { value: new Vector2(1, 1) }, uSharp: { value: 0 } },
      vertexShader: UPSCALE_VERT,
      fragmentShader: UPSCALE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.upscalePass = new ShaderPass(this.upscaleMat, 'inputBuffer');
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.effectPass);
    this.composer.addPass(this.upscalePass);
    this.applyScaled();
  }

  /** Full size: the EffectPass draws to the canvas. Scaled: it fills a buffer and the upscale pass draws. */
  private applyScaled(): void {
    this.effectPass.renderToScreen = !this.scaled;
    this.upscalePass.enabled = this.scaled;
    this.upscalePass.renderToScreen = true;
    (this.upscaleMat.uniforms.uSharp as { value: number }).value = this.scaled ? this.sharpen : 0;
  }

  private toneModeValue(): number {
    switch (this.toneMap) {
      case 'agx':
        return ToneMappingMode.AGX;
      case 'neutral':
        return ToneMappingMode.NEUTRAL;
      default:
        return ToneMappingMode.ACES_FILMIC;
    }
  }

  setToneMapping(t: ToneMapName): void {
    this.toneMap = t;
    this.tone.mode = this.toneModeValue();
  }

  /** Rebuilds the chain when the AA mode changes; otherwise updates in place. */
  setQuality(q: WorldQuality): void {
    const prev = this.quality;
    this.quality = q;
    const smaaOn = (x: WorldQuality) => x.msaa === 0 && x.smaa;
    const fxaaOn = (x: WorldQuality) => x.msaa === 0 && !x.smaa && x.fxaa;
    const aaChanged =
      smaaOn(prev) !== smaaOn(q) || fxaaOn(prev) !== fxaaOn(q) || prev.smaaPreset !== q.smaaPreset || prev.smaaLuma !== q.smaaLuma;
    if (aaChanged) {
      this.composer.dispose();
      this.upscaleMat.dispose();
      this.build();
      this.setRenderSize(this.renderW, this.renderH, this.outW, this.outH);
      return;
    }
    if (this.smaa) this.smaa.edgeDetectionMaterial.edgeDetectionThreshold = q.smaaThreshold;
    this.composer.multisampling = q.msaa;
    this.bloom.mipmapBlurPass.levels = q.bloomLevels;
    this.bloom.luminancePass.resolution.scale = q.bloomLuminanceScale;
    this.setRenderSize(this.renderW, this.renderH, this.outW, this.outH);
  }

  /**
   * Size of the internal (HDR) render: composer buffers + every pass (SMAA / bloom targets, effect resolution).
   * This is EffectComposer.setSize WITHOUT renderer.setSize: the canvas keeps its size and the final EffectPass
   * draws to it with a bilinear upscale, so a dynamic-resolution step costs ~1 ms instead of a 50-100 ms canvas
   * reallocation.
   */
  setRenderSize(w: number, h: number, outW = w, outH = h): void {
    const c = this.composer;
    this.outW = outW;
    this.outH = outH;
    this.renderW = Math.max(1, Math.round(w));
    this.renderH = Math.max(1, Math.round(h));
    c.inputBuffer.setSize(this.renderW, this.renderH);
    c.outputBuffer.setSize(this.renderW, this.renderH);
    const depth = (c as unknown as { depthRenderTarget: { setSize(w: number, h: number): void } | null }).depthRenderTarget;
    if (depth) depth.setSize(this.renderW, this.renderH);
    for (const pass of c.passes) pass.setSize(this.renderW, this.renderH);
    (this.upscaleMat.uniforms.uTexel.value as Vector2).set(1 / this.renderW, 1 / this.renderH);
    // light contrast-adaptive sharpening once the upscale gets noticeable (holo text, field lines, car edges)
    const k = Math.min(this.renderW / Math.max(1, outW), this.renderH / Math.max(1, outH));
    this.sharpen = k < 0.95 ? Math.min(0.45, (0.95 - k) * 1.3) : 0;
    this.scaled = this.renderW < outW || this.renderH < outH;
    this.applyScaled();
  }

  flash(color: string, strength: number): void {
    const s = Math.max(0, Math.min(1, strength));
    if (s >= this.flashAmt * 0.6) this.flashColor.set(color);
    this.flashAmt = Math.max(this.flashAmt, s);
  }

  update(dt: number, time: number, fx: FrameFx): void {
    const k = expK;
    k.dt = dt;
    // chromatic aberration is a SUPERSONIC-only cue (boosting at 70-80 km/h stays crisp); capped so the corner
    // fringe stays <= ~4 px at 1600 px (offset = dc * uCA * (0.35 + 2.4 |dc|^2) => 0.0028 * 1.55 * 0.5 uv)
    const caT = fx.supersonic ? 0.001 + smooth01((fx.speed01 - 0.9) / 0.1) * 0.0018 : 0;
    this.ca += (caT - this.ca) * k.f(caT > this.ca ? 6 : 10);
    if (caT === 0 && this.ca < 0.0002) this.ca = 0;
    const linesT = fx.supersonic ? 1 : 0;
    this.lines += (linesT - this.lines) * k.f(fx.supersonic ? 5 : 3);
    this.letterbox += ((fx.replay ? 1 : 0) - this.letterbox) * k.f(5);
    this.grain += ((fx.replay ? 1 : 0) - this.grain) * k.f(5);
    this.pause += ((fx.paused ? 1 : 0) - this.pause) * k.f(8);
    this.surge += (fx.surge - this.surge) * k.f(4);
    this.flashAmt *= Math.exp(-dt * 5.5);
    if (this.flashAmt < 0.002) this.flashAmt = 0;

    const h = this.hdr;
    h.u('uCA').value = fx.paused ? 0 : this.ca;
    h.u('uLines').value = fx.paused ? 0 : this.lines;
    h.u('uSurge').value = this.surge * 0.85;
    (h.u('uFlashColor').value as Color).copy(this.flashColor);
    h.u('uFlash').value = this.flashAmt;
    h.u('uExposure').value = this.exposure;
    h.u('uTime').value = time;
    const l = this.ldr;
    l.u('uPause').value = this.pause;
    l.u('uGrain').value = this.grain;
    l.u('uLetterbox').value = this.letterbox < 0.002 ? 0 : this.letterbox;
    l.u('uPulse').value = this.surge * (0.55 + 0.45 * Math.sin(time * 4.2)) * 0.6;
    l.u('uTime').value = time;
    this.bloom.intensity = this.bloomIntensity * (1 + this.surge * 0.25 + this.flashAmt * 0.6);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.upscaleMat.dispose();
  }
}

/**
 * One NaN/Inf pixel (from any material, e.g. pow() of a negative base) would be smeared over the whole screen by
 * the bloom mip chain. Sanitize (and clamp fireflies) at the bloom's threshold pass input.
 */
function sanitizeBloomInput(bloom: BloomEffect): void {
  const mat = bloom.luminanceMaterial;
  const needle = 'vec4 texel=texture2D(inputBuffer,vUv);';
  if (mat.fragmentShader.includes(needle)) {
    mat.fragmentShader = mat.fragmentShader.replace(
      needle,
      needle + 'if(any(isnan(texel.rgb))||any(isinf(texel.rgb))||!(texel.r<=1e4&&texel.g<=1e4&&texel.b<=1e4)){texel=vec4(0.0);}texel.rgb=min(texel.rgb,vec3(48.0));',
    );
    mat.needsUpdate = true;
  } else {
    console.warn('[PostFX] bloom NaN guard not applied (postprocessing shader changed)');
  }
}

const expK = {
  dt: 0,
  f(rate: number): number {
    return 1 - Math.exp(-this.dt * rate);
  },
};

function smooth01(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
