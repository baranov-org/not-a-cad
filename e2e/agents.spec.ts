import type { Browser, Page } from "@playwright/test";
import { expect, exportFromDialog, openApp, openLog, shown, requestFor, startAuth, test, text } from "./fixtures";

// Catches the client's redirect target so we can read the code or error
async function catchRedirect(page: Page) {
  let url: URL | undefined;
  await page.route("http://localhost:9/**", (r) => {
    url = new URL(r.request().url());
    return r.fulfill({ body: "client callback" });
  });
  return () => url;
}

// Browser context that remembers a workspace (opened / once)
async function withWorkspace(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("library-empty")).toBeVisible();
  return { ctx, page, ws: (await page.evaluate(() => localStorage.getItem("cad.workspace")))! };
}

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { value: h ? "hidden" : "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: h, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

test.describe("consent page", () => {
  test("Allow returns a code to the client; the agent then works", async ({ browser, baseURL }) => {
    const { ctx, page, ws } = await withWorkspace(browser);
    const a = await startAuth(baseURL!, { name: "Claude Code" });
    const got = await catchRedirect(page);
    await page.goto(`/connect/${a.requestId}`);
    await expect(page.getByTestId("approval")).toContainText("Allow Claude Code to control this workspace?");
    await expect(page.getByTestId("unrecognised")).toHaveCount(0);
    await expect(page.getByText("publish or unpublish shares")).toBeVisible();
    await page.getByRole("button", { name: "Allow" }).click();
    await expect.poll(() => got()?.searchParams.get("code")).toBeTruthy();
    expect(got()!.searchParams.get("state")).toBe("st");
    // Listed in Connected agents
    const r = await (await fetch(`${baseURL}/api/w/${ws}/agents`)).json();
    expect(r.agents.map((x: { name: string }) => x.name)).toEqual(["Claude Code"]);
    await ctx.close();
  });

  test("Deny returns access_denied; unknown clients get a warning", async ({ browser, baseURL }) => {
    const { ctx, page } = await withWorkspace(browser);
    const a = await startAuth(baseURL!, { name: "totally-legit-tool" });
    const got = await catchRedirect(page);
    await page.goto(`/connect/${a.requestId}`);
    await expect(page.getByTestId("unrecognised")).toBeVisible();
    await page.getByRole("button", { name: "Deny" }).click();
    await expect.poll(() => got()?.searchParams.get("error")).toBe("access_denied");
    expect(got()!.searchParams.get("error_description")).toMatch(/^DENIED: /);
    await ctx.close();
  });

  test("a browser without a workspace can't allow until it picks one", async ({ browser, baseURL }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const a = await startAuth(baseURL!);
    await page.goto(`/connect/${a.requestId}`);
    await expect(page.getByTestId("no-workspace")).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow" })).toBeDisabled();
    await page.getByRole("button", { name: "New workspace" }).click();
    await expect(page.getByTestId("workspace-picker")).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow" })).toBeEnabled();
    await ctx.close();
  });
});

test.describe("approval in the workspace", () => {
  test("approve from the tab; queued requests; background title; the consent page completes", async ({ page, sessionId, baseURL, browser }) => {
    await openApp(page, sessionId);
    const a = await requestFor(baseURL!, sessionId, "Claude Code");
    const b = await requestFor(baseURL!, sessionId, "Cursor");
    await expect(page.getByRole("dialog")).toContainText("Allow Claude Code to control this workspace?");
    await expect(page.getByTestId("request-count")).toHaveText("Request 1 of 2");
    await expect(page.getByTestId("agent-pill")).toHaveText("Approval needed");
    await setHidden(page, true);
    await expect.poll(() => page.title()).toBe("(2) Approve agent · not-a-cad");
    await setHidden(page, false);

    // The client's consent page notices the tab's answer and redirects
    const ctx = await browser.newContext();
    const consent = await ctx.newPage();
    const got = await catchRedirect(consent);
    await consent.goto(`/connect/${a.requestId}`);
    await expect(consent.getByTestId("approval")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Allow" }).click();
    await expect.poll(() => got()?.searchParams.get("code"), { timeout: 10_000 }).toBeTruthy();
    await ctx.close();

    await expect(page.getByRole("dialog")).toContainText("Allow Cursor to control this workspace?");
    await page.getByRole("dialog").getByRole("button", { name: "Deny" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await (await fetch(`${baseURL}/oauth/requests/${b.requestId}`)).json()).status).toBe("denied");
  });

  test("requests expire after the TTL", async ({ page, sessionId, baseURL }) => {
    await openApp(page, sessionId);
    await requestFor(baseURL!, sessionId);
    await expect(page.getByRole("dialog")).toBeVisible();
    // e2e server: 15 s
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 25_000 });
    await expect(page.getByTestId("agent-pill")).not.toHaveText("Approval needed");
  });
});

test.describe("connected agents", () => {
  test("pill shows the running tool; revoke cuts access", async ({ page, sessionId, cad, baseURL }) => {
    await openApp(page, sessionId);
    const pill = page.getByTestId("agent-pill");
    const slow = `const main = () => { const t = Date.now(); while (Date.now() - t < 4000); return makeBaseBox(1, 1, 1); };`;
    const call = cad.call("set_part_script", { name: "slow", source: slow });
    await expect(pill).toHaveText("e2e agent · set_part_script");
    await expect(pill).toHaveClass(/busy/);
    await call;
    await expect(pill).toHaveText("e2e agent");

    await pill.click();
    const pop = page.getByTestId("agents-popover");
    await expect(pop.getByTestId("mcp-url")).toHaveText(`${baseURL}/mcp`);
    await expect(pop).toContainText("claude mcp add --transport http not-a-cad");
    await pop.locator('[data-agent="e2e agent"]').getByRole("button", { name: "Revoke" }).click();
    await expect(pop.locator('[data-agent="e2e agent"]')).toHaveCount(0);
    const r = await fetch(`${baseURL}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${cad.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()).error_description).toMatch(/^REVOKED: /);
  });

  test("setup from the popover with no agents", async ({ page, sessionId }) => {
    await openApp(page, sessionId);
    await page.getByTestId("agent-pill").click();
    await expect(page.getByTestId("agents-popover")).toContainText("New agents ask for your approval once");
  });
});

test.describe("activity", () => {
  test("agent and user actions appear; entries link to parts", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_params_form", { params: [{ name: "w", label: "Width", type: "slider", min: 5, max: 60, step: 1, default: 20 }] });
    await cad.call("set_part_script", { name: "block", source: `const main = () => makeBaseBox(param("w"), 10, 10);` });
    await cad.call("set_assembly", { instances: [{ part: "block" }] });
    await cad.call("set_param_values", { values: { w: 30 } });
    await expect(page.locator('[data-part="block"]')).toHaveAttribute("data-status", "ok");
    await page.locator('[data-param="w"] input[type=range]').fill("35");
    const log = await openLog(page, "you");
    const first = log.getByTestId("log-row").first();
    await expect(first).toContainText(/You\s*changed parameter w 30 → 35/);
    await log.getByTestId("log-filter-agent").click();
    await expect(log).toContainText(/e2e agent\s*changed parameter w 20 → 30/);
    await expect(log).toContainText(/e2e agent\s*set script of part block/);
    // Builds are in the same log
    await log.getByTestId("log-filter-all").click();
    await expect(log).toContainText(/not-a-cad\s*Built 1 part in/);
    await page.getByTestId("console-close").click();
    await page.getByTestId("assembly-row").click();
    await exportFromDialog(page, { format: "stl", parts: true, assembled: true });
    await openLog(page, "you");
    await expect(first).toContainText(/You\s*exported assembly.zip/);
    expect(text(await cad.call("get_workspace_link"))).toContain(`/w/${sessionId}`);
    await log.getByTestId("log-filter-agent").click();
    await expect(first).toContainText(/e2e agent\s*asked for the workspace link/);
    await expect(page.getByTestId("console-latest")).toContainText(/e2e agent\s*asked for the workspace link/);
    await log.getByRole("button", { name: "block" }).first().click();
    await expect(shown(page)).toHaveText(/^block,/);
  });
});
