import * as replicad from "replicad";

// Exact measurements on B-rep entities (faces, edges, vertices) of a built part, optionally placed as an assembly
// instance. Values in mm and degrees; vectors in world coordinates.

type V = [number, number, number];
type Shape3D = replicad.Shape3D;

export interface Placement {
  position: V;
  rotation: V; // XYZ Euler degrees (three.js order)
}

export interface EntityRef {
  // section: where cut plane `cut` meets face `index`
  kind: "face" | "edge" | "vertex" | "section";
  index: number;
  // Vertices picked in the viewer: index -1 and a position in part coordinates; the nearest vertex is used.
  // Sections: a world point on the picked line
  near?: V;
  cut?: number;
}

// Section plane in world space: keeps the side where normal·p + constant ≥ 0
export interface Cut {
  normal: V;
  constant: number;
}

export interface EntityFacts {
  kind: EntityRef["kind"];
  index: number;
  type: string; // PLANE, CYLINDER, CONE, SPHERE, TORUS, BSPLINE…; LINE, CIRCLE, ELLIPSE…; POINT
  label: string; // Plane, Cylinder, Fillet, Line, Arc, Circle…
  length?: number;
  area?: number;
  radius?: number;
  diameter?: number;
  radii?: [number, number]; // ellipse major/minor; torus tube/ring
  center?: V;
  axis?: V;
  normal?: V;
  direction?: V;
  arcAngle?: number;
  halfAngle?: number;
  concave?: boolean; // cylinders: a hole (true) or a boss (false)
  fillet?: boolean;
  position?: V;
  size?: V; // world bounding box extents
  clipped?: boolean; // measured on the part a section leaves
}

export interface PairFacts {
  distance: number;
  points: [V, V];
  angle?: number;
  centerDistance?: number;
  axisOffset?: number;
  delta?: V;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
const rv = (v: V): V => [r6(v[0]), r6(v[1]), r6(v[2])];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => { const l = len(a); return l ? mul(a, 1 / l) : a; };
const DEG = 180 / Math.PI;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xyz = (p: any): V => (typeof p.X === "function" ? [p.X(), p.Y(), p.Z()] : Array.isArray(p) ? [p[0], p[1], p[2]] : [p.x, p.y, p.z]);
const oc = () => replicad.getOC();

// Placement as rotation (Rz then Ry then Rx about the origin) and translation, like STEP export and three.js
function placeShape<T extends { rotate(a: number, c: V, d: V): T; translate(v: V): T }>(s: T, p?: Placement): T {
  if (!p) return s;
  const [rx, ry, rz] = p.rotation;
  let o = s;
  if (rz) o = o.rotate(rz, [0, 0, 0], [0, 0, 1]);
  if (ry) o = o.rotate(ry, [0, 0, 0], [0, 1, 0]);
  if (rx) o = o.rotate(rx, [0, 0, 0], [1, 0, 0]);
  if (p.position.some((x) => x)) o = o.translate(p.position);
  return o;
}

const vertices = (shape: Shape3D): replicad.Vertex[] =>
  Array.from(replicad.iterTopo(shape.wrapped, "vertex"), (v) => new replicad.Vertex(v as never));

// The entity, placed; throws on an index out of range
export function entityOf(shape: Shape3D, ref: EntityRef, p?: Placement): replicad.Face | replicad.Edge | replicad.Vertex {
  const list = ref.kind === "face" ? shape.faces : ref.kind === "edge" ? shape.edges : vertices(shape);
  const e = list[resolveIndex(shape, ref)];
  if (!e) throw new Error(`No ${ref.kind} ${ref.index} (the part has ${list.length})`);
  return placeShape(e as never, p);
}

// Index of the entity; a vertex given by position resolves to the nearest one
export function resolveIndex(shape: Shape3D, ref: EntityRef): number {
  if (ref.kind !== "vertex" || ref.index >= 0 || !ref.near) return ref.index;
  let best = -1, bestD = Infinity;
  vertices(shape).forEach((v, i) => {
    const d = len(sub(xyz(oc().BRep_Tool.Pnt(v.wrapped)), ref.near!));
    if (d < bestD) [best, bestD] = [i, d];
  });
  return best;
}

// "BSPLINE_SURFACE" → "B-spline surface"
const pretty = (t: string) => (t[0] + t.slice(1).toLowerCase()).replace(/_/g, " ").replace(/^Bspline/, "B-spline").replace(/^Bezier/, "Bézier");

const SURFACE: Record<string, string> = { PLANE: "PLANE", CYLINDRE: "CYLINDER", CONE: "CONE", SPHERE: "SPHERE", TORUS: "TORUS" };

// Unit outward normal and point at the face's UV centre (respects face orientation)
function midNormal(face: replicad.Face): { point: V; normal: V } {
  const point = xyz(face.pointOnSurface(0.5, 0.5));
  return { point, normal: unit(xyz(face.normalAt(face.pointOnSurface(0.5, 0.5)))) };
}

// Principal curvature magnitudes at a UV point, from the fundamental forms
function curvatures(face: replicad.Face, u: number, v: number): [number, number] {
  const s = new (oc().BRepAdaptor_Surface)(face.wrapped, true);
  try {
    const { uMin, uMax, vMin, vMax } = face.UVBounds;
    const d = s.EvalD2(uMin + u * (uMax - uMin), vMin + v * (vMax - vMin));
    const Su = xyz(d.D1U), Sv = xyz(d.D1V), Suu = xyz(d.D2U), Svv = xyz(d.D2V), Suv = xyz(d.D2UV);
    const n = unit(cross(Su, Sv));
    const E = dot(Su, Su), F = dot(Su, Sv), G = dot(Sv, Sv), L = dot(Suu, n), M = dot(Suv, n), N = dot(Svv, n);
    const den = E * G - F * F;
    const K = (L * N - M * M) / den, H = (E * N - 2 * F * M + G * L) / (2 * den);
    const q = Math.sqrt(Math.max(0, H * H - K));
    const [a, b] = [Math.abs(H + q), Math.abs(H - q)];
    return a >= b ? [a, b] : [b, a];
  } finally {
    s.delete();
  }
}

// Circle through three points (centre, radius)
function circle3(a: V, b: V, c: V): { center: V; radius: number } {
  const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac);
  const d = 2 * dot(n, n);
  const center = add(a, mul(add(mul(cross(n, ab), dot(ac, ac)), mul(cross(ac, n), dot(ab, ab))), 1 / d));
  return { center, radius: len(sub(a, center)) };
}

// Faces meeting this one tangentially along its edges (fillets blend at least two)
function tangentNeighbours(shape: Shape3D, faceIndex: number): number {
  const faces = shape.faces;
  const face = faces[faceIndex];
  let n = 0;
  for (const e of face.edges) {
    const other = faces.findIndex((f, i) => i !== faceIndex && f.edges.some((x) => x.wrapped.IsSame(e.wrapped)));
    if (other < 0) continue;
    const p = e.pointAt(0.5);
    const a = unit(xyz(face.normalAt(p))), b = unit(xyz(faces[other].normalAt(p)));
    if (Math.abs(dot(a, b)) > Math.cos(1 / DEG)) n++;
  }
  return n;
}

// ---- sections: entities clipped to the kept side of the cut planes

function bounds(s: replicad.AnyShape["wrapped"]): { lo: V; hi: V } | undefined {
  const b = new (oc().Bnd_Box)();
  try {
    oc().BRepBndLib.Add(s, b, false);
    if (b.IsVoid()) return;
    return { lo: xyz(b.CornerMin()), hi: xyz(b.CornerMax()) };
  } finally {
    b.delete();
  }
}

const corners = ({ lo, hi }: { lo: V; hi: V }): V[] =>
  [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);

// Box on the kept side of a plane, large enough to cover the region around `at`
function keptBox(c: Cut, at: V, size: number) {
  const n = unit(c.normal);
  const p0 = sub(at, mul(n, dot(n, at) + c.constant / len(c.normal)));
  const x = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), y = cross(n, x);
  const o = sub(sub(p0, mul(x, size / 2)), mul(y, size / 2));
  const ax = new (oc().gp_Ax2)(new (oc().gp_Pnt)(...o), new (oc().gp_Dir)(...n), new (oc().gp_Dir)(...x));
  const mk = new (oc().BRepPrimAPI_MakeBox)(ax, size, size, size);
  const box = mk.Shape();
  mk.delete();
  ax.delete();
  return box;
}

// The part of a placed entity left by the cuts: the same shape when untouched, undefined when all removed
function clipTo<T extends replicad.AnyShape>(e: T, cuts: Cut[]): replicad.AnyShape | undefined {
  let s: replicad.AnyShape = e;
  for (const c of cuts) {
    const b = bounds(s.wrapped);
    if (!b) return;
    const d = corners(b).map((p) => (dot(c.normal, p) + c.constant) / len(c.normal));
    if (Math.min(...d) >= -1e-7) continue;
    if (Math.max(...d) <= 1e-7) return;
    const size = 4 * len(sub(b.hi, b.lo)) + 10;
    const box = keptBox(c, mul(add(b.lo, b.hi), 0.5), size);
    const op = new (oc().BRepAlgoAPI_Common)(s.wrapped, box);
    try {
      const r = replicad.cast(op.Shape());
      if (!bounds(r.wrapped)) return;
      s = r;
    } finally {
      op.delete();
    }
  }
  return s;
}

// Length/area/arc of what's left of an entity; throws when a section removed all of it
function applyClip(f: EntityFacts, e: replicad.AnyShape, cuts: Cut[] | undefined): replicad.AnyShape {
  if (!cuts?.length) return e;
  const c = clipTo(e, cuts);
  if (!c) throw new Error(`The section removes ${f.kind} ${f.index}`);
  if (c === e) return e;
  f.clipped = true;
  if (f.area !== undefined) f.area = r6(replicad.measureArea(c as never));
  if (f.length !== undefined) {
    f.length = r6(replicad.measureLength(c as never));
    if (f.radius !== undefined && f.arcAngle !== undefined) {
      f.arcAngle = r6((f.length / f.radius) * DEG);
      if (f.label === "Circle") f.label = "Arc";
    }
  }
  const b = bounds(c.wrapped);
  if (b) f.size = rv(sub(b.hi, b.lo));
  return c;
}

const sizeOf = (e: replicad.AnyShape): V | undefined => {
  const b = bounds(e.wrapped);
  return b && rv(sub(b.hi, b.lo));
};

function faceFacts(shape: Shape3D, index: number, p?: Placement): EntityFacts {
  const face = entityOf(shape, { kind: "face", index }, p) as replicad.Face;
  const type = SURFACE[face.geomType] ?? face.geomType;
  const f: EntityFacts = { kind: "face", index, type, label: pretty(type), area: r6(replicad.measureArea(face)) };
  const s = new (oc().BRepAdaptor_Surface)(face.wrapped, true);
  try {
    if (type === "PLANE") {
      f.normal = rv(midNormal(face).normal);
      f.center = rv(xyz(face.center));
    } else if (type === "CYLINDER") {
      const c = s.Cylinder();
      const axis = unit(xyz(c.Axis().Direction())), loc = xyz(c.Axis().Location());
      const { point, normal } = midNormal(face);
      const along = dot(sub(point, loc), axis);
      const foot = add(loc, mul(axis, along));
      f.radius = r6(c.Radius());
      f.diameter = r6(2 * c.Radius());
      f.axis = rv(axis);
      // Axis point level with the face's middle
      f.center = rv(add(loc, mul(axis, dot(sub(xyz(face.center), loc), axis))));
      f.concave = dot(normal, sub(point, foot)) < 0;
    } else if (type === "SPHERE") {
      const sp = s.Sphere();
      f.radius = r6(sp.Radius());
      f.diameter = r6(2 * sp.Radius());
      f.center = rv(xyz(sp.Location()));
    } else if (type === "TORUS") {
      // V is the angle around the tube: the tube centre is P + d²S/dv², the tube radius |dS/dv|;
      // the ring radius is the circle through three tube centres along U
      const { uMin, uMax, vMin, vMax } = face.UVBounds;
      const v = (vMin + vMax) / 2;
      const at = [0.2, 0.5, 0.8].map((t) => {
        const d = s.EvalD2(uMin + t * (uMax - uMin), v);
        return { c: add(xyz(d.Point), xyz(d.D2V)), tube: len(xyz(d.D1V)) };
      });
      const ring = circle3(at[0].c, at[1].c, at[2].c);
      f.radius = r6(at[1].tube);
      f.radii = [r6(at[1].tube), r6(ring.radius)];
      f.center = rv(ring.center);
    } else if (type === "CONE") {
      const ns = [0.1, 0.43, 0.76].map((u) => unit(xyz(face.normalAt(face.pointOnSurface(u, 0.5)))));
      const axis = unit(cross(sub(ns[1], ns[0]), sub(ns[2], ns[0])));
      f.axis = rv(axis);
      f.halfAngle = r6(Math.asin(Math.min(1, Math.abs(dot(ns[0], axis)))) * DEG);
    } else {
      // Freeform: smallest radius of curvature at the middle
      const [k] = curvatures(face, 0.5, 0.5);
      if (k > 1e-9) f.radius = r6(1 / k);
    }
  } finally {
    s.delete();
  }
  if ((type === "CYLINDER" || type === "TORUS") && tangentNeighbours(shape, index) >= 2) {
    f.fillet = true;
    f.label = "Fillet";
  }
  return f;
}

function edgeFacts(shape: Shape3D, index: number, p?: Placement): EntityFacts {
  return edgeFactsOf(entityOf(shape, { kind: "edge", index }, p) as replicad.Edge, index);
}

function edgeFactsOf(edge: replicad.Edge, index: number): EntityFacts {
  const type = edge.geomType;
  const f: EntityFacts = { kind: "edge", index, type, label: pretty(type), length: r6(replicad.measureLength(edge)) };
  const c = new (oc().BRepAdaptor_Curve)(edge.wrapped);
  try {
    if (type === "LINE") {
      f.direction = rv(unit(sub(xyz(edge.endPoint), xyz(edge.startPoint))));
    } else if (type === "CIRCLE") {
      const ci = c.Circle();
      const arc = Math.abs(c.LastParameter() - c.FirstParameter()) * DEG;
      f.radius = r6(ci.Radius());
      f.diameter = r6(2 * ci.Radius());
      f.center = rv(xyz(ci.Location()));
      f.axis = rv(unit(xyz(ci.Axis().Direction())));
      f.arcAngle = r6(arc);
      f.label = arc > 359.999 ? "Circle" : "Arc";
    } else if (type === "ELLIPSE") {
      const el = c.Ellipse();
      f.radii = [r6(el.MajorRadius()), r6(el.MinorRadius())];
      f.center = rv(xyz(el.Location()));
    }
  } finally {
    c.delete();
  }
  return f;
}

// Where cut plane ref.cut meets the placed face: the piece nearest the picked point
function sectionEdge(shape: Shape3D, ref: EntityRef, p: Placement | undefined, cuts: Cut[] | undefined): replicad.Edge {
  const c = cuts?.[ref.cut ?? -1];
  if (!c) throw new Error("That section plane is no longer active");
  const face = entityOf(shape, { kind: "face", index: ref.index }, p);
  const pln = new (oc().gp_Pln)(c.normal[0], c.normal[1], c.normal[2], c.constant);
  const op = new (oc().BRepAlgoAPI_Section)(face.wrapped, pln, true);
  try {
    const edges = Array.from(replicad.iterTopo(op.Shape(), "edge"), (e) => new replicad.Edge(oc().TopoDS.Edge(e)));
    if (!edges.length) throw new Error(`The section doesn't cross face ${ref.index}`);
    if (edges.length === 1 || !ref.near) return edges[0];
    const mv = new (oc().BRepBuilderAPI_MakeVertex)(new (oc().gp_Pnt)(...ref.near));
    const at = mv.Vertex();
    let best = edges[0], bestD = Infinity;
    for (const e of edges) {
      const d = new (oc().BRepExtrema_DistShapeShape)(e.wrapped, at);
      d.Perform();
      if (d.Value() < bestD) [best, bestD] = [e, d.Value()];
      d.delete();
    }
    mv.delete();
    return best;
  } finally {
    op.delete();
    pln.delete();
  }
}

// Facts and the geometry they describe, both limited to what the cut planes leave
function measured(shape: Shape3D, ref: EntityRef, p?: Placement, cuts?: Cut[]): { facts: EntityFacts; geom: replicad.AnyShape } {
  if (ref.kind === "section") {
    const edge = sectionEdge(shape, ref, p, cuts);
    const f = { ...edgeFactsOf(edge, ref.index), kind: "section" as const };
    f.label = `Section ${f.label.toLowerCase()}`;
    f.size = sizeOf(edge);
    const geom = applyClip(f, edge, cuts!.filter((_, i) => i !== ref.cut));
    return { facts: f, geom };
  }
  if (ref.kind === "vertex") {
    const v = entityOf(shape, ref, p) as replicad.Vertex;
    const f: EntityFacts = { kind: "vertex", index: resolveIndex(shape, ref), type: "POINT", label: "Point", position: rv(xyz(oc().BRep_Tool.Pnt(v.wrapped))) };
    return { facts: f, geom: v };
  }
  const f = ref.kind === "face" ? faceFacts(shape, ref.index, p) : edgeFacts(shape, ref.index, p);
  const e = entityOf(shape, ref, p);
  f.size = sizeOf(e);
  return { facts: f, geom: applyClip(f, e, cuts) };
}

export function entityFacts(shape: Shape3D, ref: EntityRef, p?: Placement, cuts?: Cut[]): EntityFacts {
  return measured(shape, ref, p, cuts).facts;
}

// Line through a point along a unit direction: closest distance between two such lines
function lineOffset(p1: V, d1: V, p2: V, d2: V): number {
  const n = cross(d1, d2);
  if (len(n) < 1e-9) return len(cross(sub(p2, p1), d1));
  return Math.abs(dot(sub(p2, p1), unit(n)));
}

export interface Picked {
  shape: Shape3D;
  ref: EntityRef;
  placement?: Placement;
}

export function pairFacts(a: Picked, b: Picked, cuts?: Cut[]): { a: EntityFacts; b: EntityFacts; pair: PairFacts } {
  const ma = measured(a.shape, a.ref, a.placement, cuts), mb = measured(b.shape, b.ref, b.placement, cuts);
  const [fa, fb, ea, eb] = [ma.facts, mb.facts, ma.geom, mb.geom];
  const d = new (oc().BRepExtrema_DistShapeShape)(ea.wrapped, eb.wrapped);
  let pair: PairFacts;
  try {
    d.Perform();
    pair = { distance: r6(d.Value()), points: [rv(xyz(d.PointOnShape1(1))), rv(xyz(d.PointOnShape2(1)))] };
  } finally {
    d.delete();
  }
  // Angle between planes and/or straight lines, folded to 0–90°
  const dirOf = (f: EntityFacts) => (f.type === "PLANE" ? f.normal : f.type === "LINE" ? f.direction : undefined);
  const [da, db] = [dirOf(fa), dirOf(fb)];
  if (da && db) {
    const c = Math.min(1, Math.abs(dot(da, db)));
    const mixed = (fa.type === "PLANE") !== (fb.type === "PLANE");
    pair.angle = r6(mixed ? 90 - Math.acos(c) * DEG : Math.acos(c) * DEG);
  }
  // Circles and cylinders: centre to centre, and the offset between their axes
  const round = (f: EntityFacts) => f.center && f.axis && (f.type === "CYLINDER" || f.type === "CIRCLE");
  if (round(fa) && round(fb)) {
    pair.centerDistance = r6(len(sub(fb.center!, fa.center!)));
    pair.axisOffset = r6(lineOffset(fa.center!, fa.axis!, fb.center!, fb.axis!));
  }
  if (fa.kind === "vertex" && fb.kind === "vertex") pair.delta = rv(sub(fb.position!, fa.position!));
  return { a: fa, b: fb, pair };
}

// Every face and edge of a part (agent summaries)
export function allFacts(shape: Shape3D): { faces: EntityFacts[]; edges: EntityFacts[] } {
  return {
    faces: shape.faces.map((_, i) => faceFacts(shape, i)),
    edges: shape.edges.map((_, i) => edgeFacts(shape, i)),
  };
}
