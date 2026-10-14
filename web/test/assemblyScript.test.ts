import { describe, expect, it } from "vitest";
import { evaluate, type GroupNode } from "shared";
import { runAssemblyScript } from "../src/kernel/assemblyScript";

describe("assembly scripts", () => {
  it("counted loops and joint angles from parameters", () => {
    const nodes = runAssemblyScript(`
      const main = () => [
        ...Array.from({ length: param("posts") }, (_, i) => instance("post", { position: [i * 50, 0, 0] })),
        group("Arm", { pivot: [0, 0, 100], axis: [0, 1, 0], angle: param("arm"), limits: [-45, 45] }, [instance("arm")]),
      ];`, { posts: 6, arm: 30 });
    const placed = evaluate(nodes);
    expect(placed.filter((p) => p.part === "post").map((p) => p.position[0])).toEqual([0, 50, 100, 150, 200, 250]);
    expect((nodes[6] as GroupNode).driver).toBe("arm");
  });

  it("drivers: equal parameter values are told apart; derived values and unlimited joints get none", () => {
    const nodes = runAssemblyScript(`const main = () => [
      group("Hip", { axis: [0, 1, 0], angle: param("hip"), limits: [-30, 30] }, []),
      group("Knee", { axis: [0, 1, 0], angle: param("knee"), limits: [0, 120] }, []),
      group("Mirror", { axis: [0, 1, 0], angle: -param("hip"), limits: [-30, 30] }, []),
      group("Free", { axis: [0, 1, 0], angle: param("knee") }, []),
    ];`, { hip: 0, knee: 0 });
    expect(nodes.map((n) => (n as GroupNode).driver)).toEqual(["hip", "knee", undefined, undefined]);
  });

  it("thrown errors, unknown parameters, a missing main and malformed nodes fail with a message", () => {
    expect(() => runAssemblyScript(`const main = () => { throw new Error("boom") };`, {})).toThrow("boom");
    expect(() => runAssemblyScript(`const main = () => [instance(param("nope"))];`, {})).toThrow('Unknown parameter "nope"');
    expect(() => runAssemblyScript(`const x = 1;`, {})).toThrow(/must define `const main/);
    expect(() => runAssemblyScript(`const main = () => instance("a");`, {})).toThrow(/must return an array/);
    expect(() => runAssemblyScript(`const main = () => [group("G", { angle: "x" }, [])];`, {})).toThrow(/Malformed assembly node at 0/);
  });
});
