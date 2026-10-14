import type { Browser, Page } from "@playwright/test";
import { expect, openApp, openShare, test } from "./fixtures";

const builds = (page: Page) => page.evaluate(() => (globalThis as unknown as { cadEngine: { builds: number } }).cadEngine.builds);
const allOk = (page: Page, n: number) =>
  page.waitForFunction((n) => document.querySelectorAll("[data-part]").length === n &&
    [...document.querySelectorAll("[data-part]")].every((e) => (e as HTMLElement).dataset.status === "ok"), n, { timeout: 60_000 });

async function setup(page: Page, cad: { call: (n: string, a?: Record<string, unknown>) => Promise<unknown> }, sessionId: string) {
  await openApp(page, sessionId);
  await cad.call("set_model_info", { name: "Bundle test" });
  await cad.call("set_params_form", { params: [
    { name: "w", label: "W", type: "slider", min: 5, max: 50, default: 10 },
    { name: "h", label: "H", type: "slider", min: 1, max: 20, default: 5 },
  ] });
  await cad.call("set_part_script", { name: "a", source: `const main = () => makeBaseBox(param("w"), 10, 10);` });
  await cad.call("set_part_script", { name: "b", source: `const main = () => part("a").fuse(makeBaseBox(2, 2, param("h")).translate([0, 0, 10]));` });
  await cad.call("set_part_script", { name: "c", source: `const main = () => makeSphere(4);` });
}

async function viewer(browser: Browser, url: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${url}?debug`);
  await allOk(page, 3);
  return { page, ctx };
}

test.describe("share mesh bundles", () => {
  test("first visit shows prebuilt meshes; param change builds only affected parts", async ({ page, sessionId, cad, browser }) => {
    await setup(page, cad, sessionId);
    await openShare(page);
    await page.getByTestId("publish").click();
    const url = (await page.getByTestId("share-url").textContent())!;
    const v = await viewer(browser, url);
    expect(await builds(v.page)).toBe(0);
    // h is read by b only; b needs a's shape (not built yet in this browser)
    await v.page.locator('[data-param="h"] input[type=range]').fill("9");
    await expect.poll(() => builds(v.page)).toBe(2);
    await allOk(v.page, 3);
    await v.ctx.close();
  });

  test("republish replaces the bundle", async ({ page, sessionId, cad, browser }) => {
    await setup(page, cad, sessionId);
    await openShare(page);
    await page.getByTestId("publish").click();
    const url = (await page.getByTestId("share-url").textContent())!;
    await cad.call("set_part_script", { name: "c", source: `const main = () => makeSphere(6);` });
    await page.getByRole("button", { name: "Republish" }).click();
    await page.waitForTimeout(500);
    const v = await viewer(browser, url);
    expect(await builds(v.page)).toBe(0);
    // Viewer shows the republished sphere (r=6): check via its parts list metrics in the store
    const vol = await v.page.evaluate(() =>
      (globalThis as unknown as { cadEngine: { infos: Map<string, { metrics?: { volume: number } }> } }).cadEngine.infos.get("c")?.metrics?.volume);
    expect(vol).toBeCloseTo((4 / 3) * Math.PI * 216, 0);
    await v.ctx.close();
  });

  test("without a bundle the viewer builds", async ({ page, sessionId, cad, browser }) => {
    await setup(page, cad, sessionId);
    await page.route("**/share/meshes**", (r) => r.abort());
    await openShare(page);
    await page.getByTestId("publish").click();
    await expect(page.getByTestId("console-latest")).toContainText("preview cache upload failed");
    const url = (await page.getByTestId("share-url").textContent())!;
    const v = await viewer(browser, url);
    expect(await builds(v.page)).toBe(3);
    await v.ctx.close();
  });
});
