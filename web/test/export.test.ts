import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { instanceNames, planExport, restOffset, slugify } from "../src/export/plan";
import { triangles, write3mf, writeObj, writeStl, type MeshObject } from "../src/export/mesh";

// Unit cube from 0..1: 8 vertices, 12 triangles
const cube = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
  indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
};
// Translation by (tx, ty, tz), column-major
const translate = (tx: number, ty: number, tz: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];

const instances = [
  { part: "a", position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
  { part: "a", position: [10, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
  { part: "b", position: [0, 10, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
  { part: "bad", position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
];
const model = { instances, ok: (p: string) => p !== "bad" };

describe("planExport", () => {
  it("single part: one file, no ZIP; failed part plans nothing", () => {
    expect(planExport({ part: "a", format: "step", include: { parts: true, assembled: true } }, model)).toEqual({
      files: [{ name: "a.step", kind: "part", part: "a" }], download: "a.step", zip: false, skipped: [],
    });
    const bad = planExport({ part: "bad", format: "stl", include: { parts: true, assembled: true } }, model);
    expect(bad.files).toEqual([]);
    expect(bad.skipped).toEqual(["bad"]);
  });

  it("assembly: switches pick files; several files zip; failed parts left out", () => {
    const both = planExport({ format: "stl", include: { parts: true, assembled: true } }, model);
    expect(both.files.map((f) => f.name)).toEqual(["assembly.stl", "parts/a.stl", "parts/b.stl"]);
    expect(both.files.filter((f) => f.kind === "part").every((f) => f.rest)).toBe(true);
    expect(both).toMatchObject({ zip: true, download: "assembly.zip", skipped: ["bad"] });
    const asm = planExport({ format: "3mf", include: { parts: false, assembled: true } }, model);
    expect(asm).toMatchObject({ files: [{ name: "assembly.3mf", kind: "assembly" }], zip: false, download: "assembly.3mf" });
    const parts = planExport({ format: "obj", include: { parts: true, assembled: false } }, model);
    expect(parts.files.map((f) => f.name)).toEqual(["parts/a.obj", "parts/b.obj"]);
    expect(planExport({ format: "obj", include: { parts: false, assembled: false } }, model).files).toEqual([]);
  });

  it("one unique part with parts only downloads that file directly", () => {
    const one = planExport({ format: "stl", include: { parts: true, assembled: false } }, { instances: instances.slice(0, 2), ok: () => true });
    expect(one).toMatchObject({ zip: false, download: "a.stl" });
  });
});

describe("file names from the model name", () => {
  it("slugify: lowercase, ASCII, hyphens, transliterated, cut at a word boundary", () => {
    expect(slugify("ISO metric hex bolt & nut (M10)")).toBe("iso-metric-hex-bolt-nut-m10");
    expect(slugify("Кронштейн полки 200 мм")).toBe("kronshteyn-polki-200-mm");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("  --  ")).toBe("");
    expect(slugify(undefined)).toBe("");
    const long = slugify("Parametric wall shelf bracket with countersunk screw holes and optional gusset for heavy loads");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toBe("parametric-wall-shelf-bracket-with-countersunk-screw-holes");
    expect(slugify("x".repeat(80)).length).toBe(60);
  });

  it("assembly and ZIP use the model slug; parts get it as a prefix; no name keeps the old names", () => {
    const named = { ...model, title: "Wall Shelf Bracket" };
    const both = planExport({ format: "stl", include: { parts: true, assembled: true } }, named);
    expect(both.files.map((f) => f.name)).toEqual(["wall-shelf-bracket.stl", "parts/a.stl", "parts/b.stl"]);
    expect(both.download).toBe("wall-shelf-bracket.zip");
    expect(planExport({ format: "3mf", include: { parts: false, assembled: true } }, named).download).toBe("wall-shelf-bracket.3mf");
    expect(planExport({ part: "a", format: "step", include: { parts: true, assembled: true } }, named).download).toBe("wall-shelf-bracket-a.step");
  });
});

describe("instanceNames", () => {
  it("flat assemblies keep part names; repeats numbered per group; groups prefix the path", () => {
    expect(instanceNames([{ part: "gear" }, { part: "gear" }, { part: "base" }])).toEqual(["gear #1", "gear #2", "base"]);
    expect(instanceNames([
      { part: "shin", path: ["Left leg", "Knee"] },
      { part: "shin", path: ["Right leg", "Knee"] },
      { part: "bolt", label: "front bolt", path: ["Left leg"] },
      { part: "bolt", path: ["Left leg"] },
      { part: "bolt", path: ["Left leg"] },
    ])).toEqual(["Left leg / Knee / shin", "Right leg / Knee / shin", "Left leg / front bolt", "Left leg / bolt #1", "Left leg / bolt #2"]);
  });
});

describe("restOffset", () => {
  it("rests on Z = 0 and centres X/Y", () => {
    expect(restOffset({ min: [10, -4, 3], max: [20, 6, 9] })).toEqual([-15, -1, -3]);
  });
});

describe("weld", () => {
  it("merges duplicate positions and drops collapsed triangles", async () => {
    const { weld } = await import("../src/export/mesh");
    // Two triangles with their own copies of the shared edge, plus one degenerate after welding
    const m = weld({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0.000001, 1, 0, 0],
      indices: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    });
    expect(m.positions.length / 3).toBe(4);
    expect([...m.indices]).toEqual([0, 1, 2, 1, 3, 2]);
  });
});

describe("mesh writers", () => {
  const objs: MeshObject[] = [
    { name: "a", mesh: cube, color: "#ff0000" },
    { name: "b part", mesh: cube, matrix: translate(5, 0, 0) },
  ];

  it("STL: binary header count, transformed vertices, unit normals", () => {
    const b = writeStl(objs);
    const dv = new DataView(b.buffer);
    expect(dv.getUint32(80, true)).toBe(24);
    expect(b.byteLength).toBe(84 + 24 * 50);
    const xs: number[] = [];
    for (let t = 0; t < 24; t++) {
      const o = 84 + t * 50;
      expect(Math.hypot(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true))).toBeCloseTo(1, 5);
      for (let v = 0; v < 3; v++) xs.push(dv.getFloat32(o + 12 + v * 12, true));
    }
    expect(Math.max(...xs)).toBe(6);
    expect(triangles(objs)).toBe(24);
  });

  it("OBJ: objects, vertex and face counts, offsets across objects", () => {
    const text = strFromU8(writeObj(objs));
    expect(text.match(/^o /gm)).toHaveLength(2);
    expect(text).toContain("o b_part");
    expect(text.match(/^v /gm)).toHaveLength(16);
    const faces = text.match(/^f .*/gm)!;
    expect(faces).toHaveLength(24);
    expect(Math.max(...faces.flatMap((f) => f.slice(2).split(" ").map(Number)))).toBe(16);
    expect(text).toContain("v 6 1 1");
  });

  it("3MF: package parts, one object per mesh, items with transforms, colours", () => {
    const files = unzipSync(write3mf([objs[0]], [{ object: 0 }, { object: 0, matrix: translate(10, 0, 0) }]));
    expect(Object.keys(files).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
    const xml = strFromU8(files["3D/3dmodel.model"]);
    expect(xml).toMatch(/<model unit="millimeter"/);
    expect(xml.match(/<object /g)).toHaveLength(1);
    expect(xml.match(/<vertex /g)).toHaveLength(8);
    expect(xml.match(/<triangle /g)).toHaveLength(12);
    expect(xml.match(/<item /g)).toHaveLength(2);
    expect(xml).toContain('transform="1 0 0 0 1 0 0 0 1 10 0 0"');
    expect(xml).toContain('displaycolor="#FF0000FF"');
    // Every opened element is closed (well-formed enough for slicers' parsers)
    for (const tag of ["model", "resources", "object", "mesh", "vertices", "triangles", "build", "basematerials"]) {
      expect(xml.split(`<${tag}`).length).toBe(xml.split(`</${tag}>`).length);
    }
  });
});

describe("exportTolerance", () => {
  it("scales with the part size and clamps; fine is twice as tight", async () => {
    const { exportTolerance } = await import("../src/export/plan");
    expect(exportTolerance(104, "normal").tolerance).toBeCloseTo(0.0104, 9);
    expect(exportTolerance(104, "normal").angularTolerance).toBe(0.1);
    expect(exportTolerance(104, "fine").tolerance).toBeCloseTo(0.0052, 6);
    expect(exportTolerance(1, "normal").tolerance).toBe(0.002);
    expect(exportTolerance(5000, "normal").tolerance).toBe(0.05);
  });
});
