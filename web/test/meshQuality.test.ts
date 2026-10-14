import { describe, expect, it } from "vitest";
import { improveFacets } from "../src/kernel/meshQuality";

// Cylinder patch r = 10 about Z; vertex normals radial (from the surface)
const ring = (z: number, angles: number[]) => angles.map((a) => [10 * Math.cos(a), 10 * Math.sin(a), z]);
const radial = (p: number[]) => { const l = Math.hypot(p[0], p[1]); return [p[0] / l, p[1] / l, 0]; };
const facetDeviation = (P: number[][], N: number[][], t: number[]) => {
  const [a, b, c] = t.map((i) => P[i]);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const m = t.map((i) => N[i]).reduce((s, n) => [s[0] + n[0], s[1] + n[1], s[2] + n[2]]);
  return Math.acos((f[0] * m[0] + f[1] * m[1] + f[2] * m[2]) / (Math.hypot(...f) * Math.hypot(...m))) * 180 / Math.PI;
};

describe("improveFacets", () => {
  it("replaces needle triangles on a curved face with ones that follow the surface", () => {
    // Kite cell on a cylinder r = 10 about Z: a long edge along the arc (0..0.6 rad) and two points near its middle.
    // The long diagonal makes two needles whose facets are ~84° off the surface; the short one follows it within 3°.
    const pt = (a: number, z: number) => ring(z, [a])[0];
    const P = [pt(0, 0), pt(0.6, 0), pt(0.3, 0.05), pt(0.3, -0.05)];
    const N = P.map(radial);
    const worst = (t: number[]) => Math.max(facetDeviation(P, N, t.slice(0, 3)), facetDeviation(P, N, t.slice(3)));
    const needles = [0, 1, 2, 1, 0, 3];
    expect(worst(needles)).toBeGreaterThan(80);
    const r = improveFacets(P.flat(), N.flat(), needles);
    expect(r.flips).toBe(1);
    expect(Array.from(r.indices)).toEqual([2, 0, 3, 3, 1, 2]);
    expect(worst(Array.from(r.indices))).toBeLessThan(3);
    // Already good: left alone
    expect(improveFacets(P.flat(), N.flat(), [2, 0, 3, 3, 1, 2]).flips).toBe(0);
  });

  it("leaves flat faces, face boundaries and non-shared edges alone", () => {
    // Two coplanar triangles with equal normals: nothing to gain
    const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].flat();
    const N = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]].flat();
    expect(improveFacets(P, N, [0, 1, 2, 0, 2, 3]).flips).toBe(0);
    // Separate vertices per face (as OCCT gives them): no shared edge, no flip across the crease
    const Q = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0], [0, 0, 1]].flat();
    const M = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, -1, 0], [0, -1, 0], [0, -1, 0]].flat();
    expect(improveFacets(Q, M, [0, 1, 2, 3, 5, 4]).flips).toBe(0);
  });
});
