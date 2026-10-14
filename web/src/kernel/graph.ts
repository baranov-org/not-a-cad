import { partRefs } from "shared";

export type Deps = Map<string, string[]>;

export function depsOf(sources: Map<string, string>): Deps {
  const d: Deps = new Map();
  for (const [name, src] of sources) d.set(name, partRefs(src));
  return d;
}

// Kahn's order over known parts; leftovers are in or behind a cycle
export function topoOrder(deps: Deps): { order: string[]; cyclic: string[] } {
  const indeg = new Map<string, number>();
  const users = new Map<string, string[]>();
  for (const n of deps.keys()) indeg.set(n, 0);
  for (const [n, refs] of deps) {
    for (const r of refs) {
      if (!deps.has(r)) continue;
      indeg.set(n, indeg.get(n)! + 1);
      users.set(r, [...(users.get(r) ?? []), n]);
    }
  }
  const queue = [...deps.keys()].filter((n) => indeg.get(n) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const u of users.get(n) ?? []) {
      indeg.set(u, indeg.get(u)! - 1);
      if (indeg.get(u) === 0) queue.push(u);
    }
  }
  const done = new Set(order);
  return { order, cyclic: [...deps.keys()].filter((n) => !done.has(n)).sort() };
}

// Names plus everything that transitively references them
export function withDependents(deps: Deps, names: Iterable<string>): Set<string> {
  const out = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [n, refs] of deps) {
      if (!out.has(n) && refs.some((r) => out.has(r))) {
        out.add(n);
        grew = true;
      }
    }
  }
  return out;
}

export function dependentsOf(deps: Deps, name: string): string[] {
  return [...deps].filter(([n, refs]) => n !== name && refs.includes(name)).map(([n]) => n).sort();
}
