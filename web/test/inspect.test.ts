import { beforeAll, describe, expect, it } from "vitest";
import { allFacts, entityFacts, pairFacts, type EntityFacts } from "../src/kernel/inspect";
import { parseRef, summarizePart } from "../src/measure";
import { loadKernel, shapeOf } from "./oc";

beforeAll(loadKernel, 60_000);

// 100 × 60 × 8 plate, Ø6.6 holes at x = ±20, top edges (outline and hole rims) filleted R2
const PLATE = `const main = () => {
  let p = makeBaseBox(100, 60, 8);
  for (const x of [-20, 20]) p = p.cut(makeCylinder(3.3, 20, [x, 0, -5]));
  return p.fillet(2, (e) => e.inPlane("XY", 8));
};`;

describe("exact facts", () => {
  const shape = () => shapeOf(PLATE);
  const faces = () => allFacts(shape()).faces;
  const find = (fs: EntityFacts[], test: (f: EntityFacts) => boolean) => {
    const f = fs.find(test);
    if (!f) throw new Error("not found");
    return f;
  };

  it("holes: Ø6.60 concave cylinders, not fillets", () => {
    const holes = faces().filter((f) => f.type === "CYLINDER" && f.radius === 3.3);
    expect(holes).toHaveLength(2);
    for (const h of holes) expect(h).toMatchObject({ label: "Cylinder", diameter: 6.6, concave: true });
    expect(holes.every((h) => !h.fillet)).toBe(true);
  });

  it("fillets: straight ones are R2 cylinders, hole rims R2 tori with a 5.3 ring", () => {
    const fs = faces();
    const straight = fs.filter((f) => f.type === "CYLINDER" && f.radius === 2);
    expect(straight.length).toBeGreaterThanOrEqual(4);
    expect(straight.every((f) => f.fillet && f.label === "Fillet")).toBe(true);
    const rims = fs.filter((f) => f.type === "TORUS");
    expect(rims).toHaveLength(2);
    for (const t of rims) {
      expect(t.fillet).toBe(true);
      expect(t.radius!).toBeCloseTo(2, 4);
      expect(t.radii![1]).toBeCloseTo(5.3, 3);
    }
  });

  it("planes: 90° and 0°, 8 mm apart top to bottom", () => {
    const s = shape();
    const fs = faces();
    const top = find(fs, (f) => f.type === "PLANE" && f.normal![2] > 0.99);
    const bottom = find(fs, (f) => f.type === "PLANE" && f.normal![2] < -0.99);
    const side = find(fs, (f) => f.type === "PLANE" && Math.abs(f.normal![0]) > 0.99);
    const ref = (f: EntityFacts) => ({ shape: s, ref: { kind: "face" as const, index: f.index } });
    expect(pairFacts(ref(top), ref(side)).pair.angle).toBeCloseTo(90, 6);
    const tb = pairFacts(ref(top), ref(bottom)).pair;
    expect(tb.angle).toBeCloseTo(0, 6);
    expect(tb.distance).toBeCloseTo(8, 6);
  });

  it("two holes: 40 mm centre to centre; a placed instance shifts the distance", () => {
    const s = shape();
    const [a, b] = faces().filter((f) => f.type === "CYLINDER" && f.radius === 3.3);
    const pick = (f: EntityFacts, position: [number, number, number] = [0, 0, 0]) =>
      ({ shape: s, ref: { kind: "face" as const, index: f.index }, placement: { position, rotation: [0, 0, 0] as [number, number, number] } });
    const p = pairFacts(pick(a), pick(b)).pair;
    expect(p.centerDistance).toBeCloseTo(40, 6);
    expect(p.axisOffset).toBeCloseTo(40, 6);
    expect(p.distance).toBeCloseTo(40 - 6.6, 4);
    // Second instance moved 10 mm along the holes' line: 40 ± 10
    const moved = pairFacts(pick(a), pick(b, [10, 0, 0])).pair.centerDistance!;
    expect([30, 50].some((d) => Math.abs(moved - d) < 1e-6)).toBe(true);
    // Rotation is applied too: turned 90° about Z, a hole's axis stays vertical
    expect(entityFacts(s, { kind: "face", index: a.index }, { position: [0, 0, 0], rotation: [0, 0, 90] }).axis![2]).toBeCloseTo(1, 6);
  });

  it("edges and vertices: circle rim, straight 100 mm edge, vertex deltas", () => {
    const s = shape();
    const { edges } = allFacts(s);
    const rim = find(edges, (e) => e.type === "CIRCLE" && e.radius === 3.3);
    expect(rim).toMatchObject({ label: "Circle", diameter: 6.6, arcAngle: 360 });
    expect(rim.length).toBeCloseTo(2 * Math.PI * 3.3, 6);
    expect(edges.some((e) => e.type === "LINE" && Math.abs(e.length! - 100) < 1e-6)).toBe(true);
    const v0 = entityFacts(s, { kind: "vertex", index: 0 }), v1 = entityFacts(s, { kind: "vertex", index: 1 });
    const p = pairFacts({ shape: s, ref: { kind: "vertex", index: 0 } }, { shape: s, ref: { kind: "vertex", index: 1 } }).pair;
    expect(p.delta).toEqual(v1.position!.map((x, i) => Math.round((x - v0.position![i]) * 1e6) / 1e6 + 0));
    expect(() => entityFacts(s, { kind: "face", index: 999 })).toThrow(/No face 999/);
    // A vertex picked by position resolves to the nearest one
    const near = entityFacts(s, { kind: "vertex", index: -1, near: v1.position!.map((x) => x + 0.01) as [number, number, number] });
    expect(near.index).toBe(1);
  });
});

describe("part summary and references", () => {
  it("lists hole diameters, fillet radii and planes; filters and limits features", () => {
    const all = allFacts(shapeOf(PLATE));
    const s = summarizePart("plate", all);
    expect(s.diameters).toEqual(["Ø6.6 × 2 (hole)"]);
    expect(s.fillets).toHaveLength(1);
    expect(s.fillets[0]).toMatch(/^R2 fillet × \d+$/);
    expect(s.planes[0].area).toBeGreaterThan(5000);
    const holes = summarizePart("plate", all, { type: "hole" }).features;
    expect(holes).toHaveLength(2);
    expect(holes[0].ref).toMatch(/^plate:F\d+$/);
    expect(summarizePart("plate", all, { minRadius: 3 }).features.every((f) => f.radius! >= 3)).toBe(true);
    expect(summarizePart("plate", all, { limit: 3 }).features).toHaveLength(3);
  });

  it("parses references for parts and instance keys", () => {
    expect(parseRef("plate:F7")).toEqual({ target: "plate", ref: { kind: "face", index: 7 } });
    expect(parseRef("Left leg/Knee/shin#2:E12")).toEqual({ target: "Left leg/Knee/shin#2", ref: { kind: "edge", index: 12 } });
    expect(() => parseRef("plate F7")).toThrow(/Bad reference/);
  });
});

describe("section", () => {
  // 40 mm cube on Z=0, cut at x = 10 keeping x ≤ 10 (normal -X): n·p + c ≥ 0 → -x + 10 ≥ 0
  const BOX = "const main = () => makeBaseBox(40, 40, 40);";
  const cut = { normal: [-1, 0, 0] as [number, number, number], constant: 10 };
  const shape = () => shapeOf(BOX);
  const top = () => allFacts(shape()).faces.findIndex((f) => f.normal?.[2] === 1);

  it("clips faces and edges to the kept side", () => {
    const f = entityFacts(shape(), { kind: "face", index: top() }, undefined, [cut]);
    expect(f.clipped).toBe(true);
    expect(f.area).toBeCloseTo(30 * 40, 4);
    expect(f.size).toEqual([30, 40, 0]);
    const e = allFacts(shape()).edges.findIndex((x) => x.direction?.[0] !== 0 && x.direction?.[0] !== undefined);
    expect(entityFacts(shape(), { kind: "edge", index: e }, undefined, [cut]).length).toBeCloseTo(30, 4);
    // Without a section: the whole face
    expect(entityFacts(shape(), { kind: "face", index: top() }).area).toBeCloseTo(1600, 4);
  });

  it("a face entirely cut away can't be measured", () => {
    const right = allFacts(shape()).faces.findIndex((f) => f.normal?.[0] === 1);
    expect(() => entityFacts(shape(), { kind: "face", index: right }, undefined, [cut])).toThrow(/section removes/);
  });

  it("section lines: where the plane meets a face, clipped by other planes", () => {
    const f = entityFacts(shape(), { kind: "section", index: top(), cut: 0, near: [10, 0, 40] }, undefined, [cut]);
    expect(f).toMatchObject({ kind: "section", label: "Section line", length: 40 });
    const z = { normal: [0, -1, 0] as [number, number, number], constant: 5 }; // keeps y ≤ 5
    expect(entityFacts(shape(), { kind: "section", index: top(), cut: 0 }, undefined, [cut, z]).length).toBeCloseTo(25, 4);
    // Distance from the section line to the opposite face
    const left = allFacts(shape()).faces.findIndex((x) => x.normal?.[0] === -1);
    const r = pairFacts({ shape: shape(), ref: { kind: "section", index: top(), cut: 0 } }, { shape: shape(), ref: { kind: "face", index: left } }, [cut]);
    expect(r.pair.distance).toBeCloseTo(30, 4);
  });
});
