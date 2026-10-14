import type { Page } from "@playwright/test";
import { expect, openApp, resourceBytes, test } from "./fixtures";
import { capMask, centerBlock, pngCenterBlock, stripes } from "./pixels";

const status = (page: Page) => page.getByTestId("console-state");
const bar = (page: Page) => page.getByTestId("section-bar");
const names = (page: Page) => bar(page).locator(".tool-row-main");

test.describe("multi-plane section", () => {
  test.use({ viewport: { width: 1280, height: 760 } });

  test("bar: add planes on unused axes, eye, bin, status line; Section off keeps the planes", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "cube", primitive: { type: "box", width: 30, depth: 30, height: 30 } });
    await page.keyboard.press("s");
    await expect(bar(page)).toBeVisible();
    await expect(status(page)).toContainText("Section · 1 plane");
    await expect(names(page)).toHaveText([/^1XZ/]);
    await page.getByTestId("section-add").click();
    await page.getByTestId("section-add").click();
    await expect(names(page)).toHaveText([/^1XZ/, /^2XY/, /^3YZ/]);
    await expect(page.getByTestId("section-add")).toHaveCount(0); // max 3
    await expect(status(page)).toContainText("Section · 3 planes");
    // The new plane is selected for editing
    await expect(names(page).nth(2)).toHaveAttribute("aria-expanded", "true");
    await bar(page).getByRole("button", { name: "Hide plane 3" }).click();
    await expect(status(page)).toContainText("Section · 2 planes");
    await bar(page).getByRole("button", { name: "Delete plane 2" }).click();
    await expect(names(page)).toHaveText([/^1XZ/, /^3YZ/]);
    await expect(status(page)).toContainText("Section · 1 plane");
    // No separate on/off switch: the toolbar's Section turns cutting off and back on with the same planes
    await expect(page.getByRole("switch", { name: /section/i })).toHaveCount(0);
    await page.getByTestId("section-toggle").click();
    await expect(bar(page)).toHaveCount(0);
    await expect(status(page)).not.toContainText("Section");
    await page.getByTestId("section-toggle").click();
    await expect(names(page)).toHaveText([/^1XZ/, /^3YZ/]);
    await bar(page).getByRole("button", { name: "Close section" }).click();
    await expect(bar(page)).toHaveCount(0);
  });

  test("two planes cap two regions; Section off shows the full model; agent views stay uncut", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "cube", primitive: { type: "box", width: 30, depth: 30, height: 30 } });
    await page.getByTestId("view-toolbar").getByRole("button", { name: "Fit", exact: true }).click();
    const shot0 = await cad.call("get_view_image", { part: "cube", direction: "iso" });
    const stl0 = resourceBytes(await cad.call("export", { part: "cube" })).bytes;

    await page.keyboard.press("s");
    // Second plane XY, flipped: keeps the lower half, so its cap faces the camera
    await page.getByTestId("section-add").click();
    await bar(page).getByRole("button", { name: "Flip", exact: true }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/section-two-planes.png" });
    // Caps are unlit, in the part colour (as rendered); compare the cut with each plane alone and with both
    const CAP: [number, number, number] = [163, 182, 203];
    const TOL = 32; // fill and the hatch blended into it
    const both = new Set(await capMask(page, CAP, TOL));
    const only = async (off: string) => {
      await bar(page).getByRole("button", { name: off }).click();
      await page.waitForTimeout(300);
      const m = await capMask(page, CAP, TOL);
      await bar(page).getByRole("button", { name: off.replace("Hide", "Show") }).click();
      return m;
    };
    const xz = await only("Hide plane 2");
    const xy = await only("Hide plane 1");
    const overlap = (m: number[]) => m.filter((i) => both.has(i)).length / m.length;
    expect(xz.length).toBeGreaterThan(1000);
    expect(xy.length).toBeGreaterThan(1000);
    // Each plane's cap shows in the combined cut where the other plane keeps the solid (about half)
    expect(overlap(xz)).toBeGreaterThan(0.3);
    expect(overlap(xy)).toBeGreaterThan(0.3);
    expect(stripes(await centerBlock(page, 14, 40, 60))).toBeGreaterThanOrEqual(2);

    await page.getByTestId("section-toggle").click();
    await page.waitForTimeout(300);
    // Off: the full model, no caps or hatching
    expect(await capMask(page, CAP)).toHaveLength(0);
    await page.getByTestId("section-toggle").click();

    // Agent screenshots and exports ignore all planes
    const shot1 = await cad.call("get_view_image", { part: "cube", direction: "iso" });
    expect(stripes(await pngCenterBlock(page, shot0.content[0].data!))).toBeLessThanOrEqual(1);
    expect(stripes(await pngCenterBlock(page, shot1.content[0].data!))).toBeLessThanOrEqual(1);
    expect(resourceBytes(await cad.call("export", { part: "cube" })).bytes.equals(stl0)).toBe(true);
  });
});

test.describe("tool stack", () => {
  test("desktop: Section above Measure in one column; minimise leaves a pill in place", async ({ page, sessionId, cad }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "cube", primitive: { type: "box", width: 30, depth: 30, height: 30 } });
    await page.keyboard.press("s");
    await page.keyboard.press("m");
    const sec = (await bar(page).boundingBox())!, mc = (await page.getByTestId("measure-card").boundingBox())!;
    expect(mc.y).toBeGreaterThan(sec.y + sec.height);
    expect(Math.abs(mc.x + mc.width - (sec.x + sec.width))).toBeLessThan(1);
    await bar(page).getByRole("button", { name: "Minimise" }).click();
    await expect(page.getByTestId("section-pill")).toContainText("XZ");
    await page.getByTestId("section-pill").click();
    await expect(bar(page)).toBeVisible();
    // Both cards close the same way
    await page.getByRole("button", { name: "Close measure" }).click();
    await expect(page.getByTestId("measure-card")).toHaveCount(0);
    await expect(page.getByTestId("measure-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  test("phone: one tool sheet, the other a pill; tapping the pill swaps", async ({ page, sessionId, cad }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "cube", primitive: { type: "box", width: 30, depth: 30, height: 30 } });
    await page.keyboard.press("s");
    await expect(bar(page)).toHaveClass(/is-sheet/);
    await page.keyboard.press("m");
    await expect(page.getByTestId("measure-card")).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await page.getByTestId("section-pill").click();
    await expect(bar(page)).toBeVisible();
    await expect(page.getByTestId("measure-pill")).toBeVisible();
  });
});
