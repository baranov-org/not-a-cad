import type { Page } from "@playwright/test";
import { expect, json, openApp, openShare, test, text, openLog } from "./fixtures";

const sphere = { type: "sphere", radius: 5 };
const card = (page: Page, name: string) => page.locator(`.card[data-name="${name}"]`);
// Card ⋯ menu action
async function cardAction(page: Page, name: string, action: string) {
  await card(page, name).getByRole("button", { name: "Project actions" }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

// Pretend the tab went to the background (headless tabs are always visible)
const setVisible = (page: Page, visible: boolean) =>
  page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", { value: v ? "visible" : "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);

test.describe("projects", () => {
  test("library: create, rename, duplicate, delete with undo, search", async ({ page, sessionId }) => {
    await page.goto(`/w/${sessionId}`);
    await expect(page.getByTestId("library-empty")).toBeVisible();
    await page.getByTestId("new-project").click();
    await expect(page).toHaveURL(/\/p\/[A-Za-z0-9_-]{22}$/);
    await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    await page.getByRole("link", { name: "not-a-cad" }).click();
    await expect(page).toHaveURL(/\/$/);

    const c = card(page, "Untitled");
    await expect(c.locator(".badge")).toHaveText(["Open"]);
    await cardAction(page, "Untitled", "Rename");
    await page.getByLabel("Project name").fill("Wall mount");
    await page.getByLabel("Project name").press("Enter");
    await expect(card(page, "Wall mount")).toBeVisible();
    await cardAction(page, "Wall mount", "Duplicate");
    await expect(card(page, "Wall mount copy")).toBeVisible();

    await cardAction(page, "Wall mount copy", "Delete");
    await expect(card(page, "Wall mount copy")).toHaveCount(0);
    await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await expect(card(page, "Wall mount copy")).toBeVisible();

    await page.getByLabel("Search projects").fill("copy");
    await expect(page.locator(".card")).toHaveCount(1);
    await page.getByLabel("Search projects").fill("zzz");
    await expect(page.getByText("No projects match")).toBeVisible();
  });

  test("agent create_project: tab follows with a console notice; Back to; next result notes the switch", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_model_info", { name: "Wall mount" });
    await cad.call("create_primitive", { name: "a", primitive: sphere });
    const first = page.url();

    const r = await cad.call("create_project", { name: "Shelf bracket" });
    expect(r.isError, text(r)).toBeFalsy();
    await expect(page).not.toHaveURL(first);
    await expect(page.getByTestId("console-latest")).toContainText("e2e agent switched to Shelf bracket. You followed.");
    await expect(page.getByTestId("console-latest").getByRole("button", { name: "Back to Wall mount" })).toBeVisible();
    await expect(page.getByTestId("switcher")).toContainText("Shelf bracket");
    await cad.call("create_primitive", { name: "b", primitive: sphere });
    await expect(page.locator('[data-part="b"]')).toHaveAttribute("data-status", "ok");

    // Newer events took the bar; the notice and its action stay in the log
    const log = await openLog(page);
    await log.getByRole("button", { name: "Back to Wall mount" }).click();
    await expect(page).toHaveURL(first);
    await expect(page.locator('[data-part="a"]')).toHaveAttribute("data-status", "ok");
    await expect(log).toContainText("Your agent now works on Wall mount");
    // Back in Wall mount the switch notice no longer offers Back to
    await expect(log.getByRole("button", { name: /^Back to/ })).toHaveCount(0);
    await expect(page.locator(".toast")).toHaveCount(0);
    const next = await cad.call("list_parts");
    expect(text(next)).toMatch(/active project to "Wall mount"/);

    const list = JSON.parse((await cad.call("list_projects")).content[0].text!);
    expect(list.map((p: { name: string }) => p.name).sort()).toEqual(["Shelf bracket", "Wall mount"]);
  });

  test("switcher opens other projects; agent works on the open one", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_model_info", { name: "One" });
    await page.getByTestId("switcher").click();
    await page.getByRole("menuitem", { name: "New project" }).click();
    await expect(page.getByTestId("loading")).toBeHidden();
    await cad.call("set_model_info", { name: "Two" });
    await page.getByTestId("switcher").click();
    await page.getByRole("menuitem", { name: "One" }).click();
    await expect(page.getByTestId("switcher")).toContainText("One");
    await cad.call("create_primitive", { name: "x", primitive: sphere });
    await expect(page.locator('[data-part="x"]')).toHaveAttribute("data-status", "ok");
  });

  test("library opens a project when the agent calls a model tool", async ({ page, sessionId, cad }) => {
    await page.goto(`/w/${sessionId}`);
    await expect(page.getByTestId("conn")).toHaveText("connected");
    const r = await cad.call("create_primitive", { name: "a", primitive: sphere });
    expect(r.isError, text(r)).toBeFalsy();
    await expect(page).toHaveURL(/\/p\//);
    await expect(page.locator('[data-part="a"]')).toHaveAttribute("data-status", "ok");
  });

  test("changed-by-agent badge until opened; thumbnail after build", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_model_info", { name: "Hidden work" });
    await setVisible(page, false);
    await cad.call("create_primitive", { name: "a", primitive: sphere });
    await expect(page.locator('[data-part="a"]')).toHaveAttribute("data-status", "ok");
    // Debounced thumbnail upload after the build settles
    await page.waitForTimeout(3000);
    await page.getByRole("link", { name: "not-a-cad" }).click();
    const c = card(page, "Hidden work");
    await expect(c.getByText("Changed by agent")).toBeVisible();
    await expect(c.getByTestId("thumb")).toBeVisible();
    await setVisible(page, true);
    await c.getByRole("button", { name: "Open Hidden work" }).click();
    await expect(page.getByTestId("loading")).toBeHidden();
    await page.getByRole("link", { name: "not-a-cad" }).click();
    await expect(card(page, "Hidden work").getByText("Changed by agent")).toHaveCount(0);
  });

  test("save link: highlighted until copied; agent gets the link", async ({ page, context, sessionId, cad }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page, sessionId);
    const btn = page.getByTestId("save-link");
    await expect(btn).toHaveAttribute("data-saved", "false");
    await btn.click();
    await expect(page.getByTestId("workspace-url")).toHaveText(new RegExp(`/w/${sessionId}$`));
    await page.getByTestId("save-link-popover").getByRole("button", { name: "Copy" }).click();
    await expect(btn).toHaveAttribute("data-saved", "true");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/w/${sessionId}$`));
    await page.reload();
    await expect(page.getByTestId("save-link")).toHaveAttribute("data-saved", "true");
    expect(text(await cad.call("get_workspace_link"))).toMatch(new RegExp(`/w/${sessionId}$`));
  });

  test("fork a share into my projects with the visitor's values", async ({ page, sessionId, cad, browser }) => {
    await openApp(page, sessionId);
    await cad.call("set_model_info", { name: "Block" });
    await cad.call("set_params_form", { params: [{ name: "w", label: "Width", type: "slider", min: 5, max: 60, step: 1, default: 20 }] });
    await cad.call("set_part_script", { name: "block", source: `const main = () => makeBaseBox(param("w"), 10, 10);` });
    await openShare(page);
    await page.getByTestId("publish").click();
    const url = (await page.getByTestId("share-url").textContent())!;

    // Visitor with a remembered workspace
    const ctx = await browser.newContext();
    const v = await ctx.newPage();
    await v.goto("/");
    await expect(v.getByTestId("library-empty")).toBeVisible();
    await v.goto(url);
    await expect(v.locator('[data-part="block"]')).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
    await v.locator('[data-param="w"] input[type=range]').fill("33");
    // Sliders apply 350 ms after the last move
    await v.waitForTimeout(500);
    await v.getByTestId("fork").click();
    await expect(v).toHaveURL(/\/p\/[A-Za-z0-9_-]{22}$/);
    await expect(v.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    await expect(v.getByTestId("switcher")).toContainText("Block");
    await expect(v.locator('[data-param="w"] .readout')).toHaveText("33");
    await v.getByRole("link", { name: "not-a-cad" }).click();
    await expect(card(v, "Block").getByText("Forked from share")).toBeVisible();
    await ctx.close();

    // Original untouched
    expect(json(await cad.call("get_params")).values.w).toBe(20);
  });
});
