import { expect, json, openApp, test, text } from "./fixtures";

const form = {
  groups: [{ id: "holes", label: "Holes", collapsed: true }],
  params: [
    { name: "w", label: "Width", type: "number", default: 20, min: 5, max: 100, unit: "mm", description: "Box width" },
    { name: "h", label: "Height", type: "slider", default: 10, min: 2, max: 40, step: 2, unit: "mm" },
    { name: "rounded", label: "Rounded", type: "checkbox", default: false },
    { name: "shape", label: "Hole shape", type: "radio", default: "round", options: [{ value: "round", label: "Round" }, { value: "square", label: "Square" }], group: "holes" },
    { name: "hole_d", label: "Hole diameter", type: "select", default: 4, options: [{ value: 4, label: "4 mm" }, { value: 6, label: "6 mm" }], group: "holes" },
    { name: "tag", label: "Tag", type: "text", default: "A", placeholder: "label" },
  ],
};
const boxScript = `const main = () => makeBaseBox(param("w"), 10, param("h"));`;
const vol = async (cad: { call: (n: string, a?: Record<string, unknown>) => Promise<{ content: { text?: string }[] }> }, name: string) =>
  json(await cad.call("get_part", { name }) as never).volume as number;

test.describe("parameters", () => {
  test("scripts read params; unknown param errors", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    expect((await cad.call("set_params_form", form)).isError).toBe(false);
    let r = await cad.call("set_part_script", { name: "box", source: boxScript });
    expect(r.isError, text(r)).toBe(false);
    expect(json(r).volume).toBeCloseTo(20 * 10 * 10, 3);
    expect(json(await cad.call("get_part", { name: "box" })).params.sort()).toEqual(["h", "w"]);
    r = await cad.call("set_part_script", { name: "bad", source: `const main = () => makeBaseBox(param("nope"), 1, 1);` });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Unknown parameter "nope"/);
  });

  test("value change rebuilds only users and dependents", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_params_form", form);
    await cad.call("set_part_script", { name: "box", source: boxScript });
    await cad.call("create_primitive", { name: "pin", primitive: { type: "cylinder", radius: 1, height: 50 } });
    await cad.call("boolean_op", { name: "drilled", op: "cut", target: "box", tools: ["pin"] });
    const r = await cad.call("set_param_values", { values: { w: 30 } });
    expect(r.isError, text(r)).toBe(false);
    expect(json(r).rebuilt.map((p: { name: string }) => p.name).sort()).toEqual(["box", "drilled"]);
    expect(await vol(cad, "box")).toBeCloseTo(30 * 10 * 10, 3);
    // Invalid values are rejected as a whole
    const bad = await cad.call("set_param_values", { values: { w: 500, hole_d: 5 } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/"w" must be ≤ 100/);
    expect(text(bad)).toMatch(/"hole_d" must be one of/);
    expect(json(await cad.call("get_params")).values.w).toBe(30);
  });

  test("panel renders every control type and collapsible groups", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await expect(page.getByTestId("params")).toBeHidden();
    await cad.call("set_params_form", form);
    const panel = page.getByTestId("params");
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-param="w"] input[type=number]')).toHaveValue("20");
    await expect(panel.locator('[data-param="w"] .unit')).toHaveText("mm");
    await expect(panel.locator('[data-param="w"] .desc')).toHaveText("Box width");
    await expect(panel.locator('[data-param="h"] input[type=range]')).toHaveValue("10");
    await expect(panel.locator('[data-param="rounded"] [role=switch]')).toHaveAttribute("aria-checked", "false");
    await expect(panel.locator('[data-param="tag"] input[type=text]')).toHaveValue("A");
    // Collapsed group hides its params until expanded
    const holes = panel.locator('[data-group="holes"]');
    await expect(holes.locator('[data-param="shape"]')).toBeHidden();
    await holes.locator(".pgroup-head").click();
    await expect(holes.locator('[data-param="shape"] [role=radio]')).toHaveCount(2);
    await expect(holes.locator('[data-param="hole_d"] select')).toBeVisible();
    // Ungrouped params come before groups
    const order = await panel.locator("[data-param]").evaluateAll((els) => els.map((e) => e.getAttribute("data-param")));
    expect(order).toEqual(["w", "h", "rounded", "tag", "shape", "hole_d"]);
    // Empty form hides the panel
    await cad.call("set_params_form", { params: [] });
    await expect(panel).toBeHidden();
  });

  test("user edits: validation, live rebuild, reset", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_params_form", form);
    await cad.call("set_part_script", { name: "box", source: boxScript });
    const w = page.locator('[data-param="w"] input');
    await w.fill("500");
    await w.press("Enter");
    await expect(page.locator('[data-param="w"] .err')).toHaveText("Max 100 mm");
    expect(await vol(cad, "box")).toBeCloseTo(2000, 3);
    await w.fill("40");
    await w.press("Enter");
    await expect(page.locator('[data-param="w"] .err')).toHaveCount(0);
    await expect.poll(() => vol(cad, "box")).toBeCloseTo(4000, 3);
    // Slider applies live
    await page.locator('[data-param="h"] input[type=range]').fill("20");
    await expect.poll(() => vol(cad, "box")).toBeCloseTo(8000, 3);
    await page.locator('[data-param="h"] .readout').getByText("20").waitFor();
    // Rapid drags coalesce; the final geometry matches the last value
    const range = page.locator('[data-param="h"] input[type=range]');
    for (const v of ["2", "30", "6", "38", "12", "24"]) await range.fill(v);
    await expect.poll(() => vol(cad, "box")).toBeCloseTo(40 * 10 * 24, 3);
    await range.fill("20");
    await expect.poll(() => vol(cad, "box")).toBeCloseTo(8000, 3);
    // Select and radio apply on change
    await page.locator('[data-group="holes"] .pgroup-head').click();
    await page.locator('[data-param="hole_d"] select').selectOption({ label: "6 mm" });
    await page.locator('[data-param="shape"]').getByRole("radio", { name: "Square" }).click();
    await expect.poll(async () => json(await cad.call("get_params")).values).toMatchObject({ hole_d: 6, shape: "square" });
    await page.getByRole("button", { name: "Reset to defaults" }).click();
    await expect.poll(() => vol(cad, "box")).toBeCloseTo(2000, 3);
    await expect(w).toHaveValue("20");
  });

  test("user edits are saved, visible to the agent, and survive reload; redefinition keeps valid values", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_params_form", form);
    await cad.call("set_part_script", { name: "box", source: boxScript });
    await page.locator('[data-param="rounded"] [role=switch]').click();
    const t = page.locator('[data-param="tag"] input');
    await t.fill("B-7");
    await t.press("Enter");
    await expect.poll(async () => json(await cad.call("get_params")).values).toMatchObject({ rounded: true, tag: "B-7" });
    await page.waitForTimeout(500); // debounced save
    await page.reload();
    await expect(page.locator('[data-param="rounded"] [role=switch]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-param="tag"] input')).toHaveValue("B-7");
    // Redefine: tag kept (same type, valid), w reset (now out of range)
    await cad.call("set_param_values", { values: { w: 80 } });
    const next = { params: [
      { name: "w", label: "Width", type: "number", default: 10, max: 50 },
      { name: "tag", label: "Tag", type: "text", default: "Z" },
    ] };
    const r = await cad.call("set_params_form", next);
    expect(json(r).values).toEqual({ w: 10, tag: "B-7" });
    // box now uses a removed param -> rebuilt with an error
    expect(json(r).rebuilt.map((p: { name: string; status: string }) => `${p.name}:${p.status}`)).toEqual(["box:error"]);
  });
});
