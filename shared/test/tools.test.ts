import { describe, expect, it } from "vitest";
import { ToolInputs } from "../src";

describe("tool schemas", () => {
  it("accepts valid input and applies defaults", () => {
    expect(ToolInputs.create_primitive.parse({ name: "b", primitive: { type: "box", width: 1, depth: 2, height: 3 } })).toBeTruthy();
    expect(ToolInputs.fillet.parse({ part: "b", radius: 1 }).edges).toBe("all");
    expect(ToolInputs.fillet.parse({ part: "b", radius: 1, edges: { inPlane: "XY" } }).edges).toEqual({ inPlane: "XY", offset: 0 });
    expect(ToolInputs.get_view_image.parse({}).direction).toBe("iso");
    const a = ToolInputs.set_assembly.parse({ instances: [{ part: "b" }] });
    expect(a.instances[0]).toEqual({ part: "b", position: [0, 0, 0], rotation: [0, 0, 0] });
  });
  it("rejects bad input", () => {
    const bad: [keyof typeof ToolInputs, unknown][] = [
      ["set_part_script", { name: "has space", source: "" }],
      ["set_part_script", { name: "x".repeat(65), source: "" }],
      ["create_primitive", { name: "b", primitive: { type: "box", width: -1, depth: 2, height: 3 } }],
      ["create_primitive", { name: "b", primitive: { type: "pyramid" } }],
      ["create_primitive", { name: "b", primitive: { type: "cone", radius1: 0, radius2: 0, height: 3 } }],
      ["boolean_op", { name: "c", op: "cut", target: "a", tools: [] }],
      ["boolean_op", { name: "c", op: "xor", target: "a", tools: ["b"] }],
      ["fillet", { part: "b", radius: 0 }],
      ["fillet", { part: "b", radius: 1, edges: { parallelTo: "W" } }],
      ["set_assembly", { instances: [{ part: "b", color: "red" }] }],
      ["get_view_image", { direction: "bottom" }],
    ];
    for (const [tool, input] of bad) expect(ToolInputs[tool].safeParse(input).success, `${tool} ${JSON.stringify(input)}`).toBe(false);
  });
});
