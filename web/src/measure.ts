import type { EntityFacts, EntityRef, PairFacts } from "./kernel/inspect";

// References ("plate:F7", "Left leg/thigh:E3") and part summaries for the measure tools

const KIND = { F: "face", E: "edge", V: "vertex" } as const;
const LETTER = { face: "F", edge: "E", vertex: "V", section: "F" } as const;

export function parseRef(ref: string): { target: string; ref: EntityRef } {
  const m = ref.trim().match(/^(.+):([FEV])(\d+)$/);
  if (!m) throw new Error(`Bad reference "${ref}": use part:F3, part:E12, part:V4 or <instance key>:F3`);
  return { target: m[1], ref: { kind: KIND[m[2] as keyof typeof KIND], index: Number(m[3]) } };
}

export const refString = (target: string, ref: EntityRef) => `${target}:${LETTER[ref.kind]}${ref.index}`;

const featureType = (f: EntityFacts) =>
  f.fillet ? "fillet" : f.type === "CYLINDER" ? (f.concave ? "hole" : "boss") : f.label.toLowerCase();

export interface PartSummary {
  faces: Record<string, number>;
  edges: Record<string, number>;
  diameters: string[];
  fillets: string[];
  planes: { ref: string; normal: number[]; area: number }[];
  features: (EntityFacts & { ref: string; feature: string })[];
  total: number;
  note: string;
}

const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const mm = (v: number) => (Math.round(v * 1000) / 1000).toString();

export function summarizePart(part: string, all: { faces: EntityFacts[]; edges: EntityFacts[] },
  filter: { type?: string; minRadius?: number; maxRadius?: number; limit?: number } = {}): PartSummary {
  const cyl = all.faces.filter((f) => f.type === "CYLINDER" && !f.fillet);
  const diameters = Object.entries(count(cyl.map((f) => `Ø${mm(f.diameter!)} (${f.concave ? "hole" : "boss"})`)))
    .sort(([a], [b]) => parseFloat(a.slice(1)) - parseFloat(b.slice(1)))
    .map(([k, n]) => k.replace(" (", ` × ${n} (`));
  const fillets = Object.entries(count(all.faces.filter((f) => f.fillet).map((f) => `R${mm(f.radius!)}`)))
    .sort(([a], [b]) => parseFloat(a.slice(1)) - parseFloat(b.slice(1)))
    .map(([k, n]) => `${k} fillet × ${n}`);
  const planes = all.faces.filter((f) => f.type === "PLANE")
    .map((f) => ({ ref: refString(part, f), normal: f.normal!, area: f.area! }))
    .sort((a, b) => b.area - a.area);
  const want = filter.type?.toLowerCase();
  const features = [...all.faces, ...all.edges]
    .map((f) => ({ ...f, ref: refString(part, f), feature: featureType(f) }))
    .filter((f) => !want || f.feature === want || f.type.toLowerCase() === want || f.label.toLowerCase() === want)
    .filter((f) => filter.minRadius === undefined || (f.radius ?? -Infinity) >= filter.minRadius)
    .filter((f) => filter.maxRadius === undefined || (f.radius ?? Infinity) <= filter.maxRadius);
  return {
    faces: count(all.faces.map(featureType)),
    edges: count(all.edges.map((e) => e.label.toLowerCase())),
    diameters,
    fillets,
    planes: planes.slice(0, 12),
    features: features.slice(0, filter.limit ?? 50),
    total: features.length,
    note: "References (F faces, E edges, V vertices) stay valid until the part rebuilds.",
  };
}

// ---- display (measure card): rounded text, full-precision copy values

export interface Row {
  label: string;
  v: string; // shown value (scalar)
  u: string; // unit
  vec?: string[]; // vectors: three cells
  full: string; // copied
}

export interface PickView {
  clipped: boolean; // only what a section leaves
  type: string; // Arc, Cylinder, Fillet…
  key: string; // the value that identifies it: "Ø24.00 · 90°", "Hole Ø6.60", "R2.00"
  facts: Row[]; // scalars, main first
  details: Row[]; // vectors
}

const n2 = (v: number) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
const cell = (v: number) => n2(v).replace("-", "\u2212");
const scalar = (label: string, v: number, u: string, prefix = ""): Row => ({ label, v: prefix + n2(v), u, full: String(v) });
// Lengths in mm up to a metre, then m; areas in mm², cm² or m² (copies stay in mm / mm²)
const lengthRow = (label: string, v: number): Row =>
  Math.abs(v) >= 1000 ? { label, v: (v / 1000).toFixed(3), u: "m", full: String(v) } : scalar(label, v, "mm");
const areaRow = (label: string, v: number): Row =>
  v >= 1e5 ? { label, v: (v / 1e6).toFixed(3), u: "m²", full: String(v) }
    : v >= 1e3 ? { label, v: (v / 100).toFixed(2), u: "cm²", full: String(v) } : scalar(label, v, "mm²");
const text = (r: Row) => `${r.v} ${r.u}`;
const vector = (label: string, v: number[]): Row => ({ label, v: "", u: "", vec: v.map(cell), full: v.join(", ") });

export function pickView(f: EntityFacts): PickView {
  const facts: Row[] = [];
  const details: Row[] = [];
  const full = f.arcAngle !== undefined && f.arcAngle >= 359.999;
  let key = "";
  if (f.kind === "vertex") {
    details.push(vector("Position", f.position!));
    key = f.position!.map(cell).join(", ");
    return { clipped: false, type: "Vertex", key, facts, details };
  }
  if (f.fillet) {
    facts.push(scalar("Corner radius", f.radius!, "mm", "R"));
    key = `R${n2(f.radius!)}`;
  } else if (f.diameter !== undefined) {
    facts.push(scalar("Diameter", f.diameter, "mm", "Ø"));
    key = `Ø${n2(f.diameter)}`;
    if (f.concave !== undefined) {
      facts.push({ label: "Kind", v: f.concave ? "Hole" : "Boss", u: "", full: f.concave ? "hole" : "boss" });
      key = `${f.concave ? "Hole" : "Boss"} ${key}`;
    }
  } else if (f.radius !== undefined) {
    facts.push(scalar("Radius", f.radius, "mm", "R"));
    key = `R${n2(f.radius)}`;
  }
  if (f.radii && f.type === "TORUS") facts.push(scalar("Ring radius", f.radii[1], "mm"));
  if (f.radii && f.type === "ELLIPSE") {
    facts.push(scalar("Major radius", f.radii[0], "mm"), scalar("Minor radius", f.radii[1], "mm"));
    key = `${n2(f.radii[0])} × ${n2(f.radii[1])}`;
  }
  if (f.halfAngle !== undefined) {
    facts.push(scalar("Half-angle", f.halfAngle, "°"));
    key = key ? `${key} · ${n2(f.halfAngle)}°` : `${n2(f.halfAngle)}°`;
  }
  if (f.arcAngle !== undefined && !full) {
    facts.push(scalar("Arc angle", f.arcAngle, "°"));
    key = `${key} · ${Math.round(f.arcAngle * 10) / 10}°`;
  }
  if (f.length !== undefined && !full) {
    facts.push(lengthRow("Length", f.length));
    if (!key) key = text(facts[facts.length - 1]);
  }
  // Planes are known by their extent: "700.00 × 430.00 mm"
  const dims = f.size?.filter((x) => x > 1e-6) ?? [];
  if (f.type === "PLANE" && dims.length === 2 && !key) {
    const m = Math.max(...dims) >= 1000;
    key = `${dims.map((x) => (m ? (x / 1000).toFixed(3) : n2(x))).join(" × ")} ${m ? "m" : "mm"}`;
  }
  if (f.area !== undefined) {
    facts.push(areaRow("Area", f.area));
    if (!key) key = text(facts[facts.length - 1]);
  }
  // Centre, normal and direction stay with the agent tools
  if (f.size) details.push({ ...vector("Size", f.size), u: "mm" });
  if (f.axis) details.push(vector("Axis", f.axis));
  return { clipped: !!f.clipped, type: f.label, key, facts, details };
}

export function pairView(p: PairFacts): { main: Row; note: string; rows: Row[] } {
  const rows: Row[] = [];
  if (p.centerDistance !== undefined) rows.push(lengthRow("Centre to centre", p.centerDistance));
  if (p.axisOffset !== undefined) rows.push(lengthRow("Axis offset", p.axisOffset));
  if (p.angle !== undefined) rows.push(scalar("Angle", p.angle, "°"));
  if (p.delta) (["X", "Y", "Z"] as const).forEach((a, i) => rows.push(lengthRow(`Δ${a}`, p.delta![i])));
  // Touching: lead with what tells them apart (the angle, else centre to centre)
  const lead = p.distance < 1e-6 && rows.find((r) => r.label === "Angle" || r.label === "Centre to centre");
  if (lead) return { main: lead, note: "touching", rows: [lengthRow("Distance", p.distance), ...rows.filter((r) => r !== lead)] };
  return { main: lengthRow("Distance", p.distance), note: "minimum", rows };
}

// Long instance paths keep their last segment: "…/right_shell:E30"
export function shortRef(r: string, max: number) {
  if (r.length <= max) return r;
  const i = r.lastIndexOf("/");
  const t = i >= 0 ? "…/" + r.slice(i + 1) : "";
  return t && t.length <= max ? t : "…" + r.slice(-(max - 1));
}
