import * as THREE from "three";
import { create } from "zustand";
import type { CameraControlsImpl } from "@react-three/drei";

// Viewport navigation like CAD tools: zoom to the cursor in proportion to the scroll, orbit and pan around the point
// under the cursor, mouse presets of common CAD apps, and a trackpad mode where scrolling pans

type Ctl = CameraControlsImpl;
type Action = "rotate" | "pan" | "zoom" | "none";

export interface Preset {
  id: string;
  label: string;
  // Drag action by mouse button (0 left, 1 middle, 2 right) and modifier
  drag: (button: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) => Action;
  hint: string;
}

export const PRESETS: Preset[] = [
  { id: "default", label: "not-a-cad", hint: "Left orbit · right or middle pan · wheel zoom",
    drag: (b) => (b === 0 ? "rotate" : "pan") },
  { id: "fusion", label: "Fusion", hint: "Shift + middle orbit · middle pan · wheel zoom",
    drag: (b, e) => (b === 1 ? (e.shiftKey ? "rotate" : "pan") : "none") },
  { id: "solidworks", label: "SolidWorks", hint: "Middle orbit · Ctrl + middle pan · wheel zoom",
    drag: (b, e) => (b === 1 ? (e.ctrlKey || e.metaKey ? "pan" : "rotate") : "none") },
  { id: "onshape", label: "Onshape", hint: "Right orbit · middle pan · wheel zoom",
    drag: (b) => (b === 2 ? "rotate" : b === 1 ? "pan" : "none") },
  { id: "blender", label: "Blender", hint: "Middle orbit · Shift + middle pan · Ctrl + middle zoom",
    drag: (b, e) => (b === 1 ? (e.shiftKey ? "pan" : e.ctrlKey ? "zoom" : "rotate") : "none") },
];

interface Nav {
  preset: string;
  scroll: "zoom" | "pan"; // pan: two-finger scroll pans, Shift + scroll orbits, pinch zooms
}

const KEY = "cad.nav";
function load(): Nav {
  try {
    return { preset: "default", scroll: "zoom", ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { preset: "default", scroll: "zoom" };
  }
}
export const useNav = create<Nav>(load);
useNav.subscribe((n) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(n));
  } catch {
    // per-browser convenience only
  }
});

const presetOf = (id: string) => PRESETS.find((p) => p.id === id) ?? PRESETS[0];

// camera-controls action numbers
const ACTIONS = (C: typeof CameraControlsImpl) => ({ rotate: C.ACTION.ROTATE, pan: C.ACTION.TRUCK, zoom: C.ACTION.DOLLY, none: C.ACTION.NONE });

// Touch: one finger orbits, two pinch-zoom and pan, three pan
export function setupControls(ctl: Ctl) {
  const C = ctl.constructor as typeof CameraControlsImpl;
  ctl.dollyToCursor = true;
  ctl.infinityDolly = false;
  ctl.minDistance = 0.05;
  ctl.smoothTime = 0.06;
  ctl.draggingSmoothTime = 0.02;
  ctl.mouseButtons.wheel = C.ACTION.NONE; // handled by onWheel
  ctl.touches.one = C.ACTION.TOUCH_ROTATE;
  ctl.touches.two = C.ACTION.TOUCH_DOLLY_TRUCK;
  ctl.touches.three = C.ACTION.TOUCH_TRUCK;
}

// Before camera-controls sees a press: the preset decides what this button does, and the point under the cursor
// becomes the orbit point (so orbit pivots there and pan keeps it under the cursor)
export function onPointerDown(ctl: Ctl, e: PointerEvent, pickAt: (x: number, y: number) => THREE.Vector3 | undefined, fallback: () => THREE.Vector3) {
  if (e.pointerType !== "mouse") return;
  const C = ctl.constructor as typeof CameraControlsImpl;
  const a = ACTIONS(C);
  const action = presetOf(useNav.getState().preset).drag(e.button, e);
  ctl.mouseButtons.left = e.button === 0 ? a[action] : C.ACTION.NONE;
  ctl.mouseButtons.middle = e.button === 1 ? a[action] : C.ACTION.NONE;
  ctl.mouseButtons.right = e.button === 2 ? a[action] : C.ACTION.NONE;
  if (action === "rotate" || action === "pan") pivotAt(ctl, e.clientX, e.clientY, pickAt, fallback);
}

function pivotAt(ctl: Ctl, x: number, y: number, pickAt: (x: number, y: number) => THREE.Vector3 | undefined, fallback: () => THREE.Vector3) {
  const p = pickAt(x, y) ?? fallback();
  ctl.setOrbitPoint(p.x, p.y, p.z);
}

// Wheel: zoom to the cursor in proportion to the scroll amount (trackpads send many small events), capped per event;
// pinch (ctrlKey) always zooms; in "pan" scroll mode a two-finger scroll pans and Shift + scroll orbits
export function onWheel(ctl: Ctl, e: WheelEvent, el: HTMLElement, pickAt: (x: number, y: number) => THREE.Vector3 | undefined, fallback: () => THREE.Vector3) {
  e.preventDefault();
  const { scroll } = useNav.getState();
  const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
  const dx = e.deltaX * px, dy = e.deltaY * px;
  if (scroll === "pan" && !e.ctrlKey) {
    if (e.shiftKey) {
      void ctl.rotate((-dx - dy) * 0.004, 0, true);
    } else {
      pivotAt(ctl, e.clientX, e.clientY, pickAt, fallback);
      const perPx = viewHeight(ctl) / el.clientHeight;
      void ctl.truck(dx * perPx, dy * perPx, true);
    }
    return;
  }
  // One step (5%) per 40 px of scroll, so a wheel notch (~100 px) is ~12%; pinch deltas are small, so they count more.
  // Positive dolly moves out: scrolling down zooms out
  const steps = Math.max(-3, Math.min(3, dy / (e.ctrlKey ? 8 : 40)));
  const rect = el.getBoundingClientRect();
  const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1, ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  // camera-controls' own wheel path (dolly toward the cursor); its public dolly() ignores the cursor
  (ctl as unknown as { _dollyInternal(d: number, x: number, y: number): void })._dollyInternal(steps, nx, ny);
}

// World height of the view at the orbit point
function viewHeight(ctl: Ctl) {
  const cam = ctl.camera as THREE.PerspectiveCamera;
  return 2 * ctl.distance * Math.tan((cam.fov * Math.PI) / 360);
}
