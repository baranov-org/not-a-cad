import { describe, expect, it } from "vitest";
import { Assembly, AssemblyNode, withoutPart, axisMatrix, eulerMatrix, evaluate, jointWarnings, matrixEuler, Model, ParamsForm, type GroupNode } from "../src";

const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)));
const inst = (part: string, extra: object = {}) => ({ part, position: [0, 0, 0], rotation: [0, 0, 0], ...extra });

describe("assembly schema", () => {
  it("old flat models parse unchanged; nested groups parse; too deep or malformed nodes are rejected", () => {
    const old = Model.parse({ parts: {}, assembly: { instances: [{ part: "a", position: [1, 2, 3] }] } });
    expect(old.assembly).toEqual({ instances: [{ part: "a", position: [1, 2, 3], rotation: [0, 0, 0] }] });
    const tree = Assembly.parse({ tree: [{ group: "Leg", pivot: [0, 0, 10], axis: [0, 1, 0], angle: 20, children: [inst("thigh")] }] });
    expect(tree.instances).toEqual([]);
    expect((tree.tree![0] as GroupNode).children).toHaveLength(1);
    let deep: unknown = inst("a");
    for (let i = 0; i < 9; i++) deep = { group: `g${i}`, children: [deep] };
    expect(Assembly.safeParse({ tree: [deep] }).success).toBe(false);
    expect(AssemblyNode.safeParse({ group: "x" }).success).toBe(false); // no children
    expect(AssemblyNode.safeParse({ foo: 1 }).success).toBe(false);
  });
});

describe("transforms", () => {
  it("Euler round trips, including near ±90° pitch", () => {
    for (const e of [[10, 20, 30], [-45, 89.9, 12], [0, -90, 30], [180, 0, 90], [33, 90, 0]] as [number, number, number][]) {
      close(eulerMatrix(matrixEuler(eulerMatrix(e))), eulerMatrix(e));
    }
  });

  it("axis-angle matches the Euler rotation about the same axis", () => {
    close(axisMatrix([0, 0, 1], 30), eulerMatrix([0, 0, 30]));
    close(axisMatrix([2, 0, 0], -45), eulerMatrix([-45, 0, 0]));
  });
});

describe("evaluate", () => {
  it("a joint at a pivot turns its children about that axis; nested groups compose", () => {
    const placed = evaluate([
      { group: "Leg", pivot: [0, 0, 100], axis: [0, 1, 0], angle: 90, children: [
        inst("thigh", { position: [0, 0, 50] }),
        { group: "Knee", pivot: [0, 0, 50], axis: [0, 1, 0], angle: 90, children: [inst("shin", { position: [0, 0, 0] })] },
      ] },
    ] as AssemblyNode[]);
    const [thigh, shin] = placed;
    // Point (0,0,50) turned 90° about Y through (0,0,100) → (-50, 0, 100)
    close(thigh.position, [-50, 0, 100]);
    close(thigh.rotation, [0, 90, 0]);
    // Shin origin (0,0,0) turns 90° about the knee pivot (0,0,50) → (-50,0,50), then 90° about the hip → (-50,0,150); 180° in total
    close(shin.position, [-50, 0, 150]);
    close(eulerMatrix(shin.rotation), axisMatrix([0, 1, 0], 180));
    expect(shin.path).toEqual(["Leg", "Knee"]);
    expect(shin.key).toBe("Leg/Knee/shin");
  });

  it("Euler group rotation about a pivot, position after rotation, colour inheritance", () => {
    const [a, b] = evaluate([
      { group: "G", position: [10, 0, 0], pivot: [1, 0, 0], rotation: [0, 0, 90], color: "#ff0000", children: [
        inst("a", { position: [2, 0, 0] }), inst("b", { color: "#00ff00" }),
      ] },
    ] as AssemblyNode[]);
    close(a.position, [11, 1, 0]);
    expect(a.color).toBe("#ff0000");
    expect(b.color).toBe("#00ff00");
  });

  it("keys stay put when siblings are added after an instance; repeats are numbered", () => {
    const one = evaluate([inst("bolt"), inst("bolt")] as AssemblyNode[]);
    const two = evaluate([inst("bolt"), inst("bolt"), inst("nut"), inst("bolt")] as AssemblyNode[]);
    expect(one.map((p) => p.key)).toEqual(["bolt", "bolt#2"]);
    expect(two.map((p) => p.key)).toEqual(["bolt", "bolt#2", "nut", "bolt#3"]);
  });

  it("caps the instance count", () => {
    expect(() => evaluate(Array.from({ length: 2001 }, () => inst("a")) as AssemblyNode[])).toThrow(/at most 2000/);
  });
});

describe("joint limits and coupling", () => {
  const leg = (angle: number, extra: object = {}) => ({ group: "Knee", pivot: [0, 0, 0], axis: [0, 1, 0], angle, limits: [0, 120], ...extra, children: [inst("shin", { position: [10, 0, 0] })] });

  it("clamps to limits", () => {
    const [shin] = evaluate([leg(150)] as AssemblyNode[]);
    close(eulerMatrix(shin.rotation), axisMatrix([0, 1, 0], 120));
  });

  it("a follower takes ratio × leader + offset, then its own limits", () => {
    const placed = evaluate([
      { group: "Legs", children: [
        { group: "Left hip", axis: [0, 1, 0], angle: 25, children: [inst("leg_l")] },
        { group: "Right hip", axis: [0, 1, 0], follow: { joint: "Legs/Left hip", ratio: -1 }, children: [inst("leg_r")] },
        { group: "Tail", axis: [0, 1, 0], limits: [-10, 10], follow: { joint: "Legs/Left hip", ratio: 2, offset: 5 }, children: [inst("tail")] },
      ] },
    ] as AssemblyNode[]);
    close(eulerMatrix(placed[1].rotation), axisMatrix([0, 1, 0], -25));
    close(eulerMatrix(placed[2].rotation), axisMatrix([0, 1, 0], 10));
  });

  it("sliding joints move children along the axis, clamped", () => {
    const [p] = evaluate([{ group: "Carriage", slide: { axis: [2, 0, 0], distance: 80 }, limits: [0, 50], children: [inst("sled")] }] as AssemblyNode[]);
    close(p.position, [50, 0, 0]);
  });

  it("loops and missing joints fail with a message naming the joints", () => {
    expect(() => evaluate([
      { group: "A", axis: [0, 0, 1], follow: { joint: "B", ratio: 1 }, children: [] },
      { group: "B", axis: [0, 0, 1], follow: { joint: "A", ratio: 1 }, children: [] },
    ] as AssemblyNode[])).toThrow(/loop: A → B → A/);
    expect(() => evaluate([{ group: "A", axis: [0, 0, 1], follow: { joint: "Nope", ratio: 1 }, children: [] }] as AssemblyNode[]))
      .toThrow(/"A" follows "Nope", which is not a joint/);
  });

  it("warns when a driving parameter ranges past the joint's limits", () => {
    const form = ParamsForm.parse({ params: [
      { name: "knee", label: "Knee", type: "slider", min: 0, max: 150, default: 0 },
      { name: "hip", label: "Hip", type: "slider", min: -30, max: 30, default: 0 },
    ] });
    const w = jointWarnings([
      { ...leg(0), driver: "knee" },
      { group: "Hip", axis: [0, 1, 0], angle: 0, limits: [-30, 30], driver: "hip", children: [] },
    ] as AssemblyNode[], form);
    expect(w).toEqual(['Joint "Knee" is limited to 0…120 but parameter "knee" ranges 0…150; values outside are clamped']);
  });
});

describe("withoutPart", () => {
  it("prunes a deleted part from lists and trees; scripts and untouched sources are left alone", () => {
    expect(withoutPart({ instances: [inst("a"), inst("b")] } as Assembly, "a")).toEqual({ instances: [inst("b")] });
    const tree = { instances: [], tree: [{ group: "G", children: [inst("a"), inst("b")] }] } as unknown as Assembly;
    expect(withoutPart(tree, "a")).toEqual({ instances: [], tree: [{ group: "G", children: [inst("b")] }] });
    expect(withoutPart(tree, "zzz")).toBeUndefined();
    expect(withoutPart({ instances: [], script: "x" } as Assembly, "a")).toBeUndefined();
  });
});
