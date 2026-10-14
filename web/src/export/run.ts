import * as THREE from "three";
import { zipSync } from "fflate";
import { engine } from "../runtime";
import { applyPlacement, DEFAULT_COLOR, geometries } from "../scene";
import { useStore } from "../state";
import { triangles, write3mf, writeObj, writeStl, type MeshObject } from "./mesh";
import { exportTolerance, instanceNames, planExport, restOffset, type Format, type Include, type PlannedFile, type Quality } from "./plan";
export type { Quality } from "./plan";

export interface ExportFile {
  file: string;
  bytes: Uint8Array;
  mime: string;
  contents: string[];
  // Mesh formats only
  triangles?: number;
  skipped: string[];
}

const MIME: Record<Format, string> = { stl: "model/stl", obj: "model/obj", "3mf": "model/3mf", step: "model/step" };


export interface ExportRequest {
  part?: string; // undefined = the assembly
  format: Format;
  include: Include;
  // Mesh formats: draft = the viewer's mesh; normal/fine = re-meshed from the exact shape
  quality?: Quality;
}

const diagOf = (part: string) => {
  const b = useStore.getState().parts[part]?.metrics?.bbox;
  return b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 100;
};

// What the viewport shows: a part, or the assembly
export const viewTarget = () => {
  const v = useStore.getState().view;
  return v.kind === "part" ? v.name : undefined;
};

export function currentPlan({ part, format, include }: ExportRequest) {
  const s = useStore.getState();
  const ok = (p: string) => s.parts[p]?.status === "ok" && geometries.has(p);
  return planExport({ part, format, include }, { instances: s.assembly.instances, ok, title: s.info.name });
}

// The viewer's mesh (draft export)
const previewMesh = (part: string) => {
  const g = geometries.get(part)!;
  return { positions: g.getAttribute("position").array, indices: g.index!.array };
};

const restMatrix = (part: string) => {
  const g = geometries.get(part)!;
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const [x, y, z] = restOffset({ min: b.min.toArray(), max: b.max.toArray() });
  return new THREE.Matrix4().makeTranslation(x, y, z).elements;
};

const placement = (inst: Parameters<typeof applyPlacement>[1]) => {
  const o = new THREE.Object3D();
  applyPlacement(o, inst);
  o.updateMatrix();
  return o.matrix.elements;
};

async function build(f: PlannedFile, format: Format, meshOf: (part: string) => { positions: ArrayLike<number>; indices: ArrayLike<number> }): Promise<{ bytes: Uint8Array; tris?: number }> {
  const { assembly } = useStore.getState();
  const instances = f.kind === "assembly"
    ? ((names) => assembly.instances.map((inst, i) => ({ inst, name: names[i] })))(instanceNames(assembly.instances)).filter(({ inst }) => geometries.has(inst.part) && useStore.getState().parts[inst.part]?.status === "ok")
    : [];
  const color = (part: string) => assembly.instances.find((i) => i.part === part)?.color ?? DEFAULT_COLOR;

  if (format === "step") {
    const items = f.kind === "assembly"
      ? instances.map(({ inst, name }) => ({ name, part: inst.part, rotation: inst.rotation, position: inst.position, color: inst.color ?? DEFAULT_COLOR }))
      : [{ name: f.part!, part: f.part!, rest: f.rest, color: color(f.part!) }];
    return { bytes: await engine.exportStep(items) };
  }

  if (format === "3mf") {
    if (f.kind === "part") {
      const objs = [{ name: f.part!, mesh: meshOf(f.part!), color: color(f.part!) }];
      return { bytes: write3mf(objs, [{ object: 0, matrix: f.rest ? restMatrix(f.part!) : undefined }]), tris: triangles(objs) };
    }
    const unique = [...new Set(instances.map(({ inst }) => inst.part))];
    const objs = unique.map((p) => ({ name: p, mesh: meshOf(p), color: color(p) }));
    const items = instances.map(({ inst, name }) => ({ object: unique.indexOf(inst.part), matrix: placement(inst), name }));
    return { bytes: write3mf(objs, items), tris: instances.reduce((t, { inst }) => t + meshOf(inst.part).indices.length / 3, 0) };
  }

  // STL and OBJ: one mesh; assembled instances are merged
  const objs: MeshObject[] = f.kind === "assembly"
    ? instances.map(({ inst, name }) => ({ name, mesh: meshOf(inst.part), matrix: placement(inst) }))
    : [{ name: f.part!, mesh: meshOf(f.part!), matrix: f.rest ? restMatrix(f.part!) : undefined }];
  return { bytes: format === "stl" ? writeStl(objs) : writeObj(objs), tris: triangles(objs) };
}

// Builds the planned files; several files go into one ZIP
export async function runExport(req: ExportRequest): Promise<ExportFile> {
  const { format } = req;
  const plan = currentPlan(req);
  if (!plan.files.length) {
    throw new Error(plan.skipped.length ? `Nothing to export: ${plan.skipped.join(", ")} failed to build` : "Nothing to export");
  }
  if (format === "step") await engine.idle();
  let meshOf = previewMesh;
  const quality = req.quality ?? "normal";
  if (format !== "step" && quality !== "draft") {
    const parts = [...new Set(plan.files.flatMap((f) => (f.kind === "part" ? [f.part!] : useStore.getState().assembly.instances.map((i) => i.part))))]
      .filter((p) => useStore.getState().parts[p]?.status === "ok" && geometries.has(p));
    const meshes = await engine.exportMeshes(parts, (p) => exportTolerance(diagOf(p), quality));
    meshOf = (p) => meshes.get(p) ?? previewMesh(p);
  }
  const built = await Promise.all(plan.files.map((f) => build(f, format, meshOf)));
  const tris = format === "step" ? undefined : built.reduce((t, b) => t + (b.tris ?? 0), 0);
  const contents = plan.files.map((f) => f.name);
  if (!plan.zip) {
    return { file: plan.download, bytes: built[0].bytes, mime: MIME[format], contents: [plan.download], triangles: tris, skipped: plan.skipped };
  }
  const bytes = zipSync(Object.fromEntries(plan.files.map((f, i) => [f.name, built[i].bytes])), { level: 1 });
  return { file: plan.download, bytes, mime: "application/zip", contents, triangles: tris, skipped: plan.skipped };
}
