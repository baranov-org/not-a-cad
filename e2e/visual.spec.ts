import type { Page } from "@playwright/test";
import { expect, openApp, requestFor, test } from "./fixtures";
import { bracket } from "./models";

// Screenshots of the main states for a visual check against docs/design (written to test-results/visual)
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/visual/${name}.png` });

test.describe("visual", () => {
  test("workspace states, library, dialogs, narrow; share viewer", async ({ page, sessionId, cad, browser, baseURL }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, sessionId);
    await shot(page, "onboarding");
    await bracket(cad);
    await expect(page.locator('[data-part="board"]')).toHaveAttribute("data-status", "ok");
    await page.waitForTimeout(800);
    await shot(page, "workspace");

    // Building: a slow part, chip expanded
    const slow = `const main = () => { const t = Date.now(); while (Date.now() - t < 4000); return makeBaseBox(20, 20, 4); };`;
    const call = cad.call("set_part_script", { name: "screw", source: slow });
    await page.getByTestId("console-toggle").click();
    await page.waitForTimeout(1200);
    await shot(page, "building");
    await call;
    await page.getByTestId("console-close").click();

    // Error card open
    await cad.call("set_part_script", { name: "screw", source: "const main = () => { throw new Error('Thread sweep failed: pitch 0.8 mm is too tight'); };" });
    await page.locator('[data-part="screw"]').getByRole("button", { name: /Build failed/ }).click();
    await shot(page, "error");
    await cad.call("delete_part", { name: "screw" });

    await page.getByTestId("agent-pill").click();
    await shot(page, "agents-popover");
    await page.keyboard.press("Escape");
    await page.getByTestId("save-link").click();
    await shot(page, "link-popover");
    await page.keyboard.press("Escape");
    await page.getByTestId("switcher").click();
    await shot(page, "switcher");
    await page.keyboard.press("Escape");

    await page.getByTestId("share-open").click();
    await page.getByTestId("publish").click();
    const url = (await page.getByTestId("share-url").textContent())!;
    await shot(page, "share-dialog");
    await page.keyboard.press("Escape");

    await requestFor(baseURL!, sessionId, "Claude Code");
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "agent-request");
    await page.getByRole("dialog").getByRole("button", { name: "Deny" }).click();

    await page.getByTestId("console-toggle").click();
    await shot(page, "log");
    await page.getByTestId("console-close").click();

    // Library with a few projects and badges
    for (const name of ["Cable clip 6 mm", "PCB enclosure 60×40"]) await page.request.post(`/api/w/${sessionId}/projects`, { data: { name } });
    await page.locator(".logo").click();
    await expect(page.locator(".card")).toHaveCount(3);
    await page.locator(".card").first().getByRole("button", { name: "Project actions" }).click();
    await shot(page, "library");
    await page.keyboard.press("Escape");

    await page.goBack();
    await page.setViewportSize({ width: 400, height: 860 });
    await page.waitForTimeout(800);
    await shot(page, "workspace-narrow");

    const v = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await v.goto(url);
    await expect(v.locator('[data-part="board"]')).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
    await v.waitForTimeout(800);
    await shot(v, "share-viewer");
    await v.setViewportSize({ width: 400, height: 860 });
    await v.waitForTimeout(500);
    await shot(v, "share-narrow");
    await v.goto("/s/AAAAAAAAAAAAAAAAAAAAAA");
    await shot(v, "share-not-found");
    await v.close();
  });
});
