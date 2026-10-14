import { beforeAll, describe, expect, it } from "vitest";
import * as replicad from "replicad";
import { rangeIndex, toRanges } from "../src/kernel/ranges";
import { loadKernel, shapeOf } from "./oc";

beforeAll(loadKernel, 60_000);

const PART = `const main = () => makeBaseBox(40, 30, 10).cut(makeCylinder(4, 20, [5, 0, -5])).fillet(2, (e) => e.inPlane("XY", 10));`;

describe("face/edge ranges", () => {
  it("follow shape.faces / shape.edges order; every triangle of range i lies on face i", () => {
    const shape = shapeOf(PART);
    const m = shape.mesh({ tolerance: 0.1, angularTolerance: 0.25 });
    const e = shape.meshEdges({ tolerance: 0.1, angularTolerance: 0.25 });
    const faces = shape.faces, edges = shape.edges;
    expect(m.faceGroups.map((g) => g.faceId)).toEqual(faces.map((f) => f.hashCode));
    expect(e.edgeGroups.map((g) => g.edgeId)).toEqual(edges.map((x) => x.hashCode));
    const fr = toRanges(m.faceGroups), er = toRanges(e.edgeGroups);
    // The vertices of every 5th triangle lie on the face its range names
    let worst = 0;
    for (let t = 0; t < m.triangles.length / 3; t += 5) {
      const f = rangeIndex(fr, 3 * t);
      for (let k = 0; k < 3; k++) {
        const i = m.triangles[3 * t + k];
        worst = Math.max(worst, replicad.measureDistanceBetween(faces[f], replicad.makeVertex([m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]])));
      }
    }
    expect(worst).toBeLessThan(1e-3);
    // Segment start vertices are on their edge
    let worstE = 0;
    for (let v = 0; v < e.lines.length / 3; v += 2) {
      const i = rangeIndex(er, v);
      worstE = Math.max(worstE, replicad.measureDistanceBetween(edges[i], replicad.makeVertex([e.lines[3 * v], e.lines[3 * v + 1], e.lines[3 * v + 2]])));
    }
    expect(worstE).toBeLessThan(1e-3);
  });

  it("rangeIndex: inside, boundaries, outside", () => {
    const r = Uint32Array.from([0, 6, 6, 3, 9, 12]);
    expect([0, 5, 6, 8, 9, 20, 21, -1].map((p) => rangeIndex(r, p))).toEqual([0, 0, 1, 1, 2, 2, -1, -1]);
  });
});
