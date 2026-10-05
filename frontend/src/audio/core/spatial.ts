/**
 * NOVABALL audio — listener-relative spatialization (manual stereo pan + distance model + air absorption + Doppler).
 *
 * The listener is the render camera (three.js convention: looks down local -Z, +X is screen-right).
 * Manual panning (StereoPannerNode) is cheaper and more controllable than PannerNode/HRTF and sounds right for a
 * third-person camera: sources get narrower as they approach the listener so near sounds stay solid in the center.
 */
import { Quaternion, Vector3 } from 'three';
import type { Vec3Like } from '../../sim/types';
import { clamp } from './util';

export interface SpatialResult {
  /** Linear distance gain 0..1 (inverse-distance model with a reference distance). */
  gain: number;
  /** -1..1 stereo position. */
  pan: number;
  /** Suggested low-pass cutoff (Hz) for air absorption / behind-the-listener darkening. */
  cutoff: number;
  /** Suggested reverb send 0..1 (farther = wetter). */
  send: number;
  dist: number;
  /** Listener-space position (x right, y up, z backward). */
  lx: number;
  ly: number;
  lz: number;
}

export function makeSpatial(): SpatialResult {
  return { gain: 1, pan: 0, cutoff: 20000, send: 0.1, dist: 0, lx: 0, ly: 0, lz: 0 };
}

export class Listener {
  readonly pos = new Vector3();
  /** Smoothed listener velocity (m/s), used for Doppler. */
  readonly vel = new Vector3();
  private readonly inv = new Quaternion();
  private readonly prev = new Vector3();
  private readonly tmp = new Vector3();
  private hasPrev = false;

  update(pos: Vector3, quat: Quaternion, dt: number): void {
    this.pos.copy(pos);
    this.inv.copy(quat).invert();
    if (this.hasPrev && dt > 1e-4) {
      const vx = (pos.x - this.prev.x) / dt;
      const vy = (pos.y - this.prev.y) / dt;
      const vz = (pos.z - this.prev.z) / dt;
      const sp2 = vx * vx + vy * vy + vz * vz;
      if (sp2 > 90 * 90) {
        // Camera cut (replay start, kickoff reset): no Doppler spike.
        this.vel.set(0, 0, 0);
      } else {
        const k = dt / (dt + 0.06);
        this.vel.x += (vx - this.vel.x) * k;
        this.vel.y += (vy - this.vel.y) * k;
        this.vel.z += (vz - this.vel.z) * k;
      }
    }
    this.prev.copy(pos);
    this.hasPrev = true;
  }

  /** Update the pose only (no velocity estimation) — for event handling before the first update(). */
  setPose(pos: Vector3, quat: Quaternion): void {
    this.pos.copy(pos);
    this.inv.copy(quat).invert();
  }

  /** Forget velocity history (after camera cuts). */
  resetMotion(): void {
    this.hasPrev = false;
    this.vel.set(0, 0, 0);
  }

  /**
   * Where is world point p for the listener? Writes into `out` (no allocation).
   * refDist: distance with gain 1. rolloff: inverse-distance rolloff factor.
   */
  locate(p: Vec3Like, out: SpatialResult, refDist = 6, rolloff = 1): SpatialResult {
    const v = this.tmp.set(p.x - this.pos.x, p.y - this.pos.y, p.z - this.pos.z).applyQuaternion(this.inv);
    const dist = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    out.lx = v.x;
    out.ly = v.y;
    out.lz = v.z;
    out.dist = dist;
    const d = dist > refDist ? dist : refDist;
    out.gain = refDist / (refDist + rolloff * (d - refDist));
    // Pan from azimuth, narrowed near the listener (a source 2 m away shouldn't be hard-panned).
    const horiz = Math.sqrt(v.x * v.x + v.z * v.z);
    const width = clamp((dist - 1.5) / 7, 0, 1) * 0.85;
    out.pan = horiz > 1e-3 ? clamp(v.x / horiz, -1, 1) * width : 0;
    // Air absorption (≈ 18 kHz at 0 m → ≈ 5 kHz at 100 m) and a darker tone for sources behind the camera.
    let cutoff = 18000 / (1 + dist * 0.027);
    if (v.z > 0) cutoff *= 1 - 0.45 * clamp(v.z / (horiz + 1e-3), 0, 1);
    out.cutoff = cutoff;
    out.send = clamp(0.12 + dist / 90, 0.12, 0.75);
    if (!Number.isFinite(dist) || !Number.isFinite(out.pan) || !Number.isFinite(cutoff)) {
      // Garbage positions (NaN / Infinity) → neutral, audible defaults instead of throwing in AudioParam setters.
      out.gain = 0.5;
      out.pan = 0;
      out.cutoff = 12000;
      out.send = 0.2;
      out.dist = refDist;
    }
    return out;
  }

  /**
   * Doppler pitch factor for a source at p moving with velocity v (world space).
   * `c` is an exaggerated "speed of sound" (game feel: cars max out at ~23 m/s).
   */
  doppler(p: Vec3Like, v: Vec3Like, c = 120): number {
    const dx = p.x - this.pos.x;
    const dy = p.y - this.pos.y;
    const dz = p.z - this.pos.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-3) return 1;
    const inv = 1 / d;
    // Positive = source and listener moving apart.
    const vs = (v.x * dx + v.y * dy + v.z * dz) * inv;
    const vl = (this.vel.x * dx + this.vel.y * dy + this.vel.z * dz) * inv;
    const f = (c + vl) / (c + vs);
    return Number.isFinite(f) ? clamp(f, 0.8, 1.25) : 1;
  }
}
