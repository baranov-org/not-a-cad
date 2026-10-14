import type { Page } from "@playwright/test";
import { expect, json, openApp, openShare, resourceBytes, test, text } from "./fixtures";
import { unzipSync } from "fflate";
import { centerBlock, lum, pngCenterBlock, stripes } from "./pixels";

const box = (w: number) => ({ type: "box", width: w, depth: w, height: w });

async function grouped(page: Page, cad: { call: (n: string, a?: Record<string, unknown>) => Promise<unknown> }, sessionId: string) {
  await openApp(page, sessionId);
  for (const [n, w] of [["base", 20], ["gear1", 6], ["gear2", 8], ["lid", 18]] as const) {
    await cad.call("create_primitive", { name: n, primitive: box(w) });
  }
  await cad.call("set_part_groups", {
    groups: [{ id: "gears", label: "Gears" }, { id: "covers", label: "Covers", collapsed: true }],
    assign: { gear1: "gears", gear2: "gears", lid: "covers" },
  });
}

test.describe("part groups", () => {
  test("render under collapsible headers, persist, mark errors; share uses the same tree", async ({ page, sessionId, cad, browser }) => {
    await grouped(page, cad, sessionId);
    const list = page.getByTestId("parts");
    await expect(list.locator(":scope > li[data-part]")).toHaveCount(1); // base ungrouped
    await expect(list.locator('[data-group="gears"] [data-part]')).toHaveCount(2);
    await expect(list.locator('[data-group="gears"] .count')).toHaveText("2");
    await expect(list.locator('[data-group="covers"] [data-part="lid"]')).toHaveCount(0); // collapsed
    await list.locator('[data-group="covers"] .group-row .tog').click();
    await expect(list.locator('[data-group="covers"] [data-part="lid"]')).toBeVisible();
    // New part joins a group; bad group rejected
    let r = await cad.call("set_part_script", { name: "gear3", source: "const main = () => makeSphere(2);", group: "gears" });
    expect(r.isError, text(r)).toBe(false);
    expect(json(await cad.call("get_part", { name: "gear3" })).group).toBe("gears");
    r = await cad.call("set_part_script", { name: "x", source: "const main = () => makeSphere(2);", group: "nope" });
    expect(r.isError).toBe(true);
    // Error marker on the group
    await cad.call("set_part_script", { name: "gear2", source: "const main = () => { throw new Error('x') };", group: "gears" });
    await expect(list.locator('[data-group="gears"] [data-testid="group-error"]')).toBeVisible();
    // Persists across reload
    await page.reload();
    await expect(page.locator('[data-group="gears"] [data-part]')).toHaveCount(3);
    // Deleting a part drops its assignment
    await cad.call("delete_part", { name: "lid" });
    await expect(page.locator('[data-group="covers"]')).toHaveCount(0);
    // Share viewer: the same grouped tree
    await cad.call("set_model_info", { name: "Grouped" });
    await openShare(page);
    await page.getByTestId("publish").click();
    await page.getByRole("button", { name: "Publish anyway" }).click();
    const url = (await page.getByTestId("share-url").textContent())!;
    const ctx = await browser.newContext();
    const v = await ctx.newPage();
    await v.goto(url);
    await expect(v.locator('[data-testid="parts"] [data-part]')).toHaveCount(4);
    await expect(v.locator('[data-group="gears"] [data-part]')).toHaveCount(3);
    await ctx.close();
  });
});

test.describe("instance visibility", () => {
  test("eye toggles hide instances on screen only", async ({ page, sessionId, cad }) => {
    await grouped(page, cad, sessionId);
    await cad.call("set_assembly", { instances: [
      { part: "base" }, { part: "gear1", position: [40, 0, 0] }, { part: "gear1", position: [60, 0, 0] }, { part: "gear2", position: [0, 40, 0] },
    ] });
    const canvas = page.locator("canvas").first();
    const shot0 = await cad.call("get_view_image", { direction: "iso" });
    const rows = page.getByTestId("instances").locator("li");
    await expect(rows).toHaveText([/^base/, /^gear1 #1/, /^gear1 #2/, /^gear2/]);
    await page.waitForTimeout(300);
    const before = await canvas.screenshot();
    await rows.nth(0).getByRole("button", { name: /Hide base/ }).click();
    await expect(rows.nth(0)).toHaveClass(/off/);
    await page.waitForTimeout(300);
    expect((await canvas.screenshot()).equals(before)).toBe(false);
    // Group eye hides all gear instances
    await page.locator('[data-group="gears"] .group-row').getByRole("button", { name: /Hide Gears/ }).click();
    await expect(rows.nth(1)).toHaveClass(/off/);
    await expect(rows.nth(3)).toHaveClass(/off/);
    await expect(page.getByTestId("assembly-row")).toContainText("4 hidden");
    // Agent screenshot and export still include everything
    const shot1 = await cad.call("get_view_image", { direction: "iso" });
    expect(shot1.content[0].data).toBe(shot0.content[0].data);
    const zip = unzipSync(resourceBytes(await cad.call("export", {})).bytes);
    expect(Buffer.from(zip["assembly.stl"]).readUInt32LE(80)).toBe(48); // 4 boxes x 12 triangles
    // Still hidden after the screenshot; reload resets
    await expect(rows.nth(0)).toHaveClass(/off/);
    await page.reload();
    await expect(page.getByTestId("instances").locator("li")).toHaveCount(4);
    await expect(page.getByTestId("instances").locator("li.off")).toHaveCount(0);
  });
});



test.describe("section view", () => {
  // Stripe counting needs the canvas size the thresholds were tuned for (the top bar takes some height)
  test.use({ viewport: { width: 1280, height: 760 } });
  test("caps the cut, follows controls, leaves screenshots and export uncut", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "cube", primitive: box(30) });
    await page.getByTestId("view-toolbar").getByRole("button", { name: "Fit", exact: true }).click();
    const shot0 = await cad.call("get_view_image", { part: "cube", direction: "iso" });
    const zip0 = resourceBytes(await cad.call("export", { part: "cube" })).bytes;
    await page.waitForTimeout(300);
    const off = await centerBlock(page);
    expect(stripes(off)).toBeLessThanOrEqual(1); // plain face (maybe one edge line)
    await page.getByTestId("section-toggle").click();
    await expect(page.getByTestId("section-bar")).toBeVisible();
    await page.waitForTimeout(300);
    // Cut face at the centre: hatch stripes over the part's own (blue-grey) colour
    const on = await centerBlock(page);
    expect(stripes(on)).toBeGreaterThanOrEqual(3);
    const top = Math.max(...on.map(lum));
    const light = on.filter((p) => lum(p) >= top * 0.8);
    const avg = [0, 1, 2].map((k) => light.reduce((t, p) => t + p[k], 0) / light.length);
    expect(avg[2]).toBeGreaterThan(avg[0] + 15); // bluish like the part, not a separate cap colour
    const canvas = page.locator("canvas").first();
    const a = await canvas.screenshot();
    await page.getByTestId("section-bar").getByRole("tab", { name: "Tilt" }).click();
    await page.getByLabel("Tilt A", { exact: true }).fill("30");
    await page.getByLabel("Tilt A", { exact: true }).press("Enter");
    await page.waitForTimeout(300);
    const b = await canvas.screenshot();
    expect(b.equals(a)).toBe(false);
    await page.getByTestId("section-bar").getByRole("button", { name: "Flip", exact: true }).click();
    await page.waitForTimeout(300);
    expect((await canvas.screenshot()).equals(b)).toBe(false);
    // Plane select and offset
    await page.getByRole("radiogroup", { name: "Orientation" }).getByRole("radio", { name: "YZ" }).click();
    await page.getByTestId("section-bar").getByRole("tab", { name: "Offset" }).click();
    await page.getByLabel("Offset x", { exact: true }).fill("5");
    await page.getByLabel("Offset x", { exact: true }).press("Enter");
    await expect(page.getByTestId("section-bar")).toContainText("x 5.00");
    // Agent screenshot and export are uncut
    const shot1 = await cad.call("get_view_image", { part: "cube", direction: "iso" });
    // Agent screenshots are uncut: no hatch at the centre, like before the section
    expect(stripes(await pngCenterBlock(page, shot0.content[0].data!))).toBeLessThanOrEqual(1);
    expect(stripes(await pngCenterBlock(page, shot1.content[0].data!))).toBeLessThanOrEqual(1);
    expect(resourceBytes(await cad.call("export", { part: "cube" })).bytes.equals(zip0)).toBe(true);
    // Off again
    await page.getByTestId("section-toggle").click();
    await expect(page.getByTestId("section-bar")).toBeHidden();
  });
});

test.describe("right parameters panel", () => {
  test("lives on the right, collapses, remembers; share viewer puts it in the same place", async ({ page, sessionId, cad, browser }) => {
    await openApp(page, sessionId);
    const panel = page.getByTestId("right-panel");
    await expect(panel.getByTestId("no-params")).toHaveText("Parameters appear here when your agent defines them.");
    await cad.call("set_params_form", { params: [{ name: "w", label: "Width", type: "number", default: 10 }] });
    await cad.call("set_part_script", { name: "p", source: `const main = () => makeBaseBox(param("w"), 5, 5);` });
    await expect(panel.locator('[data-param="w"]')).toBeVisible();
    const canvas = page.locator(".viewport");
    const narrow = (await canvas.boundingBox())!.width;
    expect((await panel.boundingBox())!.x).toBeGreaterThan(narrow); // right of the viewport
    await page.getByTestId("collapse-right").click();
    await expect(panel).toHaveCount(0);
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(narrow + 200);
    await page.reload();
    await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    await expect(page.getByTestId("right-panel")).toHaveCount(0);
    await page.getByTestId("show-right").click();
    await expect(page.getByTestId("right-panel")).toBeVisible();
    // Share viewer: parameters in the right panel too, without the Activity tab
    await cad.call("set_model_info", { name: "Panel" });
    await openShare(page);
    await page.getByTestId("publish").click();
    const url = (await page.getByTestId("share-url").textContent())!;
    const ctx = await browser.newContext();
    const v = await ctx.newPage();
    await v.goto(url);
    await expect(v.getByTestId("right-panel").locator('[data-param="w"]')).toBeVisible();
    await expect(v.getByTestId("tab-activity")).toHaveCount(0);
    await ctx.close();
  });
});
