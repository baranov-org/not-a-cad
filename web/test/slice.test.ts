import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { sliceMesh } from "../src/slice";

// Unit cube from three, indexed
const cube = () => {
  const g = new THREE.BoxGeometry(2, 2, 2);
  return { pos: g.getAttribute("position").array, idx: g.index!.array };
};

describe("sliceMesh", () => {
  it("cuts a cube through the middle into a closed square outline", () => {
    const { pos, idx } = cube();
    const seg = sliceMesh(pos, idx, new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)); // z = 0
    expect(seg.length % 6).toBe(0);
    // 4 side faces x 2 triangles, each crossed once
    expect(seg.length / 6).toBe(8);
    for (let i = 0; i < seg.length; i += 3) {
      expect(seg[i + 2]).toBeCloseTo(0, 6);
      expect(Math.max(Math.abs(seg[i]), Math.abs(seg[i + 1]))).toBeCloseTo(1, 6); // on the square's border
    }
    // Total length = perimeter 8
    let len = 0;
    for (let i = 0; i < seg.length; i += 6) len += Math.hypot(seg[i + 3] - seg[i], seg[i + 4] - seg[i + 1], seg[i + 5] - seg[i + 2]);
    expect(len).toBeCloseTo(8, 6);
  });

  it("returns nothing when the plane misses", () => {
    const { pos, idx } = cube();
    expect(sliceMesh(pos, idx, new THREE.Plane(new THREE.Vector3(0, 0, 1), -5)).length).toBe(0);
  });

  it("handles tilted planes", () => {
    const { pos, idx } = cube();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 1, 1).normalize(), new THREE.Vector3());
    const seg = sliceMesh(pos, idx, plane);
    expect(seg.length).toBeGreaterThan(0);
    for (let i = 0; i < seg.length; i += 3) expect(plane.distanceToPoint(new THREE.Vector3(seg[i], seg[i + 1], seg[i + 2]))).toBeCloseTo(0, 6);
  });
});

describe("plane intersection lines", () => {
  // Unit cube 0..1
  const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];

  it("finds the line where two planes meet", async () => {
    const { planesLine } = await import("../src/slice");
    const l = planesLine(new THREE.Plane(new THREE.Vector3(1, 0, 0), -0.5), new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.25))!;
    expect(Math.abs(l.dir.z)).toBeCloseTo(1, 6);
    expect(l.origin.x).toBeCloseTo(0.5, 6);
    expect(l.origin.y).toBeCloseTo(0.25, 6);
    expect(planesLine(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Plane(new THREE.Vector3(0, 0, -1), 2))).toBeUndefined();
  });

  it("keeps the parts of the line inside the mesh, counting shared-edge hits once", async () => {
    const { lineInsideMesh } = await import("../src/slice");
    // Through the middle of two faces
    const t = lineInsideMesh(pos, idx, new THREE.Vector3(0.5, 0.5, -3), new THREE.Vector3(0, 0, 1));
    expect(t.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([3, 4]);
    // Through the diagonal edge of the face triangulation: still one entry and one exit
    const d = lineInsideMesh(pos, idx, new THREE.Vector3(0.3, 0.3, -1), new THREE.Vector3(0, 0, 1));
    expect(d.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([1, 2]);
    // Missing the mesh
    expect(lineInsideMesh(pos, idx, new THREE.Vector3(5, 5, 0), new THREE.Vector3(0, 0, 1))).toEqual([]);
  });
});
