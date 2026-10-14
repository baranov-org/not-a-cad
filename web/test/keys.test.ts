import { describe, expect, it } from "vitest";
import { depsOf } from "../src/kernel/graph";
import { computeKeys } from "../src/kernel/keys";

const hash = async (s: string) => s; // identity: keys are inspectable
const run = (parts: Record<string, string>, values: Record<string, number | string | boolean>, version = "v1") => {
  const sources = new Map(Object.entries(parts));
  return computeKeys(Object.keys(parts), sources, depsOf(sources), values, hash, version);
};

describe("content keys", () => {
  const parts = { a: `param("w")`, b: `part("a"); param("h")`, c: `param("other")` };

  it("change with source, read params, dependency keys and version", async () => {
    const k = await run(parts, { w: 1, h: 2, other: 3 });
    expect(k.size).toBe(3);
    const w = await run(parts, { w: 9, h: 2, other: 3 });
    expect(w.get("a")).not.toBe(k.get("a"));
    expect(w.get("b")).not.toBe(k.get("b")); // via dependency key
    expect(w.get("c")).toBe(k.get("c"));
    const src = await run({ ...parts, a: `param("w") + 1` }, { w: 1, h: 2, other: 3 });
    expect(src.get("a")).not.toBe(k.get("a"));
    expect((await run(parts, { w: 1, h: 2, other: 3 }, "v2")).get("c")).not.toBe(k.get("c"));
  });

  it("ignore params a part does not read", async () => {
    const k = await run(parts, { w: 1, h: 2, other: 3 });
    const o = await run(parts, { w: 1, h: 2, other: 4, unused: "x" });
    expect(o.get("a")).toBe(k.get("a"));
    expect(o.get("b")).toBe(k.get("b"));
    expect(o.get("c")).not.toBe(k.get("c"));
  });

  it("parts with unknown dependencies get no key", async () => {
    const k = await run({ a: `part("missing")`, b: `1` }, {});
    expect(k.has("a")).toBe(false);
    expect(k.has("b")).toBe(true);
  });
});
