import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { create } from "zustand";
import type { Instance } from "shared";
import type { EntityFacts, EntityRef } from "../kernel/inspect";
import type { InspectResult } from "../kernel/types";
import { rangeIndex } from "../kernel/ranges";
import { sliceMesh } from "../slice";
import { pairView, pickView, refString, shortRef, type Row } from "../measure";
import { engine } from "../runtime";
import { applyPlacement, edgeGeometries, geometries } from "../scene";
import { useStore } from "../state";
import { copyText } from "./shell/Shell";
import { CloseIcon } from "./icons";

// Measure mode: hover highlights a face/edge/vertex, clicks pick up to two; exact facts come from the kernel

type V = [number, number, number];

export interface Hit {
  key: string; // instance key, or "part" in the part view
  part: string;
  ref: EntityRef;
}

interface MeasureState {
  on: boolean;
  hover?: Hit;
  picks: Hit[];
  result?: InspectResult;
  known: (EntityFacts | undefined)[]; // facts per pick kept while the next result is measured
  busy: boolean;
  error?: string;
  min: boolean; // card shown as a pill
  warming: boolean; // building exact shapes of parts shown from cache
}

export const useMeasure = create<MeasureState>(() => ({ on: false, picks: [], known: [], busy: false, min: false, warming: false }));

const same = (a?: Hit, b?: Hit) => !!a && !!b && a.key === b.key && a.ref.kind === b.ref.kind && a.ref.index === b.ref.index
  && (a.ref.kind !== "section" || a.ref.cut === b.ref.cut)
  && (a.ref.kind !== "vertex" || a.ref.near?.every((x, i) => Math.abs(x - b.ref.near![i]) < 1e-6) === true);

// Parts on screen; their shapes are built when measure mode starts so the first pick is quick
function visibleParts(): string[] {
  const { view, assembly, hidden } = useStore.getState();
  if (view.kind === "part") return [view.name];
  return [...new Set(assembly.instances.filter((i) => !hidden.has(i.key)).map((i) => i.part))];
}

export function toggleMeasure() {
  const { on } = useMeasure.getState();
  if (on) return useMeasure.setState({ on: false, hover: undefined, picks: [], known: [], result: undefined, error: undefined, busy: false });
  useMeasure.setState({ on: true, warming: true });
  engine.warmShapes(visibleParts()).finally(() => useMeasure.setState({ warming: false }));
}
export const clearPicks = () => useMeasure.setState({ picks: [], known: [], result: undefined, error: undefined, busy: false });

const instanceOf = (key: string): Instance | undefined =>
  key === "part" ? undefined : useStore.getState().assembly.instances.find((i) => (i as Instance & { key: string }).key === key);

// First click A, second B, then each click replaces B; clicking a pick again removes it; empty space clears
export function pick(hit: Hit | undefined) {
  const { picks, result } = useMeasure.getState();
  if (!hit) return clearPicks();
  const next = picks.some((p) => same(p, hit)) ? picks.filter((p) => !same(p, hit))
    : picks.length >= 2 ? [picks[0], hit] : [...picks, hit];
  const known = next.map((h) => result?.facts[picks.findIndex((p) => same(p, h))] ?? useMeasure.getState().known[picks.findIndex((p) => same(p, h))]);
  for (const p of next) pickedMesh.set(p.part, geometries.get(p.part));
  useMeasure.setState({ picks: next, known, result: undefined, busy: next.length > 0, error: undefined });
  measure();
}

// Section planes as the kernel takes them
const kernelCuts = () => cutPlanes.map((pl) => ({ normal: pl.normal.toArray() as V, constant: pl.constant }));

// Measures the current picks with the current section; one request at a time, the latest state wins
let inflight = false, again = false;
function measure() {
  if (inflight) {
    again = true;
    return;
  }
  const { picks } = useMeasure.getState();
  if (!picks.length) return;
  const items = picks.map((p) => {
    const inst = instanceOf(p.key);
    return { part: p.part, ref: p.ref, ...(inst ? { placement: { position: inst.position, rotation: inst.rotation } } : {}) };
  });
  inflight = true;
  engine.inspect(items, kernelCuts()).then(
    (result) => { if (useMeasure.getState().picks === picks) useMeasure.setState({ result, known: result.facts, busy: false, error: undefined }); },
    (e) => { if (useMeasure.getState().picks === picks) useMeasure.setState({ result: undefined, error: e instanceof Error ? e.message : String(e), busy: false }); },
  ).finally(() => {
    inflight = false;
    if (again) {
      again = false;
      measure();
    }
  });
}

// A picked part rebuilt: its indices may have changed; another view: the picks aren't shown
useStore.subscribe((s, prev) => {
  if (s.view !== prev.view && JSON.stringify(s.view) !== JSON.stringify(prev.view)) {
    useMeasure.setState({ hover: undefined });
    return clearPicks();
  }
  // Only a new mesh means a rebuild (building a cached part's shape for measuring doesn't change it)
  const { picks, hover } = useMeasure.getState();
  if (s.meshVersion === prev.meshVersion || (!picks.length && !hover)) return;
  if (hover) useMeasure.setState({ hover: undefined });
  if (picks.some((p) => geometries.get(p.part) !== pickedMesh.get(p.part))) clearPicks();
});

// Mesh of each picked part when it was picked
const pickedMesh = new Map<string, THREE.BufferGeometry | undefined>();

// ---- hit testing (registered by the viewport)

// Section planes in force: removed geometry can't be picked; measurements follow the section
let cutPlanes: THREE.Plane[] = [];
let cutsKey = "";
export function setPickPlanes(planes: THREE.Plane[]) {
  cutPlanes = planes;
  const key = JSON.stringify(planes.map((p) => [p.normal.toArray(), p.constant]));
  if (key === cutsKey) return;
  cutsKey = key;
  const { picks } = useMeasure.getState();
  if (!picks.length) return;
  // Section lines of a plane that's gone go with it
  const next = picks.filter((p) => p.ref.kind !== "section" || p.ref.cut! < planes.length);
  if (next.length !== picks.length) useMeasure.setState({ picks: next, known: [], result: undefined, busy: next.length > 0 });
  measure();
}

const kept = (p: THREE.Vector3) => cutPlanes.every((pl) => pl.distanceToPoint(p) >= -1e-3);

// Distance to the first visible surface along the ray: the section cap when the ray enters the material at a cut
function capDistance(ray: THREE.Ray, hit: THREE.Intersection) {
  const p = new THREE.Vector3();
  return Math.max(0, ...cutPlanes.map((pl) => (ray.intersectPlane(pl, p) ? ray.origin.distanceTo(p) : 0)).filter((d) => d <= hit.distance));
}
const backFacing = (ray: THREE.Ray, h: THREE.Intersection) =>
  !!h.face && h.face.normal.clone().transformDirection(h.object.matrixWorld).dot(ray.direction) > 0;

// The point you see under the ray, with the section applied (navigation pivots on it)
export function visiblePoint(ray: THREE.Raycaster, meshes: THREE.Object3D[]) {
  const hit = ray.intersectObjects(meshes, false).find((h) => kept(h.point));
  if (!hit) return undefined;
  return backFacing(ray.ray, hit) ? ray.ray.at(capDistance(ray.ray, hit), new THREE.Vector3()) : hit.point;
}

export function hitTest(ndc: THREE.Vector2, camera: THREE.Camera, root: THREE.Object3D, pixel: number, coarse: boolean): Hit | undefined {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const edgePx = coarse ? 12 : 6, vertexPx = coarse ? 14 : 8;
  ray.params.Line = { threshold: edgePx * pixel };
  const targets: THREE.Object3D[] = [];
  root.traverse((o) => o.userData.pick && o.visible && targets.push(o));
  const hits = ray.intersectObjects(targets, false).filter((h) => kept(h.point));
  let face = hits.find((h) => (h.object as THREE.Mesh).isMesh);
  let front = face?.distance ?? Infinity;
  // Seen from inside the material: the ray crossed a section cap first, which hides what's behind it
  if (face && backFacing(ray.ray, face)) {
    front = capDistance(ray.ray, face);
    face = undefined;
  }
  const edge = hits.find((h) => (h.object as THREE.LineSegments).isLineSegments && h.distance <= front + edgePx * pixel);
  if (edge && edge.index !== undefined) {
    const { part, key, cut } = edge.object.userData.pick as { part: string; key: string; cut?: number };
    // Section line: the face its segment's triangle belongs to
    if (cut !== undefined) {
      const tris = (edge.object as THREE.LineSegments).geometry.userData.segTris as Uint32Array | undefined;
      const fr = geometries.get(part)?.userData.faceRanges as Uint32Array | undefined;
      const index = tris && fr ? rangeIndex(fr, tris[edge.index >> 1] * 3) : -1;
      const on = (edge as THREE.Intersection & { pointOnLine?: THREE.Vector3 }).pointOnLine ?? edge.point;
      return index >= 0 ? { key, part, ref: { kind: "section", index, cut, near: on.toArray() as V } } : undefined;
    }
    const ranges = edgeGeometries.get(part)?.userData.edgeRanges as Uint32Array | undefined;
    if (ranges) {
      const index = rangeIndex(ranges, edge.index);
      // Near an end of the edge: its vertex
      const pos = (edge.object as THREE.LineSegments).geometry.getAttribute("position");
      const ends = [ranges[2 * index], ranges[2 * index] + ranges[2 * index + 1] - 1].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
      const on = (edge as THREE.Intersection & { pointOnLine?: THREE.Vector3 }).pointOnLine ?? edge.point;
      for (const local of ends) {
        if (local.clone().applyMatrix4(edge.object.matrixWorld).distanceTo(on) < vertexPx * pixel) {
          return { key, part, ref: { kind: "vertex", index: -1, near: local.toArray() as V } };
        }
      }
      if (index >= 0) return { key, part, ref: { kind: "edge", index } };
    }
  }
  if (face && face.faceIndex !== undefined && face.faceIndex !== null) {
    const { part, key } = face.object.userData.pick as { part: string; key: string };
    const ranges = geometries.get(part)?.userData.faceRanges as Uint32Array | undefined;
    const index = ranges ? rangeIndex(ranges, face.faceIndex * 3) : -1;
    if (index >= 0) return { key, part, ref: { kind: "face", index } };
  }
}

// ---- highlights (inside the viewport's scene)

const COLORS = { hover: "#2f6fde", a: "#e8590c", b: "#2b8a3e" };

// A dot of constant screen size (5 px radius) at any zoom
function VertexDot({ at, color, clip }: { at: V; color: string; clip: THREE.Plane[] }) {
  const ref = useRef<THREE.Mesh>(null);
  const p = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const m = ref.current;
    if (!m) return;
    m.getWorldPosition(p);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 40;
    const perPx = (2 * camera.position.distanceTo(p) * Math.tan((fov * Math.PI) / 360)) / size.height;
    // Undo the instance's scale (none today) so the radius stays in pixels
    m.scale.setScalar((5 * perPx) / (m.parent?.getWorldScale(new THREE.Vector3()).x ?? 1));
  });
  return (
    <mesh ref={ref} position={at} renderOrder={2_000_002}>
      <sphereGeometry args={[1, 16, 12]} />
      <meshBasicMaterial color={color} depthTest={false} clippingPlanes={clip} />
    </mesh>
  );
}

function Highlight({ hit, color, clip }: { hit: Hit; color: string; clip: THREE.Plane[] }) {
  const inst = instanceOf(hit.key);
  const geom = geometries.get(hit.part), edges = edgeGeometries.get(hit.part);
  const sub = useMemo(() => {
    if (hit.ref.kind === "face" && geom?.index) {
      const r = geom.userData.faceRanges as Uint32Array | undefined;
      if (!r) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", geom.getAttribute("position"));
      g.setAttribute("normal", geom.getAttribute("normal"));
      const idx = geom.index.array as Uint32Array;
      g.setIndex(new THREE.BufferAttribute(idx.subarray(r[2 * hit.ref.index], r[2 * hit.ref.index] + r[2 * hit.ref.index + 1]), 1));
      return { face: g };
    }
    // Section line: the picked face's triangles sliced by the plane, in part coordinates
    if (hit.ref.kind === "section" && geom?.index && clip[hit.ref.cut!]) {
      const r = geom.userData.faceRanges as Uint32Array | undefined;
      if (!r) return;
      const o = new THREE.Object3D();
      if (inst) applyPlacement(o, inst);
      o.updateMatrix();
      const local = clip[hit.ref.cut!].clone().applyMatrix4(o.matrix.clone().invert());
      const idx = (geom.index.array as Uint32Array).subarray(r[2 * hit.ref.index], r[2 * hit.ref.index] + r[2 * hit.ref.index + 1]);
      const seg = sliceMesh(geom.getAttribute("position").array, idx, local);
      const pts: V[] = [];
      for (let i = 0; i + 2 < seg.length; i += 3) pts.push([seg[i], seg[i + 1], seg[i + 2]]);
      return pts.length ? { line: pts, others: clip.filter((_, i) => i !== hit.ref.cut) } : undefined;
    }
    if (hit.ref.kind === "edge" && edges) {
      const r = edges.userData.edgeRanges as Uint32Array | undefined;
      if (!r) return;
      const p = edges.getAttribute("position").array as Float32Array;
      const s = r[2 * hit.ref.index], n = r[2 * hit.ref.index + 1];
      const pts: V[] = [];
      for (let i = s; i < s + n; i++) pts.push([p[3 * i], p[3 * i + 1], p[3 * i + 2]]);
      return { line: pts };
    }
  }, [geom, edges, hit.ref.kind, hit.ref.index, hit.ref.cut, clip, inst]);
  useEffect(() => () => sub?.face?.dispose(), [sub]);
  return (
    <group ref={(o) => o && inst && applyPlacement(o, inst)}>
      {sub?.face && (
        <mesh geometry={sub.face} renderOrder={2_000_000}>
          <meshBasicMaterial color={color} transparent opacity={0.45} depthTest polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} clippingPlanes={clip} side={THREE.DoubleSide} />
        </mesh>
      )}
      {sub?.line && <Line points={sub.line} segments color={color} lineWidth={3.5} depthTest={false} renderOrder={2_000_001} clippingPlanes={"others" in sub ? sub.others : clip} />}
      {hit.ref.kind === "vertex" && hit.ref.near && (
        <VertexDot at={hit.ref.near} color={color} clip={clip} />
      )}
    </group>
  );
}

export function MeasureOverlay({ clip }: { clip: THREE.Plane[] }) {
  const { on, hover, picks } = useMeasure();
  useStore((s) => s.meshVersion);
  if (!on) return null;
  return (
    <>
      {picks.map((p, i) => <Highlight key={`p${i}`} hit={p} color={i === 0 ? COLORS.a : COLORS.b} clip={clip} />)}
      {hover && !picks.some((p) => same(p, hover)) && <Highlight hit={hover} color={COLORS.hover} clip={clip} />}
    </>
  );
}

// ---- pointer handling on the viewport element

export function useMeasurePointer(node: HTMLElement, hitAt: (x: number, y: number) => Hit | undefined) {
  const on = useMeasure((s) => s.on);
  const down = useRef<{ x: number; y: number }>(undefined);
  useEffect(() => {
    if (!on) return;
    let frame = 0;
    let hoverAt: [number, number] | undefined;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const h = hitAt(e.clientX, e.clientY);
        hoverAt = [e.clientX, e.clientY];
        if (!same(h, useMeasure.getState().hover)) useMeasure.setState({ hover: h });
      });
    };
    const press = (e: PointerEvent) => (down.current = { x: e.clientX, y: e.clientY });
    const release = (e: PointerEvent) => {
      const d = down.current;
      down.current = undefined;
      // A drag orbits the camera; only a click picks
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      // What's highlighted is what gets picked, when it was found right here
      const fresh = hoverAt && Math.hypot(e.clientX - hoverAt[0], e.clientY - hoverAt[1]) < 1;
      pick((fresh && useMeasure.getState().hover) || hitAt(e.clientX, e.clientY));
    };
    const leave = () => useMeasure.setState({ hover: undefined });
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerdown", press);
    node.addEventListener("pointerup", release);
    node.addEventListener("pointerleave", leave);
    node.style.cursor = "crosshair";
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerdown", press);
      node.removeEventListener("pointerup", release);
      node.removeEventListener("pointerleave", leave);
      node.style.cursor = "";
    };
  }, [on, node, hitAt]);
}

// ---- results card: the answer first, then one line per pick (click to expand), then a hint

const DOT = [COLORS.a, COLORS.b];
const LETTER = ["A", "B"];

const Chevron = ({ up }: { up?: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden style={{ transform: up ? "rotate(180deg)" : undefined }}>
    <path d="M2 4l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.6" />
  </svg>
);
const CopyIcon = ({ done }: { done: boolean }) => done ? (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><path d="M3 8.5l3 3 7-7" /></svg>
) : (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
);

// Copied key flashes for 1.2 s
function useCopied() {
  const [copied, setCopied] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (key: string, text: string) => {
    void copyText(text);
    clearTimeout(timer.current);
    setCopied(key);
    timer.current = setTimeout(() => setCopied(undefined), 1200);
  };
  return { copied, copy };
}

function Value({ r }: { r: Row }) {
  return r.vec
    ? <><span className="vec">{r.vec.map((c, i) => <span key={i}>{c}</span>)}</span>{r.u && <span className="u">{r.u}</span>}</>
    : <><span>{r.v}</span>{r.u && <span className="u">{r.u}</span>}</>;
}

function Rows({ rows, id, copied, copy }: { rows: Row[]; id: string; copied?: string; copy: (k: string, t: string) => void }) {
  return rows.map((r) => {
    const k = `${id}:${r.label}`, done = copied === k;
    return (
      <div key={r.label} className={`mc-row${done ? " copied" : ""}`} data-row={r.label}>
        <span className="l">{done ? "Copied" : r.label}</span>
        <button className="v" title={`Copy ${r.full}`} onClick={() => copy(k, r.full)}><Value r={r} /></button>
        <button className="btn btn-ghost btn-icon btn-sm ic" aria-label={`Copy ${r.label}`} onClick={() => copy(k, r.full)}><CopyIcon done={done} /></button>
      </div>
    );
  });
}

export function MeasureCard({ sheet = false }: { sheet?: boolean }) {
  const { on, hover, picks, result, known, busy, error, min, warming } = useMeasure();
  const { copied, copy } = useCopied();
  const [open, setOpen] = useState<number>();
  useEffect(() => setOpen(undefined), [picks]);
  if (!on) return null;
  const target = (h: Hit) => (h.key === "part" ? h.part : h.key);
  const facts = picks.map((_, i) => result?.facts[i] ?? known[i]);
  const views = facts.map((f) => (f ? pickView(f) : undefined));
  const single = picks.length === 1 && views[0] && views[0].facts.length > 0;
  // The answer: the pair, or the single pick's main value
  const res = result?.pair ? { ...pairView(result.pair), dots: DOT }
    : single && !busy && !error ? { main: views[0]!.facts[0], note: "", rows: views[0]!.facts.slice(1), dots: [DOT[0]] } : undefined;
  const status = busy ? (warming ? "Preparing exact geometry…" : "Measuring…") : error ? "Error"
    : picks.length ? `${picks.length} ${picks.length > 1 ? "picks" : "pick"}` : warming ? "Preparing exact geometry…" : "";
  const hint = error ? "Esc clears"
    : !picks.length ? (sheet ? "Tap the model to pick" : "M turns measure off")
    : picks.length === 1 ? (sheet ? "Tap another to measure between" : "Pick another to measure between · Esc clears")
    : sheet ? "Tap again to replace B" : "Click again to replace B · Esc clears";
  const minimise = () => useMeasure.setState({ min: !min });

  if (min) {
    return (
      <button className={`measure-pill${sheet ? " sheet" : ""}`} data-testid="measure-pill" title="Show measure card" onClick={minimise}
        data-hover={hover ? refString(target(hover), hover.ref) : ""}>
        {res && <span className="dots">{res.dots.map((c) => <span key={c} style={{ background: c }} />)}</span>}
        <span className="l">{res ? res.main.label : "Measure"}</span>
        {res && <><span className="v">{res.main.v}</span><span className="u">{res.main.u}</span></>}
        <Chevron up={!sheet} />
      </button>
    );
  }

  const resKey = "res";
  return (
    <div className={`measure-card${sheet ? " sheet" : ""}`} data-testid="measure-card" aria-live="polite"
      data-hover={hover ? refString(target(hover), hover.ref) : ""} data-hover-kind={hover?.ref.kind ?? ""}>
      {sheet && <span className="grab" />}
      <div className="mc-head">
        <b>Measure</b>
        <span className={`st${error ? " err" : ""}`}>{status}</span>
        <span className="spacer" />
        <div className={`btn-cluster ${sheet ? "btn-lg" : "btn-sm"}`}>
          {picks.length > 0 && <button className="btn btn-ghost" title="Clear picks (Esc)" onClick={clearPicks}>Clear</button>}
          <button className="btn btn-ghost btn-icon" aria-label="Minimise" title="Minimise" onClick={minimise}><Chevron up={!sheet} /></button>
          <button className="btn btn-ghost btn-icon" aria-label="Close measure" title="Close measure (M)" onClick={toggleMeasure}><CloseIcon /></button>
        </div>
      </div>

      {!picks.length && (
        <div className="mc-empty">
          <b>Click a face, edge or vertex</b>
          <span>Pick a second one to measure between them.</span>
        </div>
      )}

      {res && (
        <div className="mc-res" data-testid="measure-result">
          <div className="top">
            <span className="dots">{res.dots.map((c) => <span key={c} style={{ background: c }} />)}</span>
            <span className={`l${copied === resKey ? " copied" : ""}`}>{copied === resKey ? "Copied" : res.main.label}</span>
            <span className="spacer" />
            <span className="note">{res.note}</span>
          </div>
          <div className="main">
            <button className="big" title={`Copy ${res.main.full}`} onClick={() => copy(resKey, res.main.full)} data-testid="measure-main">
              <span className="v">{res.main.v}</span><span className="u">{res.main.u}</span>
            </button>
            <span className="spacer" />
            <button className="btn btn-ghost btn-icon btn-sm ic" aria-label="Copy" onClick={() => copy(resKey, res.main.full)}><CopyIcon done={copied === resKey} /></button>
          </div>
          <Rows rows={res.rows} id="res" copied={copied} copy={copy} />
        </div>
      )}

      {busy && !res && (
        <div className="mc-busy">
          <div className="top"><span className="dots">{picks.map((_, i) => <span key={i} style={{ background: DOT[i] }} />)}</span><b>Measuring…</b></div>
          <span className="sk" /><span className="sk sm" />
        </div>
      )}

      {error && (
        <div className="mc-err" role="alert">
          <b>Can't measure</b>
          <span>{error}</span>
          <span className="sub">Ask your agent to fix it, then pick again.</span>
        </div>
      )}

      {picks.length > 0 && (
        <div className="mc-picks">
          {picks.map((h, i) => {
            const v = views[i];
            // Where it is: the part or instance path
            const path = target(h);
            const shown = h.ref.kind === "section" ? `section · ${shortRef(path, sheet ? 30 : 22)}` : shortRef(path, sheet ? 40 : 32);
            const isOpen = open === i && !!v;
            const rows = v ? (single ? v.details : [...v.facts, ...v.details]) : [];
            return (
              <div key={i} className="mc-pick" data-pick={i === 0 ? "a" : "b"}>
                <button className="head" aria-expanded={isOpen} onClick={() => v && setOpen(isOpen ? undefined : i)}>
                  <span className="badge" style={{ background: DOT[i] }}>{LETTER[i]}</span>
                  <span className="type" data-testid={`measure-type-${i === 0 ? "a" : "b"}`}>{v ? v.type : error ? facts[i]?.label ?? "Pick" : "Measuring…"}</span>
                  <span className={`key${error && !v ? " err" : ""}`} title={v?.key} data-testid={`measure-key-${i === 0 ? "a" : "b"}`}>{v ? v.key : error ? "Unavailable" : ""}</span>
                  {v?.clipped && <span className="cut" title="Measured on what the section leaves">cut</span>}
                  {v && rows.length > 0 && <Chevron up={isOpen} />}
                </button>
                <span className="ref" title={path}>{shown}</span>
                {isOpen && <div className="rows"><Rows rows={rows} id={`p${i}`} copied={copied} copy={copy} /></div>}
              </div>
            );
          })}
        </div>
      )}

      <div className="mc-hint">{hint}</div>
    </div>
  );
}
