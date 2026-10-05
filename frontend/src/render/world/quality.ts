/**
 * NOVABALL render-world — quality presets.
 *
 * One table drives every quality-dependent knob of the world renderer (post chain, shadows, reflections,
 * crowd density, sky resolution...). Actors (cars/ball/VFX) have their own presets.
 */
import type { QualityPreset } from '../../settings';

export interface WorldQuality {
  /** Upper bound for the renderer pixel ratio (also bounded by devicePixelRatio and settings.maxPixelRatio). */
  pixelRatioCap: number;
  /** Composer MSAA samples (0 = off). */
  msaa: number;
  /** SMAA when MSAA is off. */
  smaa: boolean;
  /** FXAA when MSAA and SMAA are off (LOW: SMAA's edge/weight passes cost ~1 ms on an iGPU, FXAA ~0.3 ms). */
  fxaa: boolean;
  /** SMAA preset (0 low .. 3 ultra). */
  smaaPreset: number;
  /** SMAA edge detection on luma (cheaper) instead of colour. */
  smaaLuma: boolean;
  /** SMAA edge threshold. The input is LINEAR HDR, so it must be well below the presets' gamma-space 0.1. */
  smaaThreshold: number;
  shadowMapSize: number;
  /** PCF kernel radius in shadow texels. */
  shadowRadius: number;
  /** Half extent (m) of the action-following directional shadow frustum. */
  shadowExtent: number;
  /** Planar floor reflection render-target scale relative to the drawing buffer (0 = reflection pass skipped). */
  reflectionScale: number;
  /** Mip levels for bloom's mipmap blur. */
  bloomLevels: number;
  /** Resolution scale of bloom's luminance (threshold) pass. */
  bloomLuminanceScale: number;
  /** Number of crowd light points. */
  crowdCount: number;
  /** Star-field density multiplier for the baked sky. */
  starDensity: number;
  /** Baked nebula cube face size. */
  skyCubeSize: number;
  /** Free-floating space dust motes. */
  dustCount: number;
  /** Volumetric floodlight beams. */
  beams: boolean;
  /** Max anisotropy for floor/emblem textures. */
  anisotropy: number;
  /**
   * Force-field shader detail: 2 = full, 1 = no sparkle / scan sweep, 0 = lines + seams + ripples + pools only,
   * -1 = no hex mesh (smooth energy sheet + seams + ripples + pools).
   */
  forceFieldDetail: -1 | 0 | 1 | 2;
  /** Floor without the hex micro-grooves / smudge variation (markings, pools, ripples and the mirror stay). */
  floorLite: boolean;
  /** Dynamic resolution never drops the EFFECTIVE (CSS-pixel based) pixel ratio below this. */
  dynResFloor: number;
}

export const WORLD_QUALITY: Record<QualityPreset, WorldQuality> = {
  low: {
    pixelRatioCap: 1.0,
    msaa: 0,
    smaa: false,
    fxaa: true,
    smaaPreset: 0,
    smaaLuma: true,
    smaaThreshold: 0.05,
    shadowMapSize: 1024,
    shadowRadius: 2,
    shadowExtent: 40,
    // a small, cheap planar reflection keeps the signature glossy floor (without it the lower half of the chase
    // view was a flat navy void: MeshPhong gets no specular IBL); it is blurred anyway
    reflectionScale: 0.2,
    bloomLevels: 4,
    bloomLuminanceScale: 0.25,
    crowdCount: 3500,
    starDensity: 0.75,
    skyCubeSize: 768,
    dustCount: 500,
    beams: false,
    anisotropy: 2,
    // smooth energy sheet (no hex mesh): the force field is ~1.1 ms of a ~5.5 ms LOW frame on the UHD 770
    forceFieldDetail: -1,
    floorLite: true,
    dynResFloor: 0.5,
  },
  medium: {
    pixelRatioCap: 1.25,
    msaa: 0,
    // FXAA: SMAA's edge + weight passes cost ~0.7-0.9 ms more on an iGPU (medium must be clearly cheaper than high)
    smaa: false,
    fxaa: true,
    smaaPreset: 0,
    smaaLuma: false,
    smaaThreshold: 0.05,
    shadowMapSize: 2048,
    shadowRadius: 2.5,
    shadowExtent: 42,
    reflectionScale: 0.25,
    bloomLevels: 6,
    bloomLuminanceScale: 0.5,
    crowdCount: 7000,
    starDensity: 0.9,
    skyCubeSize: 1024,
    dustCount: 900,
    beams: true,
    anisotropy: 4,
    forceFieldDetail: 1,
    floorLite: false,
    dynResFloor: 0.6,
  },
  high: {
    pixelRatioCap: 1.5,
    msaa: 0,
    smaa: true,
    fxaa: false,
    smaaPreset: 1,
    smaaLuma: false,
    // 0.05: +0.09 ms over the gamma-space default 0.1 on the UHD 770 (0.04: +0.13 ms), catches the dark edges
    smaaThreshold: 0.05,
    shadowMapSize: 2048,
    shadowRadius: 3,
    shadowExtent: 44,
    reflectionScale: 0.42,
    bloomLevels: 7,
    bloomLuminanceScale: 0.5,
    crowdCount: 11000,
    starDensity: 1,
    skyCubeSize: 1024,
    dustCount: 1400,
    beams: true,
    anisotropy: 8,
    forceFieldDetail: 2,
    floorLite: false,
    dynResFloor: 0.7,
  },
  ultra: {
    pixelRatioCap: 2,
    msaa: 4,
    smaa: false,
    fxaa: false,
    smaaPreset: 3,
    smaaLuma: false,
    smaaThreshold: 0.04,
    shadowMapSize: 4096,
    shadowRadius: 3,
    shadowExtent: 48,
    reflectionScale: 0.6,
    bloomLevels: 8,
    bloomLuminanceScale: 1,
    crowdCount: 16000,
    starDensity: 1.15,
    skyCubeSize: 1024,
    dustCount: 2200,
    beams: true,
    anisotropy: 16,
    forceFieldDetail: 2,
    floorLite: false,
    dynResFloor: 0.75,
  },
};
