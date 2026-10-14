import type { Page } from "@playwright/test";
import { expect, openApp, test } from "./fixtures";

// Viewport navigation: proportional zoom to the cursor, orbit and pan around the point under it, presets, scroll-pan
type Cam = { distance: number; target: number[]; position: number[]; forward: number[]; near: number };
const cam = (page: Page) => page.evaluate(() => (globalThis as unknown as { cadViewer: { cameraState: () => Cam } }).cadViewer.cameraState());
const settle = (page: Page) => page.waitForTimeout(400); // smoothing (60 ms) has finished
const canvas = async (page: Page) => (await page.locator(".viewport canvas").boundingBox())!;
const wheel = async (page: Page, x: number, y: number, dy: number, n = 1, opts: { ctrl?: boolean; dx?: number } = {}) => {
  await page.mouse.move(x, y);
  if (opts.ctrl) await page.keyboard.down("Control");
  for (let i = 0; i < n; i++) await page.mouse.wheel(opts.dx ?? 0, dy);
  if (opts.ctrl) await page.keyboard.up("Control");
  await settle(page);
};
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// Depth of a point in front of the camera: unchanged by panning, smaller after zooming in
const depth = (c: Cam, p: number[]) => (p[0] - c.position[0]) * c.forward[0] + (p[1] - c.position[1]) * c.forward[1] + (p[2] - c.position[2]) * c.forward[2];

test.describe("navigation", () => {
  test.use({ viewport: { width: 1500, height: 800 } }); // wide enough for the full view toolbar

  test("zoom is proportional to the scroll and goes to the cursor; clipping follows", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?debug");
    await cad.call("create_primitive", { name: "plate", primitive: { type: "box", width: 200, depth: 120, height: 10 } });
    await page.keyboard.press("3"); // top view
    await settle(page);
    const b = await canvas(page);
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const d0 = (await cam(page)).distance;
    // Trackpad: many small deltas add up to a modest zoom, not a jump
    await wheel(page, cx, cy, -3, 20);
    const d1 = (await cam(page)).distance;
    expect(d1 / d0).toBeGreaterThan(0.85);
    expect(d1 / d0).toBeLessThan(0.97);
    // One mouse-wheel notch: about 12%
    await wheel(page, cx, cy, -100);
    const d2 = (await cam(page)).distance;
    expect(d2 / d1).toBeGreaterThan(0.84);
    expect(d2 / d1).toBeLessThan(0.92);
    // Zooming out by the same amount comes back
    await wheel(page, cx, cy, 100);
    expect((await cam(page)).distance / d1).toBeCloseTo(1, 1);

    // Toward the cursor: zooming in near the right edge moves the target right (+X in the top view)
    const t0 = (await cam(page)).target;
    await wheel(page, cx + b.width * 0.3, cy, -100, 5);
    const t1 = (await cam(page)).target;
    expect(t1[0] - t0[0]).toBeGreaterThan(5);

    // Very close: the near plane shrinks with the distance, so the plate isn't clipped away
    await wheel(page, cx, cy, -100, 40);
    const c = await cam(page);
    expect(c.near).toBeLessThan(c.distance / 50);
  });

  test("orbit pivots on the point under the cursor; scroll can pan; presets change the buttons (setting in localStorage)", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?debug");
    await cad.call("create_primitive", { name: "plate", primitive: { type: "box", width: 200, depth: 120, height: 10 } });
    await page.keyboard.press("1");
    await settle(page);
    const b = await canvas(page);
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;

    // Left drag from a point on the plate: the orbit point becomes that surface point (top face, z = 10)
    await page.mouse.move(cx + 60, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 20, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    const t = (await cam(page)).target;
    expect(t[2]).toBeCloseTo(10, 0);
    await expect(page.getByRole("button", { name: "Iso" })).toHaveAttribute("aria-pressed", "false");

    // With a section, the pivot is what you see: the cap at the cut, not the removed top face
    await page.keyboard.press("s");
    const bar = page.getByTestId("section-bar");
    await bar.getByRole("radiogroup", { name: "Orientation" }).getByRole("radio", { name: "XY" }).click();
    await bar.getByRole("button", { name: "Flip", exact: true }).click(); // keeps the lower half
    await bar.getByRole("button", { name: "Minimise" }).click();
    await page.keyboard.press("1");
    await settle(page);
    await page.mouse.move(cx + 60, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 20, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    expect((await cam(page)).target[2]).toBeCloseTo(5, 0);
    await page.keyboard.press("s");

    // Scroll mode "pan": a two-finger scroll pans (same distance, target moves); pinch still zooms
    // The menu is hidden for now; the setting lives in localStorage
    const setNav = async (nav: object) => {
      await page.evaluate((n) => localStorage.setItem("cad.nav", JSON.stringify(n)), nav);
      await page.reload();
      await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
      await page.keyboard.press("1");
      await settle(page);
    };
    await setNav({ preset: "default", scroll: "pan" });
    const p0 = await cam(page);
    await wheel(page, cx, cy, 40, 5, { dx: 40 });
    const p1 = await cam(page);
    const centre = [0, 0, 5];
    expect(depth(p1, centre) / depth(p0, centre)).toBeCloseTo(1, 2);
    expect(dist(p1.position, p0.position)).toBeGreaterThan(5);
    await wheel(page, cx, cy, -20, 5, { ctrl: true });
    expect(depth(await cam(page), centre)).toBeLessThan(depth(p1, centre) * 0.9);

    // Onshape preset: left drag does nothing, right drag orbits
    await setNav({ preset: "onshape", scroll: "pan" });
    const o0 = await cam(page);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 150, cy, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    expect(dist((await cam(page)).position, o0.position)).toBeLessThan(0.01);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(cx, cy, { steps: 8 });
    await page.mouse.up({ button: "right" });
    await settle(page);
    expect(dist((await cam(page)).position, o0.position)).toBeGreaterThan(5);

  });
});
