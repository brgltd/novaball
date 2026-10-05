/**
 * Geodesic "hex shell" geometry for the Nova Core ball.
 * Each triangle of a coarse icosphere is subdivided (for a round silhouette) while keeping the barycentric
 * coordinates of the COARSE triangle (aBary) and a random value per coarse vertex (aCell). In the fragment
 * shader, the dual cells (hexagons + 12 pentagons, like a football) are where one barycentric coordinate wins:
 * cell edges are where the two largest coordinates are equal.
 */
import { BufferAttribute, BufferGeometry, IcosahedronGeometry, Vector3 } from 'three';

export function buildHexShellGeometry(radius: number, detail = 2, sub = 4): BufferGeometry {
  const ico = new IcosahedronGeometry(1, detail);
  const P = ico.attributes.position;
  const coarseTris = P.count / 3;
  // unique coarse vertices -> random cell value
  const cellRand = new Map<string, number>();
  const key = (v: Vector3) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const vertsPerTri = ((sub + 1) * (sub + 2)) / 2;
  const trisPerCoarse = sub * sub;
  const pos = new Float32Array(coarseTris * vertsPerTri * 3);
  const nrm = new Float32Array(coarseTris * vertsPerTri * 3);
  const bary = new Float32Array(coarseTris * vertsPerTri * 3);
  const cell = new Float32Array(coarseTris * vertsPerTri * 3);
  const idx = new Uint16Array(coarseTris * trisPerCoarse * 3);
  const A = new Vector3();
  const B = new Vector3();
  const C = new Vector3();
  const p = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  let vo = 0;
  let io = 0;
  for (let t = 0; t < coarseTris; t++) {
    A.fromBufferAttribute(P, t * 3).normalize();
    B.fromBufferAttribute(P, t * 3 + 1).normalize();
    C.fromBufferAttribute(P, t * 3 + 2).normalize();
    const rv = [A, B, C].map((v) => {
      const k = key(v);
      let r = cellRand.get(k);
      if (r === undefined) {
        r = rnd();
        cellRand.set(k, r);
      }
      return r;
    });
    // outward winding check for the coarse triangle
    e1.subVectors(B, A);
    e2.subVectors(C, A);
    const flip = e1.cross(e2).dot(A) < 0;
    const base = vo;
    const vid = (i: number, j: number) => {
      // row i (0..sub), column j (0..sub-i)
      let o = 0;
      for (let r = 0; r < i; r++) o += sub + 1 - r;
      return base + o + j;
    };
    for (let i = 0; i <= sub; i++) {
      for (let j = 0; j <= sub - i; j++) {
        const ba = 1 - (i + j) / sub;
        const bb = i / sub;
        const bc = j / sub;
        p.set(0, 0, 0).addScaledVector(A, ba).addScaledVector(B, bb).addScaledVector(C, bc).normalize();
        const o = vo * 3;
        pos[o] = p.x * radius;
        pos[o + 1] = p.y * radius;
        pos[o + 2] = p.z * radius;
        nrm[o] = p.x;
        nrm[o + 1] = p.y;
        nrm[o + 2] = p.z;
        bary[o] = ba;
        bary[o + 1] = bb;
        bary[o + 2] = bc;
        cell[o] = rv[0];
        cell[o + 1] = rv[1];
        cell[o + 2] = rv[2];
        vo++;
      }
    }
    for (let i = 0; i < sub; i++) {
      for (let j = 0; j < sub - i; j++) {
        const a = vid(i, j);
        const b = vid(i + 1, j);
        const c = vid(i, j + 1);
        if (flip) {
          idx[io++] = a;
          idx[io++] = c;
          idx[io++] = b;
        } else {
          idx[io++] = a;
          idx[io++] = b;
          idx[io++] = c;
        }
        if (j < sub - i - 1) {
          const d = vid(i + 1, j + 1);
          if (flip) {
            idx[io++] = b;
            idx[io++] = c;
            idx[io++] = d;
          } else {
            idx[io++] = b;
            idx[io++] = d;
            idx[io++] = c;
          }
        }
      }
    }
  }
  ico.dispose();
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('aBary', new BufferAttribute(bary, 3));
  g.setAttribute('aCell', new BufferAttribute(cell, 3));
  g.setIndex(new BufferAttribute(idx.subarray(0, io), 1));
  g.computeBoundingSphere();
  return g;
}
