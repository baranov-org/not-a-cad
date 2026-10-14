import { describe, expect, it } from "vitest";
import { changedNames, checkValues, mergeValues, ParamsForm, paramRefs, type Params } from "../src";

const form = ParamsForm.parse({
  groups: [{ id: "holes", label: "Holes", collapsed: true }],
  params: [
    { name: "thickness", label: "Thickness", type: "number", default: 3, min: 1, max: 10, unit: "mm" },
    { name: "angle", label: "Angle", type: "slider", default: 45, min: 0, max: 90, step: 5, unit: "deg" },
    { name: "rounded", label: "Rounded", type: "checkbox", default: true },
    { name: "shape", label: "Shape", type: "radio", default: "round", options: [{ value: "round", label: "Round" }, { value: "square", label: "Square" }] },
    { name: "count", label: "Count", type: "select", default: 4, options: [{ value: 2, label: "2" }, { value: 4, label: "4" }], group: "holes" },
    { name: "label", label: "Label", type: "text", default: "CAD" },
  ],
});

describe("ParamsForm", () => {
  it("parses all control types with defaults", () => {
    expect(form.params).toHaveLength(6);
    expect(form.groups[0].collapsed).toBe(true);
    const text = form.params.find((p) => p.name === "label")!;
    expect(text.type === "text" && text.maxLength).toBe(200);
    expect(ParamsForm.parse({ params: [] }).groups).toEqual([]);
  });

  it("rejects invalid definitions with all problems", () => {
    const r = ParamsForm.safeParse({
      groups: [{ id: "g", label: "G" }],
      params: [
        { name: "a", label: "A", type: "number", default: 1 },
        { name: "a", label: "A2", type: "checkbox", default: false },
        { name: "b", label: "B", type: "number", default: 0, group: "nope" },
        { name: "c", label: "C", type: "slider", default: 5, min: 10, max: 1 },
        { name: "d", label: "D", type: "select", default: "x", options: [{ value: "y", label: "Y" }] },
        { name: "e", label: "E", type: "number", default: 50, max: 20 },
      ],
    });
    expect(r.success).toBe(false);
    const msgs = r.error!.issues.map((i) => i.message).join("\n");
    for (const m of [/Duplicate parameter "a"/, /unknown group "nope"/, /"c": min > max/, /"d": default must be one of/, /"e": default must be ≤ 20/]) {
      expect(msgs).toMatch(m);
    }
  });

  it("rejects bad names, slider without limits, empty options", () => {
    for (const p of [
      { name: "1bad", label: "x", type: "checkbox", default: true },
      { name: "s", label: "x", type: "slider", default: 1 },
      { name: "r", label: "x", type: "radio", default: "a", options: [] },
      { name: "w", label: "x", type: "color", default: "red" },
    ]) expect(ParamsForm.safeParse({ params: [p] }).success, JSON.stringify(p)).toBe(false);
  });
});

describe("values", () => {
  const params: Params = { form, values: { thickness: 4, angle: 45, rounded: false, shape: "square", count: 2, label: "x" } };

  it("checks partial updates", () => {
    expect(checkValues(form, { thickness: 5, rounded: true })).toEqual([]);
    expect(checkValues(form, { thickness: 50, count: 3, nope: 1, rounded: "yes", label: "x".repeat(201) })).toEqual([
      '"thickness" must be ≤ 10',
      '"count" must be one of: 2, 4',
      'Unknown parameter "nope"',
      '"rounded" must be true or false',
      '"label" must be at most 200 characters',
    ]);
  });

  it("keeps still-valid values on redefinition, resets the rest", () => {
    const next = ParamsForm.parse({
      params: [
        { name: "thickness", label: "T", type: "number", default: 2, max: 10 }, // 4 still valid
        { name: "angle", label: "A", type: "slider", default: 10, min: 0, max: 30 }, // 45 now invalid
        { name: "rounded", label: "R", type: "text", default: "no" }, // type changed
        { name: "fresh", label: "F", type: "checkbox", default: true }, // new
      ],
    });
    expect(mergeValues(params, next)).toEqual({ thickness: 4, angle: 10, rounded: "no", fresh: true });
  });

  it("finds changed names", () => {
    expect(changedNames({ a: 1, b: true, c: "x" }, { a: 1, b: false, d: 2 }).sort()).toEqual(["b", "c", "d"]);
  });

  it("finds param refs", () => {
    expect(paramRefs(`param("a") + param('b_2') * param( \`c\` ); param(x); part("a")`).sort()).toEqual(["a", "b_2", "c"]);
  });
});
