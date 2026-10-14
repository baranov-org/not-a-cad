import * as THREE from "three";
import type { Direction, Instance } from "shared";
import type { MeshData } from "./kernel/types";
import { useStore } from "./state";

// Part geometries, outside React state
export const geometries = new Map<string, THREE.BufferGeometry>();
export const edgeGeometries = new Map<string, THREE.BufferGeometry>();

export function setGeometry(name: string, mesh: MeshData | undefined) {
  geometries.get(name)?.dispose();
  edgeGeometries.get(name)?.dispose();
  if (!mesh) {
    geometries.delete(name);
    edgeGeometries.delete(name);
  } else {
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
    edgeGeometries.set(name, eg);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeBoundingSphere();
    // Face/edge ranges for picking (absent in old share bundles)
    g.userData.faceRanges = mesh.faceRanges;
    eg.userData.edgeRanges = mesh.edgeRanges;
    geometries.set(name, g);
  }
  useStore.setState((s) => ({ meshVersion: s.meshVersion + 1 }));
}

// Replicad-style line colour: part colour with HSL lightness -20% (polished.darken(0.2, c))
export function darken(color: string, amount = 0.2): string {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return `#${c.setHSL(hsl.h, hsl.s, Math.max(0, hsl.l - amount)).getHexString()}`;
}

// Any CSS colour (incl. oklch tokens) as #rrggbb
const hexCache = new Map<string, string>();
export function cssHex(value: string): string {
  let h = hexCache.get(value);
  if (h) return h;
  const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  c.fillStyle = value;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  h = `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  hexCache.set(value, h);
  return h;
}

export const DEG = Math.PI / 180;
export const DEFAULT_COLOR = "#8fa8c8";

export function applyPlacement(o: THREE.Object3D, inst: Instance) {
  o.position.set(...inst.position);
  o.rotation.set(inst.rotation[0] * DEG, inst.rotation[1] * DEG, inst.rotation[2] * DEG, "XYZ");
}

// Viewer hooks set by the canvas
export const viewer: {
  fit?: (dir?: Direction) => void;
  capture?: () => string;
  // Fixed-view snapshot of the whole model (library card, share preview)
  thumbnail?: (w: number, h: number, type?: "image/jpeg") => Blob | undefined;
  // Camera state for tests (?debug)
  cameraState?: () => { distance: number; target: number[]; position: number[]; forward: number[]; near: number };
  // Measure hit under a client point
  pick?: (x: number, y: number) => import("./ui/Measure").Hit | undefined;
} = {};

export function download(f: { file: string; bytes: Uint8Array; mime: string }) {
  const url = URL.createObjectURL(new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = f.file;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
