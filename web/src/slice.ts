import * as THREE from "three";

// Segments where a plane cuts a triangle mesh (pairs of xyz points), in the mesh's own coordinates;
// `tris` gets each segment's triangle
export function sliceMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, plane: THREE.Plane, tris?: number[]): Float32Array {
  const { x: nx, y: ny, z: nz } = plane.normal;
  const c = plane.constant;
  const out: number[] = [];
  const p = [0, 0, 0].map(() => [0, 0, 0]);
  const d = [0, 0, 0];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const i = indices[t + k] * 3;
      p[k][0] = positions[i];
      p[k][1] = positions[i + 1];
      p[k][2] = positions[i + 2];
      // Vertices exactly on the plane count as positive, so shared edges aren't doubled
      const dist = nx * p[k][0] + ny * p[k][1] + nz * p[k][2] + c;
      d[k] = dist === 0 ? 1e-12 : dist;
    }
    let found = 0;
    for (let k = 0; k < 3; k++) {
      const a = k, b = (k + 1) % 3;
      if ((d[a] > 0) === (d[b] > 0)) continue;
      const s = d[a] / (d[a] - d[b]);
      out.push(p[a][0] + (p[b][0] - p[a][0]) * s, p[a][1] + (p[b][1] - p[a][1]) * s, p[a][2] + (p[b][2] - p[a][2]) * s);
      found++;
    }
    if (found === 1) out.length -= 3; // degenerate, ignore
    else if (found === 2) tris?.push(t / 3);
  }
  return new Float32Array(out);
}

// Segments of the line `origin + t·dir` that lie inside a closed mesh: crossings with the triangles,
// paired inside/outside along the line. Returns [t0, t1, t2, t3, …]
export function lineInsideMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, origin: THREE.Vector3, dir: THREE.Vector3): number[] {
  const ts: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < indices.length; i += 3) {
    a.fromArray(positions as number[], indices[i] * 3);
    b.fromArray(positions as number[], indices[i + 1] * 3);
    c.fromArray(positions as number[], indices[i + 2] * 3);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    p.crossVectors(dir, e2);
    const det = e1.dot(p);
    if (Math.abs(det) < 1e-12) continue; // line parallel to the triangle
    const inv = 1 / det;
    s.subVectors(origin, a);
    const u = s.dot(p) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    q.crossVectors(s, e1);
    const v = dir.dot(q) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    ts.push(e2.dot(q) * inv);
  }
  ts.sort((x, y) => x - y);
  // Hits on shared edges or vertices count once
  const eps = 1e-6 * Math.max(1, ...ts.map(Math.abs));
  const hits = ts.filter((t, i) => i === 0 || t - ts[i - 1] > eps);
  return hits.length % 2 === 0 ? hits : hits.slice(0, hits.length - 1);
}

// Line where two planes meet (normals need not be unit); undefined when they are parallel
export function planesLine(p1: THREE.Plane, p2: THREE.Plane): { origin: THREE.Vector3; dir: THREE.Vector3 } | undefined {
  const dir = new THREE.Vector3().crossVectors(p1.normal, p2.normal);
  const d2 = dir.lengthSq();
  if (d2 < 1e-10) return;
  // Point on both planes: (h1 (n2 × d) + h2 (d × n1)) / |d|², with n·x = h
  const h1 = -p1.constant, h2 = -p2.constant;
  const origin = new THREE.Vector3().crossVectors(p2.normal, dir).multiplyScalar(h1)
    .add(new THREE.Vector3().crossVectors(dir, p1.normal).multiplyScalar(h2))
    .divideScalar(d2);
  return { origin, dir: dir.normalize() };
}
