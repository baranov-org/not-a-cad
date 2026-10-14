/// <reference lib="webworker" />
import * as Comlink from "comlink";
import * as replicad from "replicad";
import opencascade from "replicad-opencascadejs";
import type { ParamValue } from "shared";
import { MESH_TOL } from "./keys";
import { improveFacets } from "./meshQuality";
import { toRanges } from "./ranges";
import { allFacts, entityFacts, pairFacts } from "./inspect";
import type { BuildResult, ExportMesh, KernelApi, Metrics } from "./types";

type Shape3D = replicad.Shape3D;

const cache = new Map<string, Shape3D>();
const api = replicad as unknown as Record<string, unknown>;
const names = Object.keys(api).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default");
const values = names.map((k) => api[k]);

function part(name: string): Shape3D {
  const s = cache.get(name);
  if (!s) throw new Error(`Part "${name}" is not built`);
  return s.clone() as Shape3D;
}

const is3D = (s: unknown): s is Shape3D =>
  s instanceof replicad.Solid || s instanceof replicad.Shell || s instanceof replicad.Compound || s instanceof replicad.CompSolid;

function run(source: string, params: Record<string, ParamValue>): Shape3D {
  const param = (name: string): ParamValue => {
    if (!Object.hasOwn(params, name)) throw new Error(`Unknown parameter "${name}"`);
    return params[name];
  };
  const fn = new Function(...names, "part", "param", `${source}\n;return typeof main === "function" ? main : undefined;`);
  const main = fn(...values, part, param);
  if (!main) throw new Error("Script must define `const main = () => shape`");
  const shape = main();
  if (!is3D(shape)) throw new Error("main() must return a 3D shape (Solid/Shell/Compound)");
  return shape;
}

const r = (v: number) => Math.round(v * 1e6) / 1e6;

const kernel: KernelApi = {
  // WASM bytes come from the page so the worker needs no network access
  async init(wasmBinary) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oc = await (opencascade as any)({ wasmBinary });
    replicad.setOC(oc);
  },

  async build(name, source, params, withMesh = true): Promise<BuildResult> {
    let shape: Shape3D;
    try {
      shape = run(source, params);
    } catch (e) {
      kernel.drop(name);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!withMesh) {
      cache.get(name)?.delete();
      cache.set(name, shape);
      return { ok: true };
    }
    try {
      const tol = MESH_TOL;
      const m = shape.mesh(tol);
      const e = shape.meshEdges(tol);
      const [min, max] = shape.boundingBox.bounds;
      const metrics: Metrics = {
        bbox: { min: min.map(r) as Metrics["bbox"]["min"], max: max.map(r) as Metrics["bbox"]["max"] },
        volume: r(replicad.measureVolume(shape)),
        // From the meshes' groups: shape.faces/edges dedupe in O(n²) and took most of the build time
        faces: m.faceGroups.length,
        edges: e.edgeGroups.length,
      };
      const mesh = {
        positions: new Float32Array(m.vertices),
        normals: new Float32Array(m.normals),
        indices: improveFacets(m.vertices, m.normals, m.triangles).indices,
        edges: new Float32Array(e.lines),
        faceRanges: toRanges(m.faceGroups),
        edgeRanges: toRanges(e.edgeGroups),
      };
      cache.get(name)?.delete();
      cache.set(name, shape);
      return Comlink.transfer({ ok: true, mesh, metrics }, [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.edges.buffer, mesh.faceRanges.buffer, mesh.edgeRanges.buffer]);
    } catch (e) {
      kernel.drop(name);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  serialize(name) {
    return cache.get(name)?.serialize();
  },

  load(name, brep) {
    cache.get(name)?.delete();
    cache.set(name, replicad.deserializeShape(brep) as Shape3D);
  },

  drop(name) {
    cache.get(name)?.delete();
    cache.delete(name);
  },

  async stepVolume(bytes) {
    const shape = await replicad.importSTEP(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    try {
      return r(replicad.measureVolume(shape as Shape3D));
    } finally {
      shape.delete();
    }
  },

  inspect(items, cuts) {
    const shapeOf = (name: string) => {
      const s = cache.get(name);
      if (!s) throw new Error(`Part "${name}" is not built`);
      return s;
    };
    if (items.length === 1) return { facts: [entityFacts(shapeOf(items[0].part), items[0].ref, items[0].placement, cuts)] };
    const [a, b] = items.map((i) => ({ shape: shapeOf(i.part), ref: i.ref, placement: i.placement }));
    const r = pairFacts(a, b, cuts);
    return { facts: [r.a, r.b], pair: r.pair };
  },

  inspectAll(name) {
    const s = cache.get(name);
    if (!s) throw new Error(`Part "${name}" is not built`);
    return allFacts(s);
  },

  // Re-mesh from the exact shape: drop the preview triangulation first, or BRepMesh keeps it
  exportMesh(name, tolerance, angularTolerance): ExportMesh {
    const shape = cache.get(name);
    if (!shape) throw new Error(`Part "${name}" is not built`);
    replicad.getOC().BRepTools.Clean(shape.wrapped, true);
    const m = shape.mesh({ tolerance, angularTolerance });
    const out = { positions: new Float32Array(m.vertices), indices: improveFacets(m.vertices, m.normals, m.triangles).indices };
    return Comlink.transfer(out, [out.positions.buffer, out.indices.buffer]);
  },

  async exportStep(items) {
    const shapes = items.map((it) => {
      let s = part(it.part);
      if (it.rest) {
        const [min, max] = s.boundingBox.bounds;
        s = s.translate([-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]]);
      }
      // three.js Euler XYZ = rotate about Z, then Y, then X (world axes)
      const [rx, ry, rz] = it.rotation ?? [0, 0, 0];
      if (rz) s = s.rotate(rz, [0, 0, 0], [0, 0, 1]);
      if (ry) s = s.rotate(ry, [0, 0, 0], [0, 1, 0]);
      if (rx) s = s.rotate(rx, [0, 0, 0], [1, 0, 0]);
      if (it.position) s = s.translate(it.position);
      return { shape: s, name: it.name, color: it.color };
    });
    try {
      const blob = replicad.exportSTEP(shapes, { unit: "MM" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return Comlink.transfer(bytes, [bytes.buffer]);
    } finally {
      for (const s of shapes) s.shape.delete();
    }
  },
};

Comlink.expose(kernel);
