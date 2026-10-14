import { MAX_DEPTH, MAX_INSTANCES, type Assembly, type AssemblyNode, type GroupNode, type Instance, type Vec3 } from "./model";
import type { ParamsForm } from "./params";

// Assembly evaluation: a tree of groups and instances into placed instances with world placements

export interface Placed extends Instance {
  // Stable id for view state (hidden instances): group path + part/label + ordinal among same-named siblings
  key: string;
  // Group labels from the root
  path: string[];
  label?: string;
}

type M3 = number[]; // row-major 3×3
interface Xf { r: M3; t: Vec3 }

const DEG = Math.PI / 180;
const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ID: Xf = { r: I3, t: [0, 0, 0] };

const mul3 = (a: M3, b: M3): M3 => {
  const o: M3 = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
};
const apply3 = (m: M3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a);
  if (!l) throw new Error("Joint axis must not be zero");
  return scale(a, 1 / l);
};
const compose = (a: Xf, b: Xf): Xf => ({ r: mul3(a.r, b.r), t: add(apply3(a.r, b.t), a.t) });

// XYZ Euler in degrees, three.js order: R = Rx · Ry · Rz
export function eulerMatrix([x, y, z]: Vec3): M3 {
  const [a, b, c] = [x * DEG, y * DEG, z * DEG];
  const rx: M3 = [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
  const ry: M3 = [Math.cos(b), 0, Math.sin(b), 0, 1, 0, -Math.sin(b), 0, Math.cos(b)];
  const rz: M3 = [Math.cos(c), -Math.sin(c), 0, Math.sin(c), Math.cos(c), 0, 0, 0, 1];
  return mul3(mul3(rx, ry), rz);
}

// Rotation of deg degrees about a unit axis (Rodrigues)
export function axisMatrix(axis: Vec3, deg: number): M3 {
  const [x, y, z] = unit(axis);
  const a = deg * DEG;
  const c = Math.cos(a), s = Math.sin(a), k = 1 - c;
  return [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
}

// Back to XYZ Euler degrees (three.js Euler.setFromRotationMatrix, order XYZ)
export function matrixEuler(m: M3): Vec3 {
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const y = Math.asin(clamp(m[2]));
  let x: number, z: number;
  if (Math.abs(m[2]) < 0.9999999) {
    x = Math.atan2(-m[5], m[8]);
    z = Math.atan2(-m[1], m[0]);
  } else {
    x = Math.atan2(m[7], m[4]);
    z = 0;
  }
  const r = (v: number) => Math.round((v / DEG) * 1e9) / 1e9 + 0;
  return [r(x), r(y), r(z)];
}

const isGroup = (n: AssemblyNode): n is GroupNode => "group" in n;

// Sibling-unique segment: name, then name#2, name#3 for repeats
function segments<T>(items: T[], name: (t: T) => string): string[] {
  const seen = new Map<string, number>();
  return items.map((it) => {
    const n = name(it);
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n}#${k}`;
  });
}

// Joint values by label path: own value or followed, clamped to limits
function jointValues(nodes: AssemblyNode[]): Map<string, number> {
  const joints = new Map<string, GroupNode>();
  const walk = (ns: AssemblyNode[], path: string[]) => {
    const groups = ns.filter(isGroup);
    segments(groups, (g) => g.group).forEach((seg, i) => {
      const g = groups[i];
      const p = [...path, seg];
      if (g.axis || g.slide) joints.set(p.join("/"), g);
      walk(g.children, p);
    });
  };
  walk(nodes, []);
  const values = new Map<string, number>();
  const resolving = new Set<string>();
  const value = (path: string): number => {
    const known = values.get(path);
    if (known !== undefined) return known;
    const g = joints.get(path);
    if (!g) throw new Error(`Joint "${path}" not found`);
    if (resolving.has(path)) throw new Error(`Joints follow each other in a loop: ${[...resolving, path].join(" → ")}`);
    resolving.add(path);
    let v = g.follow
      ? g.follow.ratio * value(g.follow.joint) + (g.follow.offset ?? 0)
      : (g.slide ? g.slide.distance : g.angle ?? 0);
    resolving.delete(path);
    if (g.limits) v = Math.min(Math.max(v, Math.min(...g.limits)), Math.max(...g.limits));
    values.set(path, v);
    return v;
  };
  for (const [path, g] of joints) {
    if (g.follow && !joints.has(g.follow.joint)) throw new Error(`Joint "${path}" follows "${g.follow.joint}", which is not a joint`);
    value(path);
  }
  return values;
}

// Group transform: T(position) · T(slide) · T(pivot) · R · T(-pivot)
function groupXf(g: GroupNode, value: number | undefined): Xf {
  const pivot = g.pivot ?? [0, 0, 0];
  const r = g.axis ? axisMatrix(g.axis, value ?? 0) : g.rotation ? eulerMatrix(g.rotation) : I3;
  const slide = g.slide ? scale(unit(g.slide.axis), value ?? 0) : [0, 0, 0] as Vec3;
  return { r, t: add(add(g.position ?? [0, 0, 0], slide), sub(pivot, apply3(r, pivot))) };
}

export function evaluate(nodes: AssemblyNode[]): Placed[] {
  const values = jointValues(nodes);
  const out: Placed[] = [];
  const walk = (ns: AssemblyNode[], xf: Xf, path: string[], keyPath: string[], color: string | undefined, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error(`Groups nest at most ${MAX_DEPTH} levels`);
    const segs = segments(ns, (n) => (isGroup(n) ? n.group : n.label ?? n.part));
    ns.forEach((n, i) => {
      if (isGroup(n)) {
        const gPath = [...keyPath, segs[i]];
        const joint = n.axis || n.slide ? values.get(gPath.join("/")) : undefined;
        walk(n.children, compose(xf, groupXf(n, joint)), [...path, n.group], gPath, n.color ?? color, depth + 1);
        return;
      }
      if (out.length >= MAX_INSTANCES) throw new Error(`An assembly holds at most ${MAX_INSTANCES} instances`);
      const local: Xf = { r: eulerMatrix(n.rotation ?? [0, 0, 0]), t: n.position ?? [0, 0, 0] };
      const w = compose(xf, local);
      const r = (v: number) => Math.round(v * 1e9) / 1e9 + 0;
      out.push({
        part: n.part,
        position: w.t.map(r) as Vec3,
        rotation: matrixEuler(w.r),
        ...(n.color ?? color ? { color: n.color ?? color } : {}),
        ...(n.label ? { label: n.label } : {}),
        key: [...keyPath, segs[i]].join("/"),
        path,
      });
    });
  };
  walk(nodes, ID, [], [], undefined, 0);
  return out;
}

// The stored source as nodes (a flat list is a tree without groups); undefined for scripts
export function assemblyNodes(a: Assembly): AssemblyNode[] | undefined {
  if (a.script !== undefined) return undefined;
  return a.tree ?? a.instances;
}

// Joints driven by a parameter whose form range goes past the joint's limits
export function jointWarnings(nodes: AssemblyNode[], form: ParamsForm): string[] {
  const out: string[] = [];
  const walk = (ns: AssemblyNode[], path: string[]) => {
    const groups = ns.filter(isGroup);
    segments(groups, (g) => g.group).forEach((seg, i) => {
      const g = groups[i];
      const p = [...path, seg];
      const def = g.driver && g.limits ? form.params.find((x) => x.name === g.driver) : undefined;
      if (def && (def.type === "number" || def.type === "slider")) {
        const [lo, hi] = [Math.min(...g.limits!), Math.max(...g.limits!)];
        const min = def.min ?? -Infinity, max = def.max ?? Infinity;
        if (min < lo || max > hi) {
          out.push(`Joint "${p.join("/")}" is limited to ${lo}…${hi} but parameter "${def.name}" ranges ${def.min ?? "−∞"}…${def.max ?? "∞"}; values outside are clamped`);
        }
      }
      walk(g.children, p);
    });
  };
  walk(nodes, []);
  return out;
}

// The source without instances of a deleted part (empty groups stay); undefined when nothing changed or for scripts
export function withoutPart(a: Assembly, part: string): Assembly | undefined {
  if (a.script !== undefined) return undefined;
  let removed = false;
  const prune = (ns: AssemblyNode[]): AssemblyNode[] => ns.flatMap((n): AssemblyNode[] => {
    if (isGroup(n)) return [{ ...n, children: prune(n.children) }];
    if (n.part === part) {
      removed = true;
      return [];
    }
    return [n];
  });
  const next: Assembly = a.tree ? { instances: [], tree: prune(a.tree) } : { instances: prune(a.instances) as Instance[] };
  return removed ? next : undefined;
}

export const hasAssembly = (a: Assembly) => a.instances.length > 0 || (a.tree?.length ?? 0) > 0 || a.script !== undefined;
