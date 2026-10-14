import { AssemblyNode, type GroupNode, type ParamValue } from "shared";

// Assembly scripts: plain JavaScript defining `const main = () => [instance(...), group(...)]`, with param("name")

const Nodes = AssemblyNode.array();

const issue = (issues: { path: PropertyKey[]; message: string }[]) => {
  const i = issues[0];
  return `Malformed assembly node at ${i.path.map(String).join(".") || "top level"}: ${i.message}`;
};

function execute(source: string, params: Record<string, ParamValue>, read: Set<string>): AssemblyNode[] {
  const param = (name: string): ParamValue => {
    if (!Object.hasOwn(params, name)) throw new Error(`Unknown parameter "${name}"`);
    read.add(name);
    return params[name];
  };
  const instance = (part: string, opts: object = {}) => ({ ...opts, part });
  const group = (label: string, opts: object = {}, children: unknown[] = []) => ({ ...opts, group: label, children });
  const fn = new Function("instance", "group", "param", `${source}\n;return typeof main === "function" ? main : undefined;`);
  const main = fn(instance, group, param);
  if (!main) throw new Error("Assembly script must define `const main = () => [instance(...), group(...)]`");
  const out = main();
  if (!Array.isArray(out)) throw new Error("main() must return an array of instance(...) and group(...) nodes");
  const parsed = Nodes.safeParse(out);
  if (!parsed.success) throw new Error(issue(parsed.error.issues));
  return parsed.data;
}

// Own joint values by group label path (followers excluded)
function jointValues(nodes: AssemblyNode[]): Map<string, { node: GroupNode; value: number }> {
  const out = new Map<string, { node: GroupNode; value: number }>();
  const walk = (ns: AssemblyNode[], path: string) => {
    for (const n of ns) {
      if (!("group" in n)) continue;
      const p = path ? `${path}/${n.group}` : n.group;
      const v = n.slide ? n.slide.distance : n.axis ? n.angle : undefined;
      if (typeof v === "number" && !n.follow && !out.has(p)) out.set(p, { node: n, value: v });
      walk(n.children, p);
    }
  };
  walk(nodes, "");
  return out;
}

const PROBE = 1 / 1024;

export function runAssemblyScript(source: string, params: Record<string, ParamValue>): AssemblyNode[] {
  const read = new Set<string>();
  const nodes = execute(source, params, read);
  // Which parameter drives each limited joint: rerun with each numeric parameter nudged by its own amount and look for
  // joints that moved by exactly that amount (derived values like -param("x") don't match and get no driver)
  const numeric = [...read].filter((n) => typeof params[n] === "number");
  const joints = jointValues(nodes);
  if (!numeric.length || ![...joints.values()].some((j) => j.node.limits)) return nodes;
  const probe = { ...params };
  numeric.forEach((n, i) => (probe[n] = (params[n] as number) + (i + 1) * PROBE));
  let moved: Map<string, { value: number }>;
  try {
    moved = jointValues(execute(source, probe, new Set()));
  } catch {
    return nodes;
  }
  for (const [path, j] of joints) {
    const m = moved.get(path);
    if (!m || !j.node.limits) continue;
    const step = Math.round((m.value - j.value) / PROBE);
    if (step >= 1 && step <= numeric.length && Math.abs(m.value - j.value - step * PROBE) < 1e-9) j.node.driver = numeric[step - 1];
  }
  return nodes;
}
