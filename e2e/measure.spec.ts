import type { Page } from "@playwright/test";
import { expect, json, openApp, publishShare, test, text } from "./fixtures";

export const PLATE = `const main = () => {
  let p = makeBaseBox(100, 60, 8);
  for (const x of [-20, 20]) p = p.cut(makeCylinder(3.3, 20, [x, 0, -5]));
  return p.fillet(2, (e) => e.inPlane("XY", 8));
};`;

test.describe("measure", () => {
  test("agent: inspect_part lists holes and fillets; measure by reference, from cache too, and on a placed instance", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?debug");
    await cad.call("set_part_script", { name: "plate", source: PLATE });
    const r = await cad.call("inspect_part", { part: "plate", type: "hole" });
    expect(r.isError, text(r)).toBeFalsy();
    const s = json(r);
    expect(s.diameters).toEqual(["Ø6.6 × 2 (hole)"]);
    expect(s.fillets[0]).toMatch(/^R2 fillet/);
    const [h1, h2] = s.features.map((f: { ref: string }) => f.ref);
    const m = json(await cad.call("measure", { a: h1, b: h2 }));
    expect(m.centerDistance).toBeCloseTo(40, 6);
    expect(m.a).toMatchObject({ label: "Cylinder", diameter: 6.6, concave: true });

    // Shown from cache after a reload: the exact shape comes from the cache too (saved 2 s after the build)
    await page.waitForTimeout(2500);
    await page.reload();
    await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('[data-part="plate"]')).toHaveAttribute("data-status", "ok");
    await expect(page.locator('[data-part="plate"] .st')).toHaveText("cached");
    expect(json(await cad.call("measure", { a: h1 })).diameter).toBeCloseTo(6.6, 6);
    expect(await page.evaluate(() => (globalThis as unknown as { cadEngine: { brepLoads: number } }).cadEngine.brepLoads)).toBe(1);

    // Assembly instance: measured where it is placed
    await cad.call("set_assembly", { instances: [{ group: "Moved", position: [100, 0, 0], children: [{ part: "plate" }] }] });
    const placed = json(await cad.call("measure", { a: h1.replace("plate:", "Moved/plate:") }));
    expect(placed.center[0]).toBeCloseTo(json(await cad.call("measure", { a: h1 })).center[0] + 100, 6);

    // Errors
    expect(text(await cad.call("measure", { a: "plate:F999" }))).toContain("No face 999");
    expect(text(await cad.call("measure", { a: "nope:F1" }))).toContain("neither a part nor an assembly instance");
    expect((await cad.call("inspect_part", { part: "nope" })).isError).toBe(true);
  });
});

// Upper block on the right half: top faces 10 mm apart, step edge at x = 0 (40 mm)
const STEP = `const main = () => makeBaseBox(40, 40, 10).fuse(makeBox([0, -20, 10], [20, 20, 20]));`;

const card = (page: Page) => page.getByTestId("measure-card");

// Hover updates on the next frame
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// Moves across the canvas (fractions of its size from the centre) until the hovered reference passes `want`
async function hoverFind(page: Page, from: [number, number], to: [number, number], want: (ref: string) => boolean, steps = 80) {
  const box = (await page.locator(".viewport canvas").boundingBox())!;
  const seen = new Set<string>();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = box.x + box.width / 2 + (from[0] + (to[0] - from[0]) * t) * box.height;
    const y = box.y + box.height / 2 + (from[1] + (to[1] - from[1]) * t) * box.height;
    await page.mouse.move(x, y);
    await settle(page);
    const ref = (await card(page).getAttribute("data-hover")) ?? "";
    if (want(ref)) return { x, y, ref };
    seen.add(ref);
  }
  throw new Error(`nothing matching under the scan; saw ${[...seen].join(" ")}`);
}

test.describe("measure mode", () => {
  test.use({ viewport: { width: 1280, height: 760 } });

  test("pick edges and faces; section-aware; Esc clears then exits", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_part_script", { name: "step", source: STEP });
    await page.keyboard.press("3"); // top view
    await page.keyboard.press("m");
    await expect(page.getByTestId("measure-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(card(page)).toContainText("Click a face, edge or vertex");

    // Step edge under the centre: the reported index is the 40 mm edge at x = 0, z = 20
    const e = await hoverFind(page, [0.02, 0.05], [-0.02, 0.05], (r) => /^step:E\d+$/.test(r));
    const facts = json(await cad.call("measure", { a: e.ref }));
    expect(facts.length).toBeCloseTo(40, 6);
    expect(facts.direction.map(Math.abs)).toEqual([0, 1, 0]);
    await page.mouse.click(e.x, e.y);
    await expect(page.getByTestId("measure-type-a")).toHaveText("Line");
    await expect(page.getByTestId("measure-key-a")).toHaveText("40.00 mm");
    await expect(page.getByTestId("measure-main")).toHaveText("40.00mm"); // one pick: its main value

    // Second pick is B; a third replaces B and keeps A
    const hi = await hoverFind(page, [0.15, 0.1], [0.3, 0.1], (r) => /^step:F\d+$/.test(r));
    await page.mouse.click(hi.x, hi.y);
    await expect(page.getByTestId("measure-type-b")).toHaveText("Plane");
    const lo = await hoverFind(page, [-0.15, 0.1], [-0.3, 0.1], (r) => /^step:F\d+$/.test(r) && r !== hi.ref);
    await page.mouse.click(lo.x, lo.y);
    await expect(page.getByTestId("measure-main")).toHaveText("10.00mm"); // the step edge to the lower face
    await expect(page.getByTestId("measure-type-a")).toHaveText("Line");

    // Two top faces: 10 mm apart, parallel
    await card(page).getByRole("button", { name: "Clear" }).click();
    await page.mouse.click(hi.x, hi.y);
    await page.mouse.click(lo.x, lo.y);
    const res = page.getByTestId("measure-result");
    await expect(res.locator(".top .l")).toHaveText("Distance");
    await expect(page.getByTestId("measure-main")).toHaveText("10.00mm");
    await expect(res.locator('[data-row="Angle"] .v')).toHaveText("0.00°");

    // Esc clears the picks, then leaves measure mode
    await page.keyboard.press("Escape");
    await expect(card(page)).toContainText("Click a face, edge or vertex");
    await expect(res).toHaveCount(0);

    // Section (XZ, keeps y > 0 side): the removed half can't be picked
    const front = await hoverFind(page, [0.15, -0.15], [0.15, -0.15], (r) => r !== "", 1).catch(() => undefined);
    const back = await hoverFind(page, [0.15, 0.15], [0.15, 0.15], (r) => r !== "", 1).catch(() => undefined);
    expect(front && back).toBeTruthy();
    await page.keyboard.press("s");
    // The section card overlays the model: shrink it to its pill
    await page.getByTestId("section-bar").getByRole("button", { name: "Minimise" }).click();
    for (const p of [front!, back!]) await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(100);
    const kept = (await card(page).getAttribute("data-hover")) !== "";
    await page.mouse.move(front!.x, front!.y);
    await page.waitForTimeout(100);
    const removed = (await card(page).getAttribute("data-hover")) !== "";
    expect(kept !== removed).toBe(true); // exactly one side is pickable
    // Iso onto the cut: the cap hides the inner walls behind it
    await page.keyboard.press("1");
    const box = (await page.locator(".viewport canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 0.03 * box.height);
    await page.waitForTimeout(150);
    await expect(card(page)).toHaveAttribute("data-hover", "");
    await page.keyboard.press("s");

    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByTestId("measure-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  test("hole diameter, fillet radius, copy reference; clears on rebuild", async ({ page, context, sessionId, cad }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page, sessionId);
    await cad.call("set_part_script", { name: "plate", source: PLATE });
    type F = { ref: string; diameter?: number };
    const refs = async (type: string, ok: (f: F) => boolean = () => true) =>
      json(await cad.call("inspect_part", { part: "plate", type })).features.filter(ok).map((f: F) => f.ref);
    // Wall, or its circle under the rim fillet
    const holes = [...await refs("hole"), ...await refs("circle", (f) => Math.abs(f.diameter! - 6.6) < 1e-6)];
    const fillets = await refs("fillet");
    await page.keyboard.press("1"); // iso: hole walls and fillets are visible
    await page.getByTestId("measure-toggle").click();

    // Hole at x = 20 sits about (0.08, 0.02) of the height from the centre in iso
    const hole = await hoverFind(page, [0.02, 0.02], [0.14, 0.02], (r) => holes.includes(r), 60);
    await page.mouse.click(hole.x, hole.y);
    await expect(page.getByTestId("measure-key-a")).toContainText("Ø6.60");

    // Zoom in so the 2 mm fillet is wider than the edge pick zone
    const c = (await page.locator(".viewport canvas").boundingBox())!;
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100); // ~12% per notch: about 2×
    await page.waitForTimeout(300);
    const fil = await hoverFind(page, [-0.45, 0.2], [-0.1, 0.2], (r) => fillets.includes(r), 120);
    await page.mouse.click(fil.x, fil.y);
    await expect(page.getByTestId("measure-type-b")).toHaveText("Fillet");
    await expect(page.getByTestId("measure-key-b")).toHaveText("R2.00");

    // The pick shows where it is, without the entity number; values copy at full precision
    await expect(card(page).locator('[data-pick="b"] .ref')).toHaveText("plate");
    await card(page).locator('[data-pick="b"] .head').click();
    await card(page).locator('[data-pick="b"] [data-row="Corner radius"] .v').click();
    await expect(card(page).locator('[data-pick="b"] [data-row="Corner radius"] .l')).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("2");

    // Rebuilding the part clears the picks
    await cad.call("set_part_script", { name: "plate", source: PLATE.replace("100, 60, 8", "100, 60, 9").replace('"XY", 8', '"XY", 9') });
    await expect(page.getByTestId("measure-type-a")).toHaveCount(0);
    await expect(card(page)).toContainText("Click a face, edge or vertex");
  });

  test("section: picks follow the section; section lines; a second click deselects", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_part_script", { name: "step", source: STEP });
    const planes = json(await cad.call("inspect_part", { part: "step", type: "plane" })).features as { ref: string; center: number[]; normal: number[] }[];
    const top = planes.find((f) => f.center[2] === 20 && f.normal[2] === 1)!.ref;
    await page.keyboard.press("1");
    await page.keyboard.press("m");
    const t = await hoverFind(page, [-0.05, -0.2], [0.25, 0.05], (r) => r === top, 120);
    await page.mouse.click(t.x, t.y);
    await expect(page.getByTestId("measure-key-a")).toHaveText("20.00 × 40.00 mm");
    await expect(card(page).locator(".cut")).toHaveCount(0);
    // Section on: measured on what's left, and back when it's off
    await page.keyboard.press("s");
    await expect(page.getByTestId("measure-key-a")).toHaveText("20.00 × 20.00 mm");
    await expect(card(page).locator(".cut")).toHaveCount(1);
    await page.keyboard.press("s");
    await expect(page.getByTestId("measure-key-a")).toHaveText("20.00 × 40.00 mm");
    // Clicking the pick again removes it
    await page.mouse.click(t.x, t.y);
    await expect(card(page)).toContainText("Click a face, edge or vertex");

    // Where the plane meets the top face: a 20 mm section line
    await page.keyboard.press("s");
    let found = false;
    for (const y of [-0.12, -0.08, -0.04, 0, 0.04]) {
      const box = (await page.locator(".viewport canvas").boundingBox())!;
      for (let i = 0; i <= 60 && !found; i++) {
        await page.mouse.move(box.x + box.width / 2 + (-0.3 + 0.6 * i / 60) * box.height, box.y + box.height / 2 + y * box.height);
        await settle(page);
        if ((await card(page).getAttribute("data-hover-kind")) === "section" && (await card(page).getAttribute("data-hover")) === top) {
          await page.mouse.down();
          await page.mouse.up();
          // A point at the edge of the pick zone can miss; keep scanning then
          found = await page.getByTestId("measure-type-a").waitFor({ timeout: 1500 }).then(() => true, () => false);
        }
      }
      if (found) break;
    }
    expect(found).toBe(true);
    await expect(page.getByTestId("measure-type-a")).toHaveText("Section line");
    await expect(page.getByTestId("measure-key-a")).toHaveText("20.00 mm");
    await expect(card(page).locator('[data-pick="a"] .ref')).toContainText("section");
  });

  test("share viewer measures too", async ({ page, sessionId, cad, browser }) => {
    await openApp(page, sessionId);
    await cad.call("set_model_info", { name: "Step", description: "Stepped block" });
    await cad.call("set_part_script", { name: "step", source: STEP });
    const url = await publishShare(page);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
    const v = await ctx.newPage();
    await v.goto(url);
    await expect(v.locator('[data-part="step"]')).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
    await v.keyboard.press("3");
    await v.getByTestId("measure-toggle").click();
    const e = await hoverFind(v, [0.02, 0.05], [-0.02, 0.05], (r) => /^step:E\d+$/.test(r));
    await v.mouse.click(e.x, e.y);
    await expect(v.getByTestId("measure-key-a")).toHaveText("40.00 mm");
    // Minimised: a pill with the answer
    await v.getByRole("button", { name: "Minimise" }).click();
    await expect(v.getByTestId("measure-pill")).toContainText("40.00");
    await v.getByTestId("measure-pill").click();
    await expect(v.getByTestId("measure-card")).toBeVisible();
    await ctx.close();
  });
});
