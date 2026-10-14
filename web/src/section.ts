import * as THREE from "three";

export type SectionPlane = "XY" | "XZ" | "YZ";

export interface Section {
  on: boolean;
  plane: SectionPlane;
  offset: number; // mm along the normal from the model centre
  tiltA: number; // degrees about the plane's first in-plane axis
  tiltB: number; // degrees about the second
  flip: boolean;
}

export const defaultSection = (): Section => ({ on: false, plane: "XZ", offset: 0, tiltA: 0, tiltB: 0, flip: false });

// Base normal and in-plane axes per plane
const BASES: Record<SectionPlane, [n: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3]> = {
  XY: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
  XZ: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
  YZ: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
};

const DEG = Math.PI / 180;

// Clipping plane: keeps the side the normal points to (three.js clips distance < 0)
export type PlaneShape = Pick<Section, "plane" | "offset" | "tiltA" | "tiltB" | "flip">;

export function sectionPlane(s: PlaneShape, center: THREE.Vector3): THREE.Plane {
  const [n0, u, v] = BASES[s.plane];
  const n = n0.clone().applyAxisAngle(u, s.tiltA * DEG).applyAxisAngle(v, s.tiltB * DEG).normalize();
  if (s.flip) n.negate();
  const point = center.clone().addScaledVector(n, s.flip ? -s.offset : s.offset);
  return new THREE.Plane().setFromNormalAndCoplanarPoint(n, point);
}

// Right-handed in-plane axes of the cut (u follows the base plane's first axis), used to anchor hatching
export function sectionAxes(s: PlaneShape): { u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3 } {
  const [n0, u0, v0] = BASES[s.plane];
  const n = n0.clone().applyAxisAngle(u0, s.tiltA * DEG).applyAxisAngle(v0, s.tiltB * DEG).normalize();
  if (s.flip) n.negate();
  const u = u0.clone().applyAxisAngle(v0, s.tiltB * DEG).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v, n };
}

// ---- multi-plane state

export const MAX_PLANES = 3;
export const PLANE_COLORS = ["#1c7ed6", "#f08c00", "#37b24d"];
const AXIS_ORDER: SectionPlane[] = ["XZ", "XY", "YZ"];

export interface CutPlane {
  id: number;
  plane: SectionPlane;
  offset: number;
  tiltA: number;
  tiltB: number;
  flip: boolean;
  enabled: boolean;
}

export interface Sections {
  open: boolean; // section on: bar shown and cutting (closing keeps the planes)
  planes: CutPlane[];
  selected: number; // -1: no editor open
}

export const newPlane = (id: number, plane: SectionPlane): CutPlane => ({ id, plane, offset: 0, tiltA: 0, tiltB: 0, flip: false, enabled: true });

export const defaultSections = (): Sections => ({ open: false, planes: [newPlane(1, "XZ")], selected: 0 });

// Adds a plane in the lowest free slot (1–3: its number and colour) on an axis no other plane uses, and selects it
export function addPlane(s: Sections): Sections {
  if (s.planes.length >= MAX_PLANES) return s;
  const used = new Set(s.planes.map((p) => p.plane));
  const axis = AXIS_ORDER.find((a) => !used.has(a)) ?? "XZ";
  const id = [1, 2, 3].find((n) => !s.planes.some((p) => p.id === n))!;
  const planes = [...s.planes, newPlane(id, axis)].sort((a, b) => a.id - b.id);
  return { ...s, planes, selected: planes.findIndex((p) => p.id === id) };
}

// Back to the first-open state (one XZ plane through the centre), keeping whether cutting is on
export const resetSections = (s: Sections): Sections => ({ ...defaultSections(), open: s.open });

// Removing the selected plane selects the previous one; the last one can go too ("No planes")
export function removePlane(s: Sections, i: number): Sections {
  const planes = s.planes.filter((_, k) => k !== i);
  const selected = s.selected === i ? Math.max(0, i - 1) : s.selected > i ? s.selected - 1 : s.selected;
  return { ...s, planes, selected: planes.length ? Math.min(selected, planes.length - 1) : -1 };
}

export const updatePlane = (s: Sections, i: number, patch: Partial<CutPlane>): Sections =>
  ({ ...s, planes: s.planes.map((p, k) => (k === i ? { ...p, ...patch } : p)) });

// Planes that cut right now
export const activePlanes = (s: Sections): CutPlane[] => (s.open ? s.planes.filter((p) => p.enabled) : []);

// Colour of a plane: by its slot in the palette
export const planeColor = (s: Sections, p: CutPlane) => PLANE_COLORS[(p.id - 1) % PLANE_COLORS.length];
