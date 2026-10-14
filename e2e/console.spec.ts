import type { Page } from "@playwright/test";
import { expect, openApp, openLog, publishShare, requestFor, test } from "./fixtures";

const box = { type: "box", width: 20, depth: 10, height: 2 };
const rect = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())!;

test.describe("console", () => {
  test.use({ viewport: { width: 1280, height: 760 } });

  test("bar spans the window under both panels; the log slides over them and closes by bar, ×, Esc; open state is remembered", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "plate", primitive: box });
    const bar = page.getByTestId("console");
    await expect(page.getByTestId("console-latest")).toContainText(/not-a-cad\s*Built 1 part in/);
    await expect(page.getByTestId("statusline")).toContainText("plate, 20 × 10 × 2 mm");
    // No instances: no Assembly entry; the part is shown
    await expect(page.getByTestId("assembly-row")).toHaveCount(0);
    await cad.call("set_assembly", { instances: [{ part: "plate" }] });
    await expect(page.getByTestId("assembly-row")).toContainText("1 instance");
    await cad.call("set_assembly", { instances: [] });
    await expect(page.getByTestId("assembly-row")).toHaveCount(0);
    await expect(page.getByTestId("statusline")).toContainText("plate,");
    // Right panel: Parameters only
    await expect(page.getByTestId("tab-activity")).toHaveCount(0);
    await expect(page.getByTestId("right-panel")).toContainText("Parameters");

    const b = await rect(page, "console");
    expect(Math.round(b.x)).toBe(0);
    expect(Math.round(b.width)).toBe(1280);
    expect((await rect(page, "left-panel")).y + (await rect(page, "left-panel")).height).toBeLessThanOrEqual(b.y + 1);
    await page.keyboard.press("l");
    await page.keyboard.press("p");
    expect(Math.round((await rect(page, "console")).width)).toBe(1280);
    await page.keyboard.press("l");
    await page.keyboard.press("p");

    // Opens over the panels without resizing them
    const left = await rect(page, "left-panel");
    await bar.click({ position: { x: 640, y: 20 } });
    const log = page.getByTestId("console-log");
    await expect(log).toBeVisible();
    await expect(page.getByTestId("console-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(await rect(page, "left-panel")).toEqual(left);
    const l = await rect(page, "console-log");
    expect(l.y).toBeLessThan(left.y + left.height);
    await expect(log).toContainText("Built 1 part");
    await bar.click({ position: { x: 640, y: 20 } });
    await expect(log).toBeHidden();
    await page.getByTestId("console-toggle").click();
    await page.getByTestId("console-close").click();
    await expect(log).toBeHidden();
    await page.getByTestId("console-toggle").click();
    await page.keyboard.press("Escape");
    await expect(log).toBeHidden();

    await page.getByTestId("console-toggle").click();
    await page.reload();
    await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    await expect(page.getByTestId("console-log")).toBeVisible();
  });

  test("a long parameters form scrolls under a full-height panel header", async ({ page, sessionId, cad }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await openApp(page, sessionId);
    const params = Array.from({ length: 60 }, (_, i) => ({ name: `p${i}`, label: `Param ${i}`, type: "number", default: i, unit: "mm" }));
    await cad.call("set_params_form", { params });
    const panel = page.getByTestId("right-panel");
    await expect(panel.locator('[data-param="p59"]')).toBeAttached();
    const head = (await panel.locator(".panel-head").boundingBox())!;
    const scroll = (await panel.locator(".scroll").boundingBox())!;
    expect(head.height).toBeGreaterThanOrEqual(40);
    expect(scroll.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
    // A divider separates the header from the scrolling form
    expect(await panel.locator(".panel-head").evaluate((e) => getComputedStyle(e).borderBottomWidth)).toBe("1px");
  });

  test("filters; approvals and See activity", async ({ page, sessionId, cad, baseURL }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "plate", primitive: box });
    await cad.call("set_part_script", { name: "bad", source: "const main = () => { throw new Error('boom') };" });
    await expect(page.getByTestId("console-failed")).toHaveText(/1 failed/);

    const log = await openLog(page, "build");
    await expect(log.getByTestId("log-row")).toHaveText([/not-a-cad\s*bad failed boom/, /not-a-cad\s*Built 1 part/]);
    await log.getByTestId("log-filter-agent").click();
    await expect(log.getByTestId("log-row")).toHaveText([/e2e agent\s*set script of part bad failed/, /e2e agent\s*created part plate box/]);
    await log.getByTestId("log-filter-problems").click();
    await expect(log.getByTestId("log-row")).toHaveCount(2);
    for (const r of await log.getByTestId("log-row").all()) await expect(r).toHaveAttribute("data-level", "error");
    await page.getByTestId("console-close").click();

    // A request opens the modal and is logged with Review until it is answered
    await requestFor(baseURL!, sessionId, "Cursor");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    const latest = page.getByTestId("console-latest");
    await expect(latest).toContainText(/Cursor\s*asks for approval/);
    await latest.getByRole("button", { name: "Review" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deny" }).click();
    await expect(latest).toContainText(/You\s*denied Cursor/);
    await openLog(page, "all");
    await expect(page.getByTestId("console-log").getByRole("button", { name: "Review" })).toHaveCount(0);
    await page.getByTestId("console-close").click();

    // See activity in Connected agents opens the log on All
    await page.getByTestId("console-toggle").click();
    await page.getByTestId("log-filter-build").click();
    await page.getByTestId("console-close").click();
    await page.getByTestId("agent-pill").click();
    await page.getByTestId("agents-popover").getByRole("button", { name: "See activity" }).click();
    await expect(page.getByTestId("console-log")).toBeVisible();
    await expect(page.getByTestId("log-filter-all")).toHaveAttribute("aria-selected", "true");
  });

  test("share viewer: status, section and local events; slow download offered in the bar; no agent filters", async ({ page, sessionId, cad, browser }) => {
    await openApp(page, sessionId);
    await cad.call("set_model_info", { name: "Plate" });
    await cad.call("create_primitive", { name: "plate", primitive: box });
    await expect(page.locator('[data-part="plate"]')).toHaveAttribute("data-status", "ok");
    const url = await publishShare(page);
    const v = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    await v.goto(url);
    await expect(v.locator('[data-part="plate"]')).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
    await expect(v.getByTestId("statusline")).toContainText("plate, 20 × 10 × 2 mm");
    // Building the file "takes" longer than the browser allows for a direct download
    await v.evaluate(() => {
      const now = performance.now.bind(performance);
      let n = 0;
      performance.now = () => now() + 1000 * n++;
    });
    // Section view works in the share viewer too
    await v.keyboard.press("s");
    await expect(v.getByTestId("section-bar")).toBeVisible();
    await expect(v.getByTestId("console-state")).toContainText("Section · 1 plane");
    await v.getByTestId("section-toggle").click();
    await expect(v.getByTestId("section-bar")).toHaveCount(0);
    await v.getByTestId("export").click();
    const latest = v.getByTestId("console-latest");
    await expect(latest).toContainText("plate-plate.stl is ready");
    const dl = v.waitForEvent("download");
    await latest.getByRole("button", { name: "Download" }).click();
    expect((await dl).suggestedFilename()).toBe("plate-plate.stl");
    await expect(v.locator(".toast")).toHaveCount(0);
    const log = await openLog(v);
    await expect(log.getByTestId("log-filter-agent")).toHaveCount(0);
    await expect(log.getByTestId("log-filter-you")).toHaveCount(0);
    await expect(log).toContainText("plate-plate.stl is ready");
    await v.close();
  });
});
