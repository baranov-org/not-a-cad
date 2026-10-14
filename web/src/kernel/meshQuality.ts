// Mesh clean-up after OCCT triangulation: flip shared edges where that brings both facets closer to the surface
// normals at their vertices. BRepMesh leaves needle triangles on curved faces whose facet normals are noise (STL
// facets tilted up to ~25° on freeform surfaces); vertex normals come from the surface, so they judge the fix.
// Each B-rep face has its own vertices, so face boundaries (sharp edges) are never touched.

const DEG = 180 / Math.PI;

export interface FlipResult {
  indices: Uint32Array;
  flips: number;
}

export function improveFacets(positions: ArrayLike<number>, normals: ArrayLike<number>, triangles: ArrayLike<number>,
  { minGainDeg = 0.25, passes = 8 } = {}): FlipResult {
  const P = positions, N = normals;
  const T = Uint32Array.from(triangles as ArrayLike<number>);
  const nt = T.length / 3;
  const nv = P.length / 3;
  // Cosine between the facet normal of (a, b, c) and the mean vertex normal; -2 for degenerate facets
  const cosine = (a: number, b: number, c: number): number => {
    const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
    const ux = P[3 * b] - ax, uy = P[3 * b + 1] - ay, uz = P[3 * b + 2] - az;
    const vx = P[3 * c] - ax, vy = P[3 * c + 1] - ay, vz = P[3 * c + 2] - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const mx = N[3 * a] + N[3 * b] + N[3 * c], my = N[3 * a + 1] + N[3 * b + 1] + N[3 * c + 1], mz = N[3 * a + 2] + N[3 * b + 2] + N[3 * c + 2];
    const l2 = (fx * fx + fy * fy + fz * fz) * (mx * mx + my * my + mz * mz);
    if (l2 < 1e-24) return -2;
    return (fx * mx + fy * my + fz * mz) / Math.sqrt(l2);
  };
  const deg = (c: number) => Math.acos(c > 1 ? 1 : c < -1 ? -1 : c) * DEG;
  let flips = 0;
  // Open-addressing table: edge key → first half-edge (3·triangle + k) seen with it
  let size = 1;
  while (size < nt * 4) size <<= 1;
  const keys = new Float64Array(size);
  const vals = new Int32Array(size);
  const mask = size - 1;
  const touched = new Uint8Array(nt);
  for (let pass = 0; pass < passes; pass++) {
    keys.fill(-1);
    touched.fill(0);
    let changed = 0;
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) {
        const u = T[3 * t + k], v = T[3 * t + ((k + 1) % 3)];
        const lo = u < v ? u : v, hi = u < v ? v : u;
        const key = lo * nv + hi;
        let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b)) & mask;
        while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) & mask;
        if (keys[h] === -1) {
          keys[h] = key;
          vals[h] = 3 * t + k;
          continue;
        }
        const other = vals[h];
        // A third use of this edge (non-manifold) finds the slot taken: never pair it again
        vals[h] = -1;
        if (other < 0) continue;
        const t2 = (other / 3) | 0;
        if (touched[t] || touched[t2] || t2 === t) continue;
        // Shared edge u→v in t; c opposite in t, d opposite in t2 (which runs v→u when consistently wound)
        const c = T[3 * t + ((k + 2) % 3)];
        const k2 = other % 3;
        if (T[3 * t2 + k2] !== v || T[3 * t2 + ((k2 + 1) % 3)] !== u) continue;
        const d = T[3 * t2 + ((k2 + 2) % 3)];
        const before = Math.min(cosine(u, v, c), cosine(v, u, d));
        if (before > 0.99999) continue;
        const after = Math.min(cosine(c, u, d), cosine(d, v, c));
        if (after > before && after > 0 && deg(after) + minGainDeg < deg(before)) {
          T[3 * t] = c; T[3 * t + 1] = u; T[3 * t + 2] = d;
          T[3 * t2] = d; T[3 * t2 + 1] = v; T[3 * t2 + 2] = c;
          touched[t] = touched[t2] = 1;
          changed++;
        }
      }
    }
    flips += changed;
    if (!changed) break;
  }
  return { indices: T, flips };
}
