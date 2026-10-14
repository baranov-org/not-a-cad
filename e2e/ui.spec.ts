import type { Page } from "@playwright/test";
import { expect, json, openApp, openLog, resourceBytes, test, text } from "./fixtures";
import { bracket } from "./models";

const box = (w = 10) => `const main = () => makeBaseBox(${w}, 10, 10);`;
// Busy-waits in the worker so a build takes about ms
const slow = (ms: number, size = "param(\"w\")") =>
  `const main = () => { const t = Date.now(); while (Date.now() - t < ${ms}); return makeBaseBox(${size}, 10, 10); };`;
const bg = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).backgroundColor);
const width = (page: Page, testid: string) => page.getByTestId(testid).evaluate((e) => Math.round(e.getBoundingClientRect().width));

async function dragBy(page: Page, testid: string, dx: number) {
  const b = (await page.getByTestId(testid).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 200);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + 200, { steps: 5 });
  await page.mouse.up();
}

test.describe("tokens", () => {
  test("panels and canvas use the design tokens; no theme toggle", async ({ page, sessionId }) => {
    await openApp(page, sessionId);
    expect(await bg(page, ".side.left")).toBe("rgb(246, 247, 248)"); // --surface
    expect(await page.locator(".viewport > div").first().evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(225, 228, 232)"); // --canvas
    await expect(page.getByTestId("theme-toggle")).toHaveCount(0);
  });
});

test.describe("panels", () => {
  test("resize limits, reset, viewport minimum, collapse with keys and memory", async ({ page, sessionId }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page, sessionId);
    await expect.poll(() => width(page, "left-panel")).toBe(300);
    await expect.poll(() => width(page, "right-panel")).toBe(340);
    await dragBy(page, "resize-left", 400);
    await expect.poll(() => width(page, "left-panel")).toBe(480);
    // Dragged past half the minimum: collapses to a rail; clicking the grip reopens at the last width
    await dragBy(page, "resize-left", -400);
    await expect(page.getByTestId("left-panel")).toHaveCount(0);
    await page.getByTestId("resize-left").click();
    await expect.poll(() => width(page, "left-panel")).toBe(480);
    await dragBy(page, "resize-left", -270);
    await expect.poll(() => width(page, "left-panel")).toBe(220);
    // Released near the default width: snaps to it
    await dragBy(page, "resize-left", 72);
    await expect.poll(() => width(page, "left-panel")).toBe(300);
    // Clicking the grip collapses; arrow keys reopen and resize
    await page.getByTestId("resize-left").click();
    await expect(page.getByTestId("left-panel")).toHaveCount(0);
    await page.getByTestId("resize-left").click();
    await page.getByTestId("resize-left").press("ArrowRight");
    await expect.poll(() => width(page, "left-panel")).toBe(316);
    // The viewport keeps 320 px: 1000 - 316 - 320 = 364
    await page.setViewportSize({ width: 1000, height: 900 });
    await dragBy(page, "resize-right", -400);
    await expect.poll(() => width(page, "right-panel")).toBe(364);

    await page.keyboard.press("p");
    await expect(page.getByTestId("right-panel")).toHaveCount(0);
    await expect(page.getByTestId("show-right")).toHaveText("Parameters");
    await page.keyboard.press("l");
    await expect(page.getByTestId("left-panel")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    await expect(page.getByTestId("right-panel")).toHaveCount(0);
    await page.getByTestId("show-left").click();
    await page.getByTestId("show-right").click();
    await expect.poll(() => width(page, "right-panel")).toBe(364);
  });

  test("Esc closes the topmost modal; at most 3 toasts", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "a", primitive: { type: "sphere", radius: 5 } });
    await page.getByTestId("share-open").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("share-dialog")).toHaveCount(0);
    // Four deletes, four undo toasts: only the last 3 show
    for (let i = 0; i < 4; i++) await page.request.post(`/api/w/${sessionId}/projects`, { data: {} });
    await page.getByRole("link", { name: "not-a-cad" }).click();
    await expect(page.locator(".card")).toHaveCount(5);
    for (let i = 0; i < 4; i++) {
      await page.locator(".card").last().getByRole("button", { name: "Project actions" }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
    }
    await expect(page.locator(".card")).toHaveCount(1);
    await expect(page.getByTestId("toast")).toHaveCount(3);
  });
});

test.describe("view toolbar and keyboard", () => {
  test("standard views by key, highlight clears on orbit, section and typing", async ({ page, sessionId, cad }) => {
    await page.setViewportSize({ width: 1500, height: 900 }); // full view toolbar (compact below 700 px of viewport)
    await openApp(page, sessionId);
    await cad.call("set_params_form", { params: [{ name: "tag", label: "Tag", type: "text", default: "A" }] });
    await cad.call("create_primitive", { name: "a", primitive: { type: "box", width: 20, depth: 20, height: 20 } });
    const tb = page.getByTestId("view-toolbar");
    await page.keyboard.press("3");
    await expect(tb.getByRole("button", { name: "Top" })).toHaveAttribute("aria-pressed", "true");
    await expect(tb.getByRole("button", { name: "Top" })).toHaveAttribute("title", "Top (3)");
    const vp = (await page.locator(".viewport").boundingBox())!;
    await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
    await page.mouse.down();
    await page.mouse.move(vp.x + vp.width / 2 + 80, vp.y + vp.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    await expect(tb.locator("[aria-pressed=true]")).toHaveCount(0);
    await page.keyboard.press("s");
    await expect(page.getByTestId("section-bar")).toBeVisible();
    await expect(page.getByTestId("console-state")).toContainText("Section · 1 plane");
    // Typing in a field doesn't trigger shortcuts
    const tag = page.locator('[data-param="tag"] input');
    await tag.fill("");
    await tag.type("ss");
    await expect(page.getByTestId("section-bar")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("s");
    await expect(page.getByTestId("section-bar")).toHaveCount(0);
  });
});

test.describe("build feedback", () => {
  test("statuses: time, cached, building bar, failed card; hidden instance dimmed", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?debug");
    await cad.call("set_params_form", { params: [{ name: "w", label: "W", type: "number", default: 10 }] });
    await cad.call("set_part_script", { name: "fast", source: box() });
    await expect(page.locator('[data-part="fast"] .st')).toHaveText(/^\d+ ms$|^\d+\.\d s$/);
    const call = cad.call("set_part_script", { name: "slow", source: slow(2500) });
    await expect(page.locator('[data-part="slow"] .st.building')).toBeVisible();
    await expect(page.locator('[data-part="slow"] .pbar')).toBeVisible();
    await call;
    await cad.call("set_assembly", { instances: [{ part: "fast" }, { part: "slow", position: [20, 0, 0] }] });
    await page.locator('[data-instance="0"] button.eye').click();
    await expect(page.locator('[data-instance="0"]')).toHaveClass(/off/);
    // Reload: everything comes from the cache
    await page.reload();
    await expect(page.locator('[data-part="slow"] .st')).toHaveText("cached", { timeout: 60_000 });
    // Error card: one line, expands to the full message with Copy
    await cad.call("set_part_script", { name: "bad", source: "const main = () => { throw new Error('Thread sweep failed\\nat line 3'); };" });
    const card = page.locator('[data-part="bad"] [data-testid="error-card"]');
    await expect(page.locator('[data-part="bad"] .st')).toHaveText("Failed");
    await expect(card).toContainText("Build failed");
    await expect(card.locator(".err-msg")).toHaveCount(0);
    await card.getByRole("button", { name: /Build failed/ }).click();
    await expect(card.locator(".err-msg")).toContainText("Thread sweep failed");
    await expect(card.getByRole("button", { name: "Copy" })).toBeVisible();
  });

  test("slow rebuild: chip shows elapsed vs last, old shape stays; failure keeps last good, export leaves it out", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?nocache");
    await cad.call("set_params_form", { params: [{ name: "w", label: "W", type: "number", default: 10 }] });
    await cad.call("set_part_script", { name: "slow", source: slow(3000) });
    await cad.call("set_part_script", { name: "other", source: box(5) });
    await cad.call("set_assembly", { instances: [{ part: "slow" }, { part: "other", position: [30, 0, 0] }] });
    const rebuild = cad.call("set_param_values", { values: { w: 12 } });
    const chip = page.getByTestId("console-build");
    await expect(chip).toContainText("Rebuilding 1 part");
    const log = await openLog(page);
    await expect(log.locator('[data-chip-part="slow"]')).toContainText(/\d+\.\d s \/ ~3\.\d s/);
    // The ghosted previous shape is still drawn
    expect(await page.locator('[data-part="slow"]').getAttribute("data-status")).toBe("building");
    await rebuild;
    await expect(chip).toHaveCount(0);

    await expect(log.getByTestId("log-row").first()).toContainText(/Built 1 part in \d/);
    await page.getByTestId("console-close").click();

    // A parameter that makes it fail keeps the last good shape, tinted; the console shows the failure
    await cad.call("set_part_script", { name: "slow", source: `const main = () => { if (param("w") > 20) throw new Error("too wide"); return makeBaseBox(param("w"), 10, 10); };` });
    await cad.call("set_param_values", { values: { w: 30 } });
    await expect(page.getByTestId("console-failed")).toHaveText(/1 failed/);
    await expect(page.getByTestId("console-latest")).toContainText("slow failed");
    const zip = resourceBytes(await cad.call("export", {}));
    expect(text(await cad.call("export", {}))).toContain("skippedFailedParts");
    expect(zip.bytes.length).toBeGreaterThan(0);
    await page.getByTestId("console-failed").click();
    const problems = page.getByTestId("console-log");
    await expect(problems.getByTestId("log-filter-problems")).toHaveAttribute("aria-selected", "true");
    const failure = problems.getByTestId("log-row").filter({ hasText: "slow failed too wide" });
    await failure.getByRole("button", { name: "Details" }).click();
    await expect(page.locator('[data-part="slow"] .err-msg')).toContainText("too wide");
  });
});

test.describe("parameters", () => {
  test("inline range message; filter for long forms", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    const params = Array.from({ length: 24 }, (_, i) => ({
      name: `p${i}`, label: i % 6 === 0 ? `Hole ${i}` : `Size ${i}`, type: "number", default: 10, max: 20, unit: "mm", group: i < 12 ? "a" : "b",
    }));
    await cad.call("set_params_form", { groups: [{ id: "a", label: "A" }, { id: "b", label: "B" }], params });
    const f = page.locator('[data-param="p1"] input');
    await f.fill("50");
    await f.press("Enter");
    await expect(page.locator('[data-param="p1"] .msg')).toHaveText("Max 20 mm");
    await expect(page.locator('[data-param="p1"] .stepper')).toHaveClass(/invalid/);
    await page.getByTestId("params-filter").fill("hole");
    await expect(page.locator("[data-param]")).toHaveCount(4);
    await expect(page.locator('[data-group="a"] [data-param]')).toHaveCount(2);
    await expect(page.locator('[data-group="b"] .pgroup-head .count')).toHaveText("12 fields");
  });
});

test.describe("layout details", () => {
  test("parameters name the agent that defined them", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_params_form", { params: [{ name: "w", label: "W", type: "number", default: 1 }] });
    await expect(page.getByTestId("right-panel")).toContainText("Set by e2e agent.");
  });

  test("onboarding closes with ×, stays above the toolbar on short viewports", async ({ page, sessionId }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await openApp(page, sessionId);
    const card = page.getByTestId("onboarding");
    const c = (await card.boundingBox())!;
    const t = (await page.getByTestId("view-toolbar").boundingBox())!;
    expect(c.y + c.height).toBeLessThanOrEqual(t.y);
    // Taller than the space: the card scrolls itself
    expect(await card.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    await card.getByRole("button", { name: "Close" }).click();
    await expect(card).toHaveCount(0);
  });

  test("assembly chevron keeps its size in a narrow parts panel", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "a", primitive: { type: "sphere", radius: 2 } });
    await cad.call("set_assembly", { instances: Array.from({ length: 12 }, (_, i) => ({ part: "a", position: [i * 5, 0, 0] })) });
    for (let i = 0; i < 12; i++) await page.locator(`[data-instance="${i}"] button.eye`).click();
    const b = (await page.getByTestId("resize-left").boundingBox())!;
    await page.mouse.move(b.x + 6, b.y + 200);
    await page.mouse.down();
    await page.mouse.move(b.x - 100, b.y + 200, { steps: 5 });
    await page.mouse.up();
    const tog = (await page.getByTestId("instances-toggle").boundingBox())!;
    expect(Math.round(tog.width)).toBe(28);
  });
});

test.describe("onboarding", () => {
  test("step 1 without an agent, step 2 once connected, gone on the first part", async ({ page, sessionId, baseURL }) => {
    await openApp(page, sessionId);
    const card = page.getByTestId("onboarding");
    await expect(card).toHaveAttribute("data-step", "1");
    await expect(page.getByTestId("setup-snippet")).toHaveText(`claude mcp add --transport http not-a-cad ${baseURL}/mcp`);
    await card.getByRole("tab", { name: "Cursor" }).click();
    await expect(page.getByTestId("setup-snippet")).toContainText('"mcpServers"');
    const { mcpClient } = await import("./fixtures");
    const cad = await mcpClient(baseURL!, sessionId, "Claude Code");
    await cad.call("list_parts");
    await expect(card).toHaveAttribute("data-step", "2");
    await expect(card).toContainText("Ask for a part");
    await cad.call("create_primitive", { name: "a", primitive: { type: "sphere", radius: 5 } });
    await expect(card).toHaveCount(0);
    await cad.client.close();
  });
});

test.describe("share dialog", () => {
  test("not shared → published → out of date after a change → republish", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_model_info", { name: "Block" });
    await cad.call("set_params_form", { params: [{ name: "w", label: "W", type: "slider", default: 10, min: 5, max: 40 }] });
    await cad.call("set_part_script", { name: "block", source: box() });
    await page.getByTestId("share-open").click();
    const state = page.getByTestId("share-state");
    await expect(state).toContainText("Not shared");
    await page.getByTestId("publish").click();
    await expect(state).toContainText("Published");
    await expect(state).not.toContainText("out of date");
    await page.keyboard.press("Escape");
    await cad.call("set_param_values", { values: { w: 20 } });
    await page.getByTestId("share-open").click();
    await expect(state).toContainText("Published, out of date");
    await expect(page.getByTestId("publish")).toHaveText("Republish");
    await page.getByTestId("publish").click();
    await expect(state).not.toContainText("out of date");
  });
});

test.describe("narrow and layout", () => {
  test("400 px: no horizontal scroll, every tab reachable, bottom-sheet modals", async ({ page, sessionId, cad }) => {
    await page.setViewportSize({ width: 400, height: 860 });
    await openApp(page, sessionId);
    await cad.call("set_params_form", { params: [{ name: "w", label: "Width", type: "number", default: 10 }] });
    await cad.call("create_primitive", { name: "a", primitive: { type: "sphere", radius: 5 } });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
    const tabs = page.getByTestId("sheet-tabs");
    await expect(page.locator('[data-part="a"]')).toBeVisible();
    await tabs.getByRole("tab", { name: "Parameters" }).click();
    await expect(page.locator('[data-param="w"]')).toBeVisible();
    await expect(tabs.locator(".l")).toHaveText(["Parts", "Parameters"]);
    await openLog(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
    await page.getByTestId("console-close").click();
    await tabs.getByRole("tab", { name: "Parts" }).click();
    await page.getByTestId("share-open").click();
    const m = (await page.getByTestId("share-dialog").boundingBox())!;
    expect(Math.round(m.y + m.height)).toBe(860);
    expect(Math.round(m.width)).toBe(400);
  });

  test("narrow: the tab bar collapses, half-opens and drags the sheet; remembered; measure takes turns with it", async ({ page, sessionId, cad }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, sessionId);
    await cad.call("set_params_form", { params: [{ name: "w", label: "Width", type: "number", default: 10, min: 1, max: 50 }] });
    await cad.call("create_primitive", { name: "a", primitive: { type: "sphere", radius: 5 } });
    const bar = page.locator(".sheet-bar"), tabs = page.getByTestId("sheet-tabs"), sheet = page.getByTestId("sheet");
    const height = async () => Math.round((await sheet.boundingBox())?.height ?? 0);
    await expect(tabs.locator(".m")).toHaveText(["1 part", "defaults"]);
    await expect(bar).toHaveAttribute("data-det", "full");
    await expect(bar.getByRole("button", { name: "Export…" })).toHaveCount(0); // footer shown instead
    // Tapping the active tab collapses; footer actions move into the bar
    await tabs.getByRole("tab", { name: /Parts/ }).click();
    await expect(bar).toHaveAttribute("data-det", "col");
    await expect.poll(height).toBe(0);
    await expect(bar.getByRole("button", { name: "Export…" })).toBeVisible();
    // The other tab switches and reopens at the last height
    await tabs.getByRole("tab", { name: /Parameters/ }).click();
    await expect(bar).toHaveAttribute("data-det", "full");
    await expect(page.locator('[data-param="w"]')).toBeVisible();
    // Drag down slowly: snaps to half
    await page.waitForTimeout(400); // open animation
    const full = await height();
    const b = (await bar.boundingBox())!;
    const x = b.x + 40, y = b.y + 30;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + full - 0.2 * 844 + 10, { steps: 25 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await expect(bar).toHaveAttribute("data-det", "half");
    await expect.poll(height).toBe(Math.round(0.2 * 844));
    await expect(bar.getByRole("button", { name: "Reset to defaults" })).toBeDisabled();
    // Remembered on this device
    await page.reload();
    await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator(".sheet-bar")).toHaveAttribute("data-det", "half");
    await expect(tabs.getByRole("tab", { name: /Parameters/ })).toHaveAttribute("aria-selected", "true");
    // Measure: collapses the sheet; opening a tab shrinks measure to its pill; the pill collapses the sheet again; off restores
    await page.getByTestId("measure-toggle").click();
    await expect(bar).toHaveAttribute("data-det", "col");
    await expect(page.getByTestId("measure-card")).toBeVisible();
    await tabs.getByRole("tab", { name: /Parameters/ }).click();
    await expect(bar).toHaveAttribute("data-det", "half");
    await expect(page.getByTestId("measure-pill")).toBeVisible();
    await page.getByTestId("measure-pill").click();
    await expect(bar).toHaveAttribute("data-det", "col");
    await expect(page.getByTestId("measure-card")).toBeVisible();
    await page.getByTestId("measure-toggle").click();
    await expect(bar).toHaveAttribute("data-det", "half");
  });

  test("share viewer uses the workspace layout", async ({ page, sessionId, cad, browser }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, sessionId);
    await bracket(cad);
    await expect(page.locator('[data-part="board"]')).toHaveAttribute("data-status", "ok");
    await page.getByTestId("share-open").click();
    await page.getByTestId("publish").click();
    const url = (await page.getByTestId("share-url").textContent())!;
    await page.keyboard.press("Escape");
    const v = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await v.goto(url);
    await expect(v.locator('[data-part="board"]')).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
    const boxes = (p: Page) => Promise.all(["left-panel", "right-panel", "console", "parts", "view-toolbar"].map(async (id) => {
      const b = (await p.getByTestId(id).boundingBox())!;
      // The toolbar is centred; both have the Section button
      return id === "view-toolbar" ? [id, Math.round(b.x + b.width / 2)] : [id, Math.round(b.x), Math.round(b.width)];
    }));
    expect(await boxes(v)).toEqual(await boxes(page));
    // Same styles for the shared pieces
    expect(await bg(v, '[data-part="board"] .part-row')).toBe(await bg(page, '[data-part="board"] .part-row'));
    // Only mode-specific elements differ
    await expect(v.getByTestId("agent-pill")).toHaveCount(0);
    await expect(v.getByTestId("switcher")).toHaveCount(0);
    await expect(v.getByTestId("tab-activity")).toHaveCount(0);
    await expect(v.getByTestId("share-open")).toHaveCount(0);
    await expect(v.getByTestId("fork")).toBeVisible();
    await expect(v.getByTestId("export")).toHaveText("Download STL");
    expect(json(await cad.call("get_params")).values.depth).toBe(200);
    await v.close();
  });
});
