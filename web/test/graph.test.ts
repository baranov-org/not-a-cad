import { describe, expect, it } from "vitest";
import { dependentsOf, depsOf, topoOrder, withDependents } from "../src/kernel/graph";

const src = (refs: string[]) => refs.map((r) => `part("${r}")`).join(";");
const deps = (g: Record<string, string[]>) => depsOf(new Map(Object.entries(g).map(([k, v]) => [k, src(v)])));

describe("graph", () => {
  it("orders dependencies first", () => {
    const { order, cyclic } = topoOrder(deps({ c: ["a", "b"], a: [], b: ["a"], d: ["c"] }));
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(cyclic).toEqual([]);
  });
  it("ignores unknown refs for ordering", () => {
    expect(topoOrder(deps({ a: ["missing"] })).order).toEqual(["a"]);
  });
  it("reports cycles and parts behind them", () => {
    const { order, cyclic } = topoOrder(deps({ a: ["b"], b: ["a"], c: ["a"], d: [] }));
    expect(order).toEqual(["d"]);
    expect(cyclic).toEqual(["a", "b", "c"]);
  });
  it("finds transitive dependents", () => {
    const g = deps({ a: [], b: ["a"], c: ["b"], d: [] });
    expect([...withDependents(g, ["a"])].sort()).toEqual(["a", "b", "c"]);
    expect(dependentsOf(g, "a")).toEqual(["b"]);
  });
});
