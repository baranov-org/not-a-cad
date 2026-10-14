import * as THREE from "three";
import { applyPlacement, cssHex, darken, DEFAULT_COLOR, edgeGeometries, geometries } from "./scene";
import { useStore } from "./state";

// Library/share thumbnails: the whole model from a fixed iso view, on a plain background (no grid, section,
// hidden instances or build tints), rendered off screen

const ISO = new THREE.Vector3(1, -1, 0.8).normalize();
const MARGIN = 1.12;
const GAP = 0.15; // between loose parts, relative to the largest part

let renderer: THREE.WebGLRenderer | undefined;

const cssColor = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// Assembly instances; without an assembly, every part in a row along X
function buildScene(): THREE.Scene | undefined {
  const st = useStore.getState();
  const scene = new THREE.Scene();
  const add = (name: string, color: string, place: (o: THREE.Object3D) => void) => {
    const g = geometries.get(name);
    if (!g) return;
    const o = new THREE.Group();
    o.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: 1 })));
    const e = edgeGeometries.get(name);
    if (e) o.add(new THREE.LineSegments(e, new THREE.LineBasicMaterial({ color: darken(color) })));
    place(o);
    scene.add(o);
  };
  if (st.assembly.instances.length) {
    for (const inst of st.assembly.instances) add(inst.part, inst.color ?? DEFAULT_COLOR, (o) => applyPlacement(o, inst));
  } else {
    const names = Object.keys(st.parts).filter((n) => geometries.has(n)).sort();
    const boxes = names.map((n) => {
      const g = geometries.get(n)!;
      g.computeBoundingBox();
      return g.boundingBox!;
    });
    const gap = Math.max(1, ...boxes.map((b) => b.max.x - b.min.x)) * GAP;
    let x = 0;
    names.forEach((n, i) => {
      const b = boxes[i];
      add(n, DEFAULT_COLOR, (o) => o.position.set(x - b.min.x, 0, 0));
      x += b.max.x - b.min.x + gap;
    });
  }
  return scene.children.length ? scene : undefined;
}

// Orthographic iso camera fitted to the model's box at the image's aspect
function fitCamera(scene: THREE.Scene, aspect: number) {
  const box = new THREE.Box3().setFromObject(scene);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, radius * 8);
  cam.up.set(0, 0, 1);
  cam.position.copy(center).addScaledVector(ISO, radius * 3);
  cam.lookAt(center);
  cam.updateMatrixWorld();
  // Box corners in view space
  const inv = cam.matrixWorldInverse;
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
    [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.y), Math.max(y1, p.y)];
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let hw = ((x1 - x0) / 2) * MARGIN;
  let hh = ((y1 - y0) / 2) * MARGIN;
  if (hw / hh > aspect) hh = hw / aspect;
  else hw = hh * aspect;
  Object.assign(cam, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh });
  cam.updateProjectionMatrix();
  return cam;
}

// WebP where supported (not Safari), else JPEG; social previews ask for JPEG (not every site takes WebP)
export function renderThumbnail(w: number, h: number, format?: "image/jpeg"): Blob | undefined {
  const scene = buildScene();
  if (!scene) return;
  scene.background = new THREE.Color(cssHex(cssColor("--canvas", "#e9ecf1")));
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(100, -150, 200);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-120, 100, 60);
  scene.add(key, fill);
  const cam = fitCamera(scene, w / h);
  renderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(2);
  renderer.setSize(w, h, false);
  renderer.render(scene, cam);
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) (o.material as THREE.Material).dispose();
  });
  // Downscale the 2x render for smooth edges
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(renderer.domElement, 0, 0, w, h);
  let url = format ? "" : c.toDataURL("image/webp", 0.85);
  if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/jpeg", 0.88);
  const type = url.slice(5, url.indexOf(";"));
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
