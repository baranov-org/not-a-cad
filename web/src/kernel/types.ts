import type { ParamValue, Vec3 } from "shared";
import type { Cut, EntityFacts, EntityRef, PairFacts, Placement } from "./inspect";

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  // B-rep edges as line segment pairs
  edges: Float32Array;
  // [start, count] per B-rep face (index entries) and edge (line vertices), in shape.faces/edges order
  faceRanges?: Uint32Array;
  edgeRanges?: Uint32Array;
}

export interface Metrics {
  bbox: { min: Vec3; max: Vec3 };
  volume: number;
  faces: number;
  edges: number;
}

export type BuildResult =
  | { ok: true; mesh: MeshData; metrics: Metrics }
  | { ok: true; mesh?: undefined; metrics?: undefined } // shape only
  | { ok: false; error: string };

export interface KernelApi {
  init(wasmBinary: ArrayBuffer): Promise<void>;
  // withMesh=false keeps only the shape (for dependents of cached parts)
  build(name: string, source: string, values: Record<string, ParamValue>, withMesh?: boolean): Promise<BuildResult>;
  drop(name: string): void;
  // BREP transfer of built shapes between workers
  serialize(name: string): string | undefined;
  load(name: string, brep: string): void;
  // Fresh triangulation of a built part for mesh export (tolerance in mm, angular in rad)
  exportMesh(name: string, tolerance: number, angularTolerance: number): ExportMesh;
  // Exact measurements: one or two picked entities of built parts (placed as instances)
  inspect(items: InspectItem[], cuts?: Cut[]): InspectResult;
  // Facts for every face and edge of a part (agent summaries)
  inspectAll(name: string): { faces: EntityFacts[]; edges: EntityFacts[] };
  // STEP of placed copies of built shapes (exact B-rep)
  exportStep(items: StepItem[]): Promise<Uint8Array>;
  // Volume of the solids in a STEP file (checks exports)
  stepVolume(bytes: Uint8Array): Promise<number>;
}

export interface InspectItem {
  part: string;
  ref: EntityRef;
  placement?: Placement;
}

export interface InspectResult {
  facts: EntityFacts[];
  pair?: PairFacts;
}

export interface ExportMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface StepItem {
  name: string;
  part: string;
  // Instance placement: XYZ Euler degrees (three.js order), then translation in mm
  rotation?: [number, number, number];
  position?: [number, number, number];
  // Rest on Z = 0, centred in X/Y ("ready to print")
  rest?: boolean;
  color?: string;
}
