/**
 * NOVABALL render-world — RenderSystem (implements IRenderSystem).
 *
 * Owns the WebGL2 renderer, scene, camera, Environment (sky/planet/IBL/lights), ArenaView, CameraRig and PostFX.
 * Per frame: environment follow + shadow focus → planar floor reflection → composer (post chain) → dynamic
 * resolution bookkeeping.
 *
 * Resolution model:
 *  - the CANVAS pixel ratio (min(devicePixelRatio, settings.maxPixelRatio, preset cap)) only changes on init, window
 *    resize, devicePixelRatio change or a settings / quality change — reallocating the drawing buffer stalls the
 *    main thread for 50-100 ms (175-275 ms under load);
 *  - dynamic resolution is an INTERNAL render scale: the composer buffers, passes and the reflection targets render
 *    at canvas × scale and the final post pass upscales to the canvas (a scale step costs ~1 ms).
 *  - RenderStats.pixelRatio reports the EFFECTIVE ratio (canvas ratio × render scale).
 */
import {
  LinearSRGBColorSpace,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { LAYER_MAIN_ONLY, type FrameFx, type IRenderSystem, type RenderStats } from '../contracts';
import type { QualityPreset, Settings } from '../settings';
import { ArenaView } from './ArenaView';
import { CameraRig } from './CameraRig';
import { clampToArena, Environment } from './Environment';
import { gameplayVerticalFov } from './fov';
import { PostFX, type ToneMapName } from './PostFX';
import { ensureDisplayFont } from './world/Floor';
import { WORLD_QUALITY, type WorldQuality } from './world/quality';

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Dynamic-resolution decision interval (ms). */
const DYN_INTERVAL = 1500;
/** No dynamic-resolution decision for this long after init / a long frame gap / a size change (ms). */
const DYN_GRACE = 1000;
/** A frame gap longer than this (tab hidden, match start, pause) restarts the dynamic-resolution measurements. */
const DYN_GAP_RESET = 250;
/** Without GPU timers the effective pixel ratio never drops below this (the FPS alone can't tell what helps). */
const DYN_NO_TIMER_FLOOR = 0.75;
const DYN_STORE_KEY = 'novaball.dynres.v1';

export class RenderSystem implements IRenderSystem {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly arena: ArenaView;
  readonly cameraRig: CameraRig;
  readonly environment: Environment;
  readonly post: PostFX;
  /** Called when the WebGL context is lost (the canvas goes blank until it is restored). Wired by the game. */
  onContextLost?: () => void;
  /** Called once the context is restored and every baked resource was rebuilt (`ok` = false if that failed). */
  onContextRestored?: (ok: boolean) => void;
  /** init() step durations (ms), for load profiling. */
  initTimings: Record<string, number> = {};

  private settings: Settings;
  private qualityName: QualityPreset;
  private quality: WorldQuality;
  private readonly canvas: HTMLCanvasElement;
  private cssW = 1;
  private cssH = 1;
  /** Canvas (drawing buffer) pixel ratio. */
  private canvasPr = 1;
  /** Internal render scale (dynamic resolution), relative to the canvas. */
  private renderScale = 1;
  /** Effective pixel ratio = canvasPr × renderScale (what the scene is really rendered at). */
  private pixelRatio = 1;
  private renderW = 1;
  private renderH = 1;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = () => this.resize();
  private dprQuery: MediaQueryList | null = null;
  /** devicePixelRatio the canvas was sized for (checked every frame: display moves / browser zoom). */
  private lastDpr = 1;
  private readonly onDprChange = () => {
    this.watchDevicePixelRatio();
    this.updateCanvasPixelRatio();
  };
  private initialized = false;
  private disposed = false;
  private contextLost = false;
  private readonly onGlContextLost = (e: Event) => {
    e.preventDefault(); // allow the browser to restore it
    this.contextLost = true;
    // queries belong to the dead context: drop them (using them after the restore spammed GL warnings)
    this.queryPool.length = 0;
    this.pendingQueries.length = 0;
    this.timerExt = null;
    try {
      this.onContextLost?.();
    } catch (err) {
      console.warn('[RenderSystem] onContextLost handler failed', err);
    }
  };
  private readonly onGlContextRestored = () => void this.restoreContext();

  // stats
  private lastFrameAt = 0;
  private frameMsEma = 16.7;
  private fpsWindowStart = 0;
  private fpsFrames = 0;
  private fps = 60;
  private readonly statsOut: RenderStats = { fps: 60, frameMs: 16.7, drawCalls: 0, triangles: 0, pixelRatio: 1, quality: 'high' };
  // GPU timing
  private gl: WebGL2RenderingContext;
  private timerExt: TimerExt | null = null;
  private readonly queryPool: WebGLQuery[] = [];
  private readonly pendingQueries: WebGLQuery[] = [];
  private gpuMsEma = 0;
  private gpuMsLast = 0;
  private cpuMsEma = 0;
  /** Display refresh interval (ms), measured at boot and refined while running. */
  private refreshMs = 1000 / 60;
  // dynamic resolution (see updateDynamicResolution)
  private dynGraceEnd = 0;
  private dynNextAt = 0;
  private dynWinStart = 0;
  private dynFrames = 0;
  private dynGpuAcc = 0;
  private dynGpuN = 0;
  private dynBad = 0;
  private dynGood = 0;
  /** -1: evaluating a downscale, +1: evaluating an upscale. */
  private dynProbe: -1 | 0 | 1 = 0;
  private dynProbeFrom = 1;
  private dynProbeFps = 0;
  private dynDownBlockedUntil = 0;
  private dynDownBackoff = 0;
  private dynUpBlockedUntil = 0;
  private dynUpBackoff = 0;
  private dynLastChangeAt = 0;
  private dynSaved = true;
  private overheadMs = 0;
  /** Recent scale changes [time ms, effective pixel ratio, reason] (dev / harness introspection). */
  readonly dynLog: Array<[number, number, string]> = [];
  // misc
  private readonly focus = new Vector3();
  private readonly tmpV = new Vector3();
  private readonly tmpV2 = new Vector2();

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.canvas = canvas;
    this.settings = { ...settings };
    this.qualityName = settings.quality;
    this.quality = WORLD_QUALITY[settings.quality] ?? WORLD_QUALITY.high;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    // LINEAR on purpose: the post chain's last effect (NovaOutputEffect) encodes to sRGB itself, so the final pass is
    // the same program whether it draws to the canvas or into the dynamic-resolution upscale buffer (no compile
    // hitch on the first downscale). Nothing else renders to the canvas.
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(0x000000, 1);
    this.gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.timerExt = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;

    this.camera = new PerspectiveCamera(70, 16 / 9, 0.1, 4000);
    this.camera.layers.enable(0);
    this.camera.layers.enable(LAYER_MAIN_ONLY);
    this.camera.position.set(0, 12, -40);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.camera);

    this.environment = new Environment(this.quality);
    this.scene.add(this.environment.group);
    this.arena = new ArenaView(this.quality);
    this.arena.setSkyMesh(this.environment.sky.mesh);
    this.scene.add(this.arena.object);
    this.cameraRig = new CameraRig(this.camera, this.settings);
    this.post = new PostFX(this.renderer, this.scene, this.camera, this.quality);

    this.readCanvasSize();
    this.canvasPr = this.computeCanvasPixelRatio();
    this.renderScale = this.settings.dynamicResolution ? this.loadStoredScale() : 1;
    this.applyCanvasSize();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    window.addEventListener('resize', this.onWindowResize);
    this.watchDevicePixelRatio();
    // (three.js registers its own handlers first: it re-initialises its GL state before ours rebuilds the bakes)
    canvas.addEventListener('webglcontextlost', this.onGlContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onGlContextRestored, false);
  }

  // ------------------------------------------------------------------------------------------------ lifecycle

  async init(onProgress?: (p: number, label: string) => void): Promise<void> {
    const report = (p: number, l: string) => onProgress?.(p, l);
    const t0 = performance.now();
    let tLap = t0;
    const timings: Record<string, number> = {};
    const lap = (name: string) => {
      const now = performance.now();
      timings[name] = Math.round(now - tLap);
      tLap = now;
    };
    this.startRefreshProbe();
    // Each heavy step is followed by a real paint (rAF + task), so the loading bar visibly advances between them.
    report(0.02, 'Igniting the stars');
    await yieldToPaint();
    this.environment.prepare(this.renderer);
    this.environment.bakeSky(this.renderer, this.scene);
    lap('sky');
    report(0.18, 'Painting the nebula');
    await yieldToPaint();
    this.environment.bakeEnvMap(this.renderer, this.scene);
    lap('envMap');
    report(0.3, 'Lighting the stadium');
    await yieldToPaint();
    this.environment.bakePlanet(this.renderer);
    lap('planet');
    report(0.4, 'Charging the force field');
    await yieldToPaint();
    await ensureDisplayFont();
    this.arena.refreshCanvases();
    lap('fonts');
    report(0.5, 'Filling the stands');
    await yieldToPaint();
    report(0.6, 'Compiling shaders');
    await yieldToPaint();
    await this.precompile((f) => report(0.6 + 0.33 * f, 'Compiling shaders'));
    lap('compile');
    report(0.95, 'Warming up');
    await yieldToPaint();
    // warm-up frames: shadow + reflection + post materials get compiled/uploaded now, not mid-match. One of them runs
    // at a reduced render scale so the dynamic-resolution upscale pass is compiled too.
    this.renderFrame(1 / 60, 0);
    await yieldToPaint();
    const s0 = this.renderScale;
    if (s0 >= 0.999) {
      this.renderScale = 0.9;
      this.applyRenderScale();
    }
    this.renderFrame(1 / 60, 0);
    if (this.renderScale !== s0) {
      this.renderScale = s0;
      this.applyRenderScale();
    }
    lap('warmup');
    timings.total = Math.round(performance.now() - t0);
    this.initTimings = timings;
    this.initialized = true;
    // the loading / warm-up frames must not drive the first dynamic-resolution decision
    this.resetDynamicResolution(performance.now());
    report(1, 'Ready');
  }

  /**
   * Pre-compile every material currently in the scene (call again after adding actors, e.g. cars/ball/VFX,
   * so their programs are ready before the first rendered frame).
   */
  async precompile(onProgress?: (fraction: number) => void): Promise<void> {
    // Programs depend on the bound render target (output color space): compile against the composer's HDR input
    // buffer — the target the scene is really rendered into — or every material gets compiled a second time on
    // first use. compileAsync() runs compile() synchronously, so the target is only bound for that call.
    const r = this.renderer;
    const prev = r.getRenderTarget();
    let pending: Promise<unknown> | null = null;
    r.setRenderTarget(this.post.composer.inputBuffer);
    try {
      pending = r.compileAsync(this.scene, this.camera);
    } catch {
      r.compile(this.scene, this.camera);
    } finally {
      r.setRenderTarget(prev);
    }
    if (pending) {
      // report the share of programs whose (parallel) link has finished while waiting
      let done = false;
      const poll = () => {
        if (done || !onProgress) return;
        const progs = r.info.programs;
        if (progs && progs.length > 0) {
          let ready = 0;
          for (const p of progs) {
            try {
              // (three's WebGLProgram.isReady() polls KHR_parallel_shader_compile; missing from the typings)
              if ((p as unknown as { isReady(): boolean }).isReady()) ready++;
            } catch {
              ready++;
            }
          }
          onProgress(ready / progs.length);
        }
        setTimeout(poll, 100);
      };
      poll();
      await pending.catch(() => undefined);
      done = true;
    }
    onProgress?.(1);
    // Finish every program's lazy "first use" now (link check + uniform/attribute lookup): otherwise it happens on
    // the first draw of each material — e.g. objects that were culled during the warm-up — as a mid-game hitch.
    const programs = r.info.programs;
    if (programs) {
      for (const p of programs) {
        try {
          p.getUniforms();
        } catch {
          /* ignore */
        }
      }
    }
  }

  setQuality(q: QualityPreset): void {
    const wq = WORLD_QUALITY[q];
    if (!wq) return;
    this.qualityName = q;
    this.quality = wq;
    this.settings.quality = q;
    this.environment.setQuality(this.renderer, this.scene, wq);
    this.arena.setQuality(wq);
    this.post.setQuality(wq);
    this.canvasPr = this.computeCanvasPixelRatio();
    if (this.settings.dynamicResolution) this.renderScale = Math.max(this.renderScale, this.minRenderScale());
    else this.renderScale = 1;
    this.applyCanvasSize();
    this.resetDynamicResolution(performance.now(), true);
  }

  applySettings(s: Settings): void {
    const qualityChanged = s.quality !== this.qualityName;
    const fovChanged = s.fov !== this.settings.fov;
    const dynChanged = s.dynamicResolution !== this.settings.dynamicResolution;
    this.settings = { ...s };
    this.cameraRig.applySettings(s);
    if (qualityChanged) {
      this.setQuality(s.quality);
      return;
    }
    const pr = this.computeCanvasPixelRatio();
    if (pr !== this.canvasPr || dynChanged || fovChanged || (!s.dynamicResolution && this.renderScale !== 1)) {
      this.canvasPr = pr;
      this.renderScale = s.dynamicResolution ? Math.max(this.renderScale, this.minRenderScale()) : 1;
      this.applyCanvasSize();
      this.resetDynamicResolution(performance.now(), true);
    }
  }

  resize(): void {
    if (this.disposed) return;
    const w0 = this.cssW;
    const h0 = this.cssH;
    this.readCanvasSize();
    if (w0 !== this.cssW || h0 !== this.cssH) {
      this.applyCanvasSize();
      this.resetDynamicResolution(performance.now(), true);
    }
  }

  flash(color: string, strength: number): void {
    this.post.flash(color, strength);
  }

  render(dt: number, time: number, fx: FrameFx): void {
    if (this.disposed) return;
    this.renderFrame(dt, time, fx);
  }

  getStats(): RenderStats {
    const s = this.statsOut;
    s.fps = Math.round(this.fps * 10) / 10;
    s.frameMs = Math.round(this.frameMsEma * 100) / 100;
    s.pixelRatio = Math.round(this.pixelRatio * 100) / 100;
    s.quality = this.qualityName;
    return s;
  }

  /** Extra dev stats (GPU time, render / canvas sizes, dynamic-resolution state). */
  getDebugStats(): {
    gpuMs: number;
    gpuMsLast: number;
    cpuMs: number;
    overheadMs: number;
    timer: boolean;
    drawW: number;
    drawH: number;
    canvasW: number;
    canvasH: number;
    canvasPr: number;
    renderScale: number;
    refreshHz: number;
    reflW: number;
    reflH: number;
    contextLost: boolean;
  } {
    const r = this.arena.reflection.size;
    return {
      overheadMs: Math.round(this.overheadMs * 100) / 100,
      gpuMs: Math.round(this.gpuMsEma * 100) / 100,
      cpuMs: Math.round(this.cpuMsEma * 100) / 100,
      gpuMsLast: Math.round(this.gpuMsLast * 100) / 100,
      timer: !!this.timerExt,
      drawW: this.renderW,
      drawH: this.renderH,
      canvasW: this.canvas.width,
      canvasH: this.canvas.height,
      canvasPr: this.canvasPr,
      renderScale: Math.round(this.renderScale * 1000) / 1000,
      refreshHz: Math.round((1000 / this.refreshMs) * 10) / 10,
      reflW: this.arena.reflectionEnabled ? r.width : 0,
      reflH: this.arena.reflectionEnabled ? r.height : 0,
      contextLost: this.contextLost,
    };
  }

  setToneMapping(t: ToneMapName): void {
    this.post.setToneMapping(t);
  }

  /** Add an object to the scene (convenience for the integration layer). */
  add(o: Object3D): void {
    this.scene.add(o);
  }

  /**
   * Set the internal render scale directly (dev / test harnesses; the dynamic-resolution controller keeps running
   * when it is enabled). Clamped to [preset floor, 1]; returns the effective pixel ratio.
   */
  setRenderScale(scale: number, reason = 'manual'): number {
    const s = Math.min(1, Math.max(this.minRenderScale(), scale));
    if (Math.abs(s - this.renderScale) > 1e-3) {
      this.renderScale = s;
      this.applyRenderScale();
      const now = performance.now();
      this.dynLastChangeAt = now;
      this.dynSaved = false;
      this.dynLog.push([Math.round(now), Math.round(this.pixelRatio * 100) / 100, reason]);
      if (this.dynLog.length > 200) this.dynLog.shift();
    }
    return this.pixelRatio;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.canvas.removeEventListener('webglcontextlost', this.onGlContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onGlContextRestored, false);
    if (!this.contextLost) {
      for (const q of this.queryPool) this.gl.deleteQuery(q);
      for (const q of this.pendingQueries) this.gl.deleteQuery(q);
    }
    this.queryPool.length = 0;
    this.pendingQueries.length = 0;
    this.post.dispose();
    this.arena.dispose();
    this.environment.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------------------------------------ internals

  private readonly defaultFx: FrameFx = { speed01: 0, boosting: false, supersonic: false, surge: 0, replay: false, paused: false };

  private renderFrame(dt: number, time: number, fx: FrameFx = this.defaultFx): void {
    const now = performance.now();
    this.trackFrame(now);
    // window moved to another display / browser zoom: the media-query listener doesn't fire everywhere (e.g. emulated
    // metrics), a property read per frame is free
    if (typeof window !== 'undefined' && (window.devicePixelRatio || 1) !== this.lastDpr) this.onDprChange();
    if (this.contextLost) return; // nothing can be drawn; three.js would no-op every call anyway
    const renderer = this.renderer;
    renderer.info.reset();
    this.pollGpuTimers();
    const query = this.beginGpuTimer();

    const cam = this.camera;
    cam.updateMatrixWorld();
    // shadow focus: a point on the floor ahead of the camera, biased toward the ball
    const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(cam.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, 1);
    fwd.normalize();
    this.focus.copy(cam.position).addScaledVector(fwd, this.quality.shadowExtent * 0.55);
    if (this.arena.ballVisible) this.focus.lerp(this.arena.ballPos, 0.35);
    clampToArena(this.focus);
    const pxScale = this.pointScale();
    this.environment.update(dt, time, cam, this.scene, fx.surge, this.focus, pxScale);
    this.arena.setPointScale(pxScale);
    this.post.update(dt, time, fx);

    renderer.shadowMap.needsUpdate = true;
    this.arena.renderReflection(renderer, this.scene, cam);
    this.post.render(dt);

    this.endGpuTimer(query);
    const cpu = performance.now() - now;
    this.cpuMsEma = this.cpuMsEma === 0 ? cpu : this.cpuMsEma + (cpu - this.cpuMsEma) * 0.08;
    this.statsOut.drawCalls = renderer.info.render.calls;
    this.statsOut.triangles = renderer.info.render.triangles;
    if (this.initialized) this.updateDynamicResolution(now);
  }

  private trackFrame(now: number): void {
    if (this.lastFrameAt > 0) {
      const gap = now - this.lastFrameAt;
      const ms = Math.min(250, gap);
      this.frameMsEma += (ms - this.frameMsEma) * 0.1;
      // tab hidden / paused / match start / hitch: those frames say nothing about the steady cost
      if (gap > DYN_GAP_RESET && this.initialized) this.resetDynamicResolution(now);
    }
    this.lastFrameAt = now;
    if (this.fpsWindowStart === 0) this.fpsWindowStart = now;
    this.fpsFrames++;
    const el = now - this.fpsWindowStart;
    if (el >= 500) {
      this.fps = (this.fpsFrames * 1000) / el;
      this.fpsFrames = 0;
      this.fpsWindowStart = now;
    }
    // dynamic-resolution window: frames after the grace period only
    if (now < this.dynGraceEnd) {
      this.dynWinStart = now;
      this.dynFrames = 0;
      this.dynGpuAcc = 0;
      this.dynGpuN = 0;
    } else this.dynFrames++;
  }

  private beginGpuTimer(): WebGLQuery | null {
    const ext = this.timerExt;
    if (!ext || this.contextLost) return null;
    let q = this.queryPool.pop() ?? null;
    if (!q) q = this.gl.createQuery();
    if (!q) return null;
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    return q;
  }

  private endGpuTimer(q: WebGLQuery | null): void {
    const ext = this.timerExt;
    if (!ext || !q || this.contextLost) return;
    this.gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.pendingQueries.push(q);
    if (this.pendingQueries.length > 8) {
      // results are not coming back (context issue) — recycle the oldest
      const old = this.pendingQueries.shift();
      if (old) this.queryPool.push(old);
    }
  }

  private pollGpuTimers(): void {
    const ext = this.timerExt;
    if (!ext || this.contextLost || this.pendingQueries.length === 0) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pendingQueries.length > 0) {
      const q = this.pendingQueries[0];
      const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (!available) break;
      this.pendingQueries.shift();
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        const ms = ns / 1e6;
        this.gpuMsLast = ms;
        this.gpuMsEma = this.gpuMsEma === 0 ? ms : this.gpuMsEma + (ms - this.gpuMsEma) * 0.08;
        if (performance.now() >= this.dynGraceEnd) {
          this.dynGpuAcc += ms;
          this.dynGpuN++;
        }
      }
      this.queryPool.push(q);
    }
  }

  // ------------------------------------------------------------------------------------------------ resolution

  /** Canvas pixel ratio: devicePixelRatio capped by the settings and the preset. */
  private computeCanvasPixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.lastDpr = dpr;
    return Math.max(0.5, Math.min(dpr, this.settings.maxPixelRatio, this.quality.pixelRatioCap));
  }

  /** Lowest internal render scale: the preset's floor on the EFFECTIVE pixel ratio (0.75 without GPU timers). */
  private minRenderScale(): number {
    let floor = this.quality.dynResFloor;
    if (!this.timerExt) floor = Math.max(floor, DYN_NO_TIMER_FLOOR);
    return Math.min(1, floor / this.canvasPr);
  }

  /** Re-read devicePixelRatio (window moved to another display / browser zoom). */
  private updateCanvasPixelRatio(): void {
    if (this.disposed) return;
    this.readCanvasSize();
    const pr = this.computeCanvasPixelRatio();
    if (pr === this.canvasPr) return;
    this.canvasPr = pr;
    if (this.settings.dynamicResolution) this.renderScale = Math.max(this.renderScale, this.minRenderScale());
    this.applyCanvasSize();
    this.resetDynamicResolution(performance.now(), true);
  }

  /** Watch for devicePixelRatio changes (re-armed after each change: the query is specific to one ratio). */
  private watchDevicePixelRatio(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = null;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    try {
      this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      this.dprQuery.addEventListener('change', this.onDprChange);
    } catch {
      this.dprQuery = null;
    }
  }

  private readCanvasSize(): void {
    const c = this.canvas;
    let w = c.clientWidth;
    let h = c.clientHeight;
    if (!w || !h) {
      w = typeof window !== 'undefined' ? window.innerWidth : 1280;
      h = typeof window !== 'undefined' ? window.innerHeight : 720;
    }
    this.cssW = Math.max(1, Math.floor(w));
    this.cssH = Math.max(1, Math.floor(h));
  }

  /** Canvas size / pixel ratio (reallocates the drawing buffer only when something really changed). */
  private applyCanvasSize(): void {
    const r = this.renderer;
    if (r.getPixelRatio() !== this.canvasPr) r.setPixelRatio(this.canvasPr);
    const size = r.getSize(this.tmpV2);
    if (size.x !== this.cssW || size.y !== this.cssH) r.setSize(this.cssW, this.cssH, false);
    this.camera.aspect = this.cssW / this.cssH;
    this.camera.fov = gameplayVerticalFov(this.settings.fov, this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.applyRenderScale();
  }

  /** Internal render size = drawing buffer × render scale: composer buffers / passes and the reflection targets. */
  private applyRenderScale(): void {
    const db = this.renderer.getDrawingBufferSize(this.tmpV2);
    const s = this.renderScale;
    this.renderW = s >= 0.999 ? db.x : Math.max(1, Math.round(db.x * s));
    this.renderH = s >= 0.999 ? db.y : Math.max(1, Math.round(db.y * s));
    this.pixelRatio = this.canvasPr * s;
    this.post.setRenderSize(this.renderW, this.renderH, db.x, db.y);
    this.arena.setSize(this.renderW, this.renderH, this.pointScale());
  }

  /** Pixels per meter at 1 m distance in the internal render target (point sprites). */
  private pointScale(): number {
    return this.renderH / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  // ------------------------------------------------------------------------------------------------ dynamic resolution

  /**
   * Measure the display refresh interval from ~90 rAF intervals while loading: rAF can't beat vsync, so a LOW
   * percentile is the refresh interval even when loading work stretches many frames. Only trusted when enough frames
   * agree AND it reads >= 50 Hz: a heavily loaded boot can stretch every frame, and a too-low target would stop
   * dynamic resolution from ever engaging. Real low caps (30 Hz power saving) are detected at runtime instead (an
   * unproductive downscale with the FPS pinned to a refresh divisor), and the runtime refinement raises it.
   */
  private startRefreshProbe(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    const ts: number[] = [];
    const step = (t: number) => {
      if (this.disposed) return;
      ts.push(t);
      if (ts.length < 90) {
        requestAnimationFrame(step);
        return;
      }
      const d: number[] = [];
      for (let i = 1; i < ts.length; i++) {
        const x = ts[i] - ts[i - 1];
        if (x > 2) d.push(x);
      }
      d.sort((a, b) => a - b);
      if (d.length < 20) return;
      const p = d[Math.floor(d.length * 0.1)];
      let agree = 0;
      for (const x of d) if (Math.abs(x - p) < p * 0.15) agree++;
      if (p > 3 && p <= 20 && agree >= d.length * 0.25) this.refreshMs = p;
    };
    requestAnimationFrame(step);
  }

  /**
   * Restart the measurements: after init, a long frame gap, a size or quality change. No decision for
   * DYN_GRACE + DYN_INTERVAL; a pending probe is kept at its current scale. `sizeChanged` also forgets the learned
   * overhead and the backoffs (they were learned for another pixel count / preset).
   */
  private resetDynamicResolution(now: number, sizeChanged = false): void {
    this.dynGraceEnd = now + DYN_GRACE;
    this.dynNextAt = this.dynGraceEnd + DYN_INTERVAL;
    this.dynWinStart = now;
    this.dynFrames = 0;
    this.dynGpuAcc = 0;
    this.dynGpuN = 0;
    this.dynBad = 0;
    this.dynGood = 0;
    this.dynProbe = 0;
    if (sizeChanged) {
      this.overheadMs = 0;
      this.dynDownBlockedUntil = 0;
      this.dynUpBlockedUntil = 0;
      this.dynDownBackoff = 0;
      this.dynUpBackoff = 0;
    }
  }

  /**
   * Dynamic resolution (internal render scale), one decision per DYN_INTERVAL measured over the whole interval:
   *  - target = min(settings.targetFps, display refresh) — a 120 fps target on a 60 Hz display must not chase
   *    an impossible frame rate;
   *  - DOWN after two consecutive intervals below 93 % of the target (or one below 75 %), only when the GPU is a
   *    real share of the frame (timers): strongly GPU-bound => jump straight to ~70 % of the budget, else a
   *    0.1 probe step. Every downscale must pay off in the next interval (FPS +4 % or back at target), otherwise it
   *    is reverted and further downscales back off exponentially (30 s .. 120 s) — this also detects external
   *    caps (browser power saving) that no resolution can beat;
   *  - UP after two intervals at target (four without timers) when the predicted GPU time + the learned invisible
   *    per-frame overhead fit; an upgrade that doesn't hold is reverted with exponential backoff (60 s .. 240 s);
   *  - floors on the EFFECTIVE pixel ratio per preset (0.75 without GPU timers); the settled scale is remembered
   *    per preset + canvas size.
   */
  private updateDynamicResolution(now: number): void {
    if (!this.settings.dynamicResolution || this.contextLost) return;
    if (now < this.dynNextAt) return;
    const el = now - this.dynWinStart;
    if (el < 1000 || this.dynFrames < 8) return;
    const fps = (this.dynFrames * 1000) / el;
    // GPU timers exist but too few results came back this interval (disjoint / lagging queries under contention):
    // then don't act on the FPS alone (the no-timer path) — wait for the next interval
    const timerOk = this.timerExt !== null;
    const haveGpu = timerOk && this.dynGpuN >= Math.min(8, Math.max(3, this.dynFrames * 0.5));
    const gpuAvg = haveGpu ? this.dynGpuAcc / this.dynGpuN : 0;
    this.dynWinStart = now;
    this.dynFrames = 0;
    this.dynGpuAcc = 0;
    this.dynGpuN = 0;
    this.dynNextAt = now + DYN_INTERVAL;

    // the boot probe can read a slow refresh under load: never believe a refresh rate below what we just achieved
    if (fps > (1000 / this.refreshMs) * 1.08) this.refreshMs = 1000 / fps;
    const target = Math.max(20, Math.min(this.settings.targetFps || 60, 1000 / this.refreshMs));
    const budget = 1000 / target;
    const frameMs = 1000 / Math.max(1, fps);
    const s = this.renderScale;
    const sMin = this.minRenderScale();
    // learn the per-frame cost GPU timers can't see (compositor / present / driver / CPU) while below target
    if (haveGpu && fps < target * 0.95) {
      const ovh = Math.max(0, frameMs - gpuAvg);
      this.overheadMs = this.overheadMs === 0 ? ovh : this.overheadMs + (ovh - this.overheadMs) * 0.5;
    } else {
      this.overheadMs *= 0.99; // slowly forget (the environment may improve)
    }

    // 1) judge the last change
    if (this.dynProbe === -1) {
      this.dynProbe = 0;
      // (without GPU timers the FPS is the only evidence: ask for a clearer gain, and space further probes out)
      if (fps >= this.dynProbeFps * (haveGpu ? 1.04 : 1.05) || fps >= target * 0.93) {
        // kept. (The backoff level stays: only a long stable period forgives it, so an overloaded machine whose FPS
        // wobbles doesn't cycle probe / keep / probe / revert.)
        if (!timerOk) this.dynDownBlockedUntil = now + 20000;
      } else {
        // didn't help: something else limits the frame rate (CPU, compositor, an external cap)
        this.setRenderScale(this.dynProbeFrom, 'revert-down');
        this.dynDownBackoff = Math.min(120000, Math.max(30000, this.dynDownBackoff * 2));
        this.dynDownBlockedUntil = now + this.dynDownBackoff;
        // FPS pinned to the refresh rate or a divisor of it across two scales = an external cap: make it the target
        const hz = 1000 / this.refreshMs;
        for (const n of [1, 2, 3, 4]) {
          if (Math.abs(fps - hz / n) < hz * 0.03 && Math.abs(this.dynProbeFps - hz / n) < hz * 0.03) {
            this.refreshMs = 1000 / fps;
            break;
          }
        }
      }
      return;
    }
    if (this.dynProbe === 1) {
      this.dynProbe = 0;
      if (fps < target * 0.93 && fps < this.dynProbeFps * 0.98) {
        this.setRenderScale(this.dynProbeFrom, 'revert-up');
        this.dynUpBackoff = Math.min(240000, Math.max(60000, this.dynUpBackoff * 2));
        this.dynUpBlockedUntil = now + this.dynUpBackoff;
      }
      return;
    }

    // 2) steady state
    this.dynBad = fps < target * 0.93 ? this.dynBad + 1 : 0;
    this.dynGood = fps >= target * 0.97 ? this.dynGood + 1 : 0;
    if ((this.dynBad >= 2 || fps < target * 0.75) && s > sMin + 1e-3 && now >= this.dynDownBlockedUntil && (haveGpu || !timerOk)) {
      // with timers: only when the GPU is a real share of the frame (else resolution can't be the problem)
      if (!haveGpu || gpuAvg > 0.35 * frameMs) {
        let next = haveGpu && gpuAvg > 0.6 * frameMs ? s * Math.sqrt((0.7 * budget) / gpuAvg) : s - 0.1;
        next = Math.max(sMin, Math.min(s - 0.05, Math.floor(next * 20 + 1e-6) / 20));
        this.dynProbe = -1;
        this.dynProbeFrom = s;
        this.dynProbeFps = fps;
        this.dynBad = 0;
        this.setRenderScale(next, 'down');
        return;
      }
    }
    if (this.dynGood >= (haveGpu ? 2 : 4) && s < 1 - 1e-3 && now >= this.dynUpBlockedUntil && (haveGpu || !timerOk)) {
      const next = Math.min(1, Math.round((s + 0.1) * 20) / 20);
      const k = (next * next) / (s * s);
      if (!haveGpu || (gpuAvg * k < budget * 0.75 && gpuAvg * k + this.overheadMs < budget * 0.95)) {
        this.dynProbe = 1;
        this.dynProbeFrom = s;
        this.dynProbeFps = fps;
        this.dynGood = 0;
        this.setRenderScale(next, 'up');
        return;
      }
    }
    // settled for a while: remember it; long-stable => forgive the backoffs
    if (!this.dynSaved && now - this.dynLastChangeAt > 15000) this.storeScale();
    if (now - this.dynLastChangeAt > 180000) {
      this.dynUpBackoff = 0;
      this.dynDownBackoff = 0;
    }
  }

  private storeKey(): string {
    return `${this.qualityName}|${this.cssW}x${this.cssH}@${this.canvasPr}`;
  }

  private loadStoredScale(): number {
    try {
      const raw = globalThis.localStorage?.getItem(DYN_STORE_KEY);
      if (!raw) return 1;
      const v = (JSON.parse(raw) as Record<string, number>)[this.storeKey()];
      if (typeof v === 'number' && Number.isFinite(v)) return Math.min(1, Math.max(this.minRenderScale(), v));
    } catch {
      /* storage unavailable */
    }
    return 1;
  }

  private storeScale(): void {
    this.dynSaved = true;
    try {
      const raw = globalThis.localStorage?.getItem(DYN_STORE_KEY);
      const all = (raw ? JSON.parse(raw) : {}) as Record<string, number>;
      all[this.storeKey()] = Math.round(this.renderScale * 1000) / 1000;
      globalThis.localStorage?.setItem(DYN_STORE_KEY, JSON.stringify(all));
    } catch {
      /* storage unavailable / full: just don't remember */
    }
  }

  // ------------------------------------------------------------------------------------------------ context loss

  /** Rebuild everything whose GPU contents were lost with the context (baked sky/env/planet, programs, timers). */
  private async restoreContext(): Promise<void> {
    if (this.disposed) return;
    let ok = true;
    try {
      this.contextLost = false;
      this.queryPool.length = 0;
      this.pendingQueries.length = 0;
      this.timerExt = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
      this.environment.rebuildAfterContextLoss(this.renderer, this.scene);
      this.arena.refreshCanvases();
      await this.precompile();
    } catch (err) {
      ok = false;
      console.warn('[RenderSystem] context restore failed', err);
    }
    this.resetDynamicResolution(performance.now());
    try {
      this.onContextRestored?.(ok);
    } catch (err) {
      console.warn('[RenderSystem] onContextRestored handler failed', err);
    }
  }
}

/** Resolve after the browser has painted a frame (the rAF callback runs BEFORE the paint: continue in a task). */
function yieldToPaint(): Promise<void> {
  return new Promise((r) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(r, 0));
    else setTimeout(r, 16);
  });
}
