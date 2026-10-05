/**
 * NOVABALL AI — measured travel-time lookup (quadrilinear interpolation over the generated table).
 */
import { TT_A, TT_B, TT_D, TT_V } from './travelGrid';
import { TT_DATA } from './travelTable';

const NV = TT_V.length;
const NA = TT_A.length;
const ND = TT_D.length;
const A_STEP = TT_A[1] - TT_A[0];
export const TT_MAX_D = TT_D[ND - 1];

/**
 * [index, fraction] of the last locate(): a typed array, so storing doubles never allocates (a module-level `let`
 * holding a double is a context slot — every store boxes a new HeapNumber).
 */
const LOC = new Float64Array(2);
function locate(axis: ReadonlyArray<number>, x: number): void {
  const n = axis.length;
  if (x <= axis[0]) {
    LOC[0] = 0;
    LOC[1] = 0;
    return;
  }
  if (x >= axis[n - 1]) {
    LOC[0] = n - 2;
    LOC[1] = 1;
    return;
  }
  let i = 0;
  while (i < n - 2 && x > axis[i + 1]) i++;
  LOC[0] = i;
  LOC[1] = (x - axis[i]) / (axis[i + 1] - axis[i]);
}

function at(b: number, v: number, a: number, d: number): number {
  return TT_DATA[((b * NV + v) * NA + a) * ND + d];
}

/** Interpolate over distance at fixed (b, v, a) indices. */
function overD(b: number, v: number, a: number, di: number, df: number): number {
  const t0 = at(b, v, a, di);
  return t0 + (at(b, v, a, di + 1) - t0) * df;
}

/**
 * Measured time (s) for the bots' Driver to bring the car center within reach of a ground target `d` metres away
 * (d ≤ TT_MAX_D), `angRad` off the nose, starting at forward speed `v0` with `boost` in the tank.
 */
export function tableTravelTime(v0: number, angRad: number, d: number, boost: number): number {
  locate(TT_B, boost);
  const bi = LOC[0];
  const bf = LOC[1];
  locate(TT_V, v0);
  const vi = LOC[0];
  const vf = LOC[1];
  let aDeg = (angRad * 180) / Math.PI;
  if (aDeg < 0) aDeg = -aDeg;
  if (aDeg > 180) aDeg = 180;
  let ai = Math.floor(aDeg / A_STEP);
  if (ai > NA - 2) ai = NA - 2;
  const af = (aDeg - ai * A_STEP) / A_STEP;
  locate(TT_D, d);
  const di = LOC[0];
  const df = LOC[1];
  let acc = 0;
  for (let bb = 0; bb < 2; bb++) {
    const wb = bb === 0 ? 1 - bf : bf;
    if (wb === 0) continue;
    for (let vv = 0; vv < 2; vv++) {
      const wv = vv === 0 ? 1 - vf : vf;
      if (wv === 0) continue;
      const a0 = overD(bi + bb, vi + vv, ai, di, df);
      const a1 = overD(bi + bb, vi + vv, ai + 1, di, df);
      acc += wb * wv * (a0 + (a1 - a0) * af);
    }
  }
  return acc;
}
