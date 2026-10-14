import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { defaultSection, sectionPlane } from "../src/section";

const c = new THREE.Vector3(1, 2, 3);
const near = (a: THREE.Vector3, b: [number, number, number]) => b.forEach((x, i) => expect(a.getComponent(i)).toBeCloseTo(x, 6));

describe("section plane", () => {
  it("base planes pass through centre + offset along their normal", () => {
    for (const [plane, n] of [["XY", [0, 0, 1]], ["XZ", [0, 1, 0]], ["YZ", [1, 0, 0]]] as const) {
      const p = sectionPlane({ ...defaultSection(), plane, offset: 5 }, c);
      near(p.normal, n as [number, number, number]);
      const onPlane = c.clone().addScaledVector(new THREE.Vector3(...n), 5);
      expect(p.distanceToPoint(onPlane)).toBeCloseTo(0, 6);
      // The kept side is where the normal points
      expect(p.distanceToPoint(onPlane.clone().addScaledVector(new THREE.Vector3(...n), 1))).toBeGreaterThan(0);
    }
  });

  it("tilts rotate the normal about the in-plane axes", () => {
    near(sectionPlane({ ...defaultSection(), plane: "XY", tiltA: 90 }, c).normal, [0, -1, 0]); // Z about X
    near(sectionPlane({ ...defaultSection(), plane: "XY", tiltB: 90 }, c).normal, [1, 0, 0]); // Z about Y
    const t = sectionPlane({ ...defaultSection(), plane: "XZ", tiltA: 30 }, c).normal; // Y about X
    near(t, [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]);
  });

  it("flip keeps the other side at the same position", () => {
    const a = sectionPlane({ ...defaultSection(), plane: "XZ", offset: 4 }, c);
    const b = sectionPlane({ ...defaultSection(), plane: "XZ", offset: 4, flip: true }, c);
    near(b.normal, [0, -1, 0]);
    const p = c.clone().add(new THREE.Vector3(0, 4, 0));
    expect(a.distanceToPoint(p)).toBeCloseTo(0, 6);
    expect(b.distanceToPoint(p)).toBeCloseTo(0, 6);
  });
});

describe("section axes", async () => {
  const { sectionAxes } = await import("../src/section");
  it("are orthonormal, right-handed and in the cut plane for any plane/tilt/flip", () => {
    for (const plane of ["XY", "XZ", "YZ"] as const) {
      for (const [tiltA, tiltB, flip] of [[0, 0, false], [30, -20, false], [-45, 60, true]] as const) {
        const s = { ...defaultSection(), plane, tiltA, tiltB, flip };
        const { u, v, n } = sectionAxes(s);
        near(n, sectionPlane(s, c).normal.toArray() as [number, number, number]);
        expect(u.dot(n)).toBeCloseTo(0, 6);
        expect(v.dot(n)).toBeCloseTo(0, 6);
        expect(u.dot(v)).toBeCloseTo(0, 6);
        expect(new THREE.Vector3().crossVectors(u, v).dot(n)).toBeCloseTo(1, 6);
      }
    }
  });
});

describe("section planes state", () => {
  it("adds planes on unused axes up to 3, removes, and filters active ones", async () => {
    const { activePlanes, addPlane, defaultSections, removePlane, updatePlane } = await import("../src/section");
    let s = defaultSections();
    expect(activePlanes(s)).toEqual([]); // bar closed
    s = { ...s, open: true };
    s = addPlane(addPlane(s));
    expect(s.planes.map((p) => p.plane)).toEqual(["XZ", "XY", "YZ"]);
    expect(s.selected).toBe(2);
    expect(addPlane(s)).toBe(s); // max 3
    s = updatePlane(s, 1, { enabled: false });
    expect(activePlanes(s).map((p) => p.plane)).toEqual(["XZ", "YZ"]);
    expect(activePlanes({ ...s, open: false })).toEqual([]);
    s = removePlane(s, 0);
    expect(s.planes.map((p) => p.plane)).toEqual(["XY", "YZ"]);
    // A removed slot and axis are reused, in slot order
    const re = addPlane(s);
    expect(re.planes.map((p) => [p.id, p.plane])).toEqual([[1, "XZ"], [2, "XY"], [3, "YZ"]]);
    expect(re.selected).toBe(0);
    // The last plane can go too: no editor open
    const none = removePlane(removePlane(s, 0), 0);
    expect(none.planes).toHaveLength(0);
    expect(none.selected).toBe(-1);
  });
});
