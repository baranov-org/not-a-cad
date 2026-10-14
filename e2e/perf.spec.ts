import type { Page } from "@playwright/test";
import { expect, json, openApp, test, text } from "./fixtures";

// Script that blocks its worker for ms, then returns a box
const slow = (ms: number, size = 10) =>
  `const main = () => { const t = Date.now(); while (Date.now() - t < ${ms}) {} return makeBaseBox(${size}, ${size}, ${size}); };`;

const builds = (page: Page) => page.evaluate(() => (globalThis as unknown as { cadEngine: { builds: number } }).cadEngine.builds);
const workers = (page: Page) => page.evaluate(() => (globalThis as unknown as { cadEngine: { workerCount: number } }).cadEngine.workerCount);
const allOk = (page: Page, n: number) =>
  page.waitForFunction((n) => document.querySelectorAll("[data-part]").length === n &&
    [...document.querySelectorAll("[data-part]")].every((e) => (e as HTMLElement).dataset.status === "ok"), n, { timeout: 60_000 });

test.describe("build performance", () => {
  test("independent parts build in parallel", async ({ page, sessionId, cad }) => {
    const timeLoad = async (q: string) => {
      await openApp(page, sessionId, q);
      for (const n of ["a", "b", "c"]) await cad.call("set_part_script", { name: n, source: slow(2500) });
      const t = Date.now();
      await page.reload();
      await allOk(page, 3);
      return Date.now() - t;
    };
    const serial = await timeLoad("?debug&nocache&workers=1");
    const parallel = await timeLoad("?debug&nocache&workers=3");
    expect(await workers(page)).toBe(3);
    console.log(`serial ${serial} ms, parallel ${parallel} ms`);
    expect(parallel).toBeLessThan(serial * 0.7);
  });

  test("cross-worker dependency gives the same geometry", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?debug&nocache&workers=2");
    await cad.call("set_part_script", { name: "a", source: slow(1500, 10) });
    await cad.call("set_part_script", { name: "b", source: slow(1500, 6).replace("makeBaseBox(6, 6, 6)", "makeBaseBox(6, 6, 6).translate([20, 0, 0])") });
    await cad.call("set_part_script", { name: "c", source: `const main = () => part("a").fuse(part("b"));` });
    const serialVol = json(await cad.call("get_part", { name: "c" })).volume;
    await page.reload();
    await allOk(page, 3);
    expect(await workers(page)).toBe(2);
    expect(await page.evaluate(() => (globalThis as unknown as { cadEngine: { transfers: number } }).cadEngine.transfers)).toBeGreaterThanOrEqual(1);
    expect(await builds(page)).toBe(3); // nothing rebuilt for the transfer
    expect(json(await cad.call("get_part", { name: "c" })).volume).toBeCloseTo(serialVol, 6);
    expect(serialVol).toBeCloseTo(1000 + 216, 3);
  });

  test("timeout kills one worker and does not rebuild finished parts", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?debug&nocache&workers=2&buildTimeout=2000");
    await cad.call("create_primitive", { name: "a", primitive: { type: "box", width: 10, depth: 10, height: 10 } });
    await cad.call("create_primitive", { name: "b", primitive: { type: "sphere", radius: 5 } });
    const before = await builds(page);
    const r = await cad.call("set_part_script", { name: "loop", source: "const main = () => { for(;;){} }" });
    expect(text(r)).toMatch(/timed out/);
    expect(await builds(page)).toBe(before + 1);
    await expect(page.locator('[data-part="a"]')).toHaveAttribute("data-status", "ok");
    await expect(page.locator('[data-part="b"]')).toHaveAttribute("data-status", "ok");
    // A dependent still works (shape copied or rebuilt on demand)
    const d = await cad.call("set_part_script", { name: "d", source: `const main = () => part("a").fuse(part("b").translate([20, 0, 0]));` });
    expect(d.isError, text(d)).toBe(false);
  });

  test("cache: reload builds nothing; param change builds only what it affects", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?debug&workers=2");
    await cad.call("set_params_form", { params: [
      { name: "w", label: "W", type: "number", default: 10 },
      { name: "h", label: "H", type: "number", default: 4 },
    ] });
    await cad.call("set_part_script", { name: "a", source: `const main = () => makeBaseBox(param("w"), 10, 10);` });
    await cad.call("set_part_script", { name: "b", source: `const main = () => part("a").fuse(makeBaseBox(2, 2, param("h")).translate([0, 0, 10]));` });
    await cad.call("set_part_script", { name: "c", source: `const main = () => makeSphere(3);` });
    await page.waitForTimeout(300); // cache writes are async
    await page.reload();
    await allOk(page, 3);
    expect(await builds(page)).toBe(0);
    // b reads h and needs a's shape, which came from the cache
    const r = await cad.call("set_param_values", { values: { h: 8 } });
    expect(r.isError, text(r)).toBe(false);
    expect(json(r).rebuilt.map((p: { name: string }) => p.name)).toEqual(["b"]);
    expect(await builds(page)).toBe(2); // a (shape only) + b
    expect(json(await cad.call("get_part", { name: "b" })).volume).toBeCloseTo(1000 + 32, 3);
    // Going back to a cached combination builds nothing
    await cad.call("set_param_values", { values: { h: 4 } });
    expect(await builds(page)).toBe(2);
    expect(json(await cad.call("get_part", { name: "b" })).volume).toBeCloseTo(1000 + 16, 3);
  });
});
