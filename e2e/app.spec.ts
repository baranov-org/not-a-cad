import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { expect, exportFromDialog, json, openApp, resourceBytes, shown, test, text } from "./fixtures";

const box = { type: "box", width: 10, depth: 20, height: 5 };

test.describe("workspace", () => {
  test("/ creates and remembers a workspace; its id never shows in the address bar; generic MCP URL", async ({ page, browser, baseURL }) => {
    await page.goto("/");
    await expect(page.getByTestId("library-empty")).toBeVisible();
    await expect(page).toHaveURL(`${baseURL}/`);
    const ws = (await page.evaluate(() => localStorage.getItem("cad.workspace")))!;
    expect(ws).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await page.getByTestId("new-project").first().click();
    await expect(page).toHaveURL(/\/p\/[A-Za-z0-9_-]{22}$/);
    const projectUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(projectUrl);
    await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    expect(page.url()).not.toContain(ws);
    // Only "Save your link" shows the workspace link
    await page.getByTestId("save-link").click();
    await expect(page.getByTestId("workspace-url")).toHaveText(new RegExp(`/w/${ws}$`));
    // While it's open the address bar holds the link (so ⌘D bookmarks it); closing restores the clean address
    await expect(page).toHaveURL(`${baseURL}/w/${ws}${new URL(projectUrl).pathname}`);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(projectUrl);
    // The project address alone opens nothing elsewhere
    const other = await browser.newContext();
    const o = await other.newPage();
    await o.goto(projectUrl);
    await expect(o.getByTestId("project-missing")).toBeVisible();
    // The bookmark link (Save your link) brings the workspace and leaves a clean address
    await o.goto(`/w/${ws}${new URL(projectUrl).pathname}?x=1`);
    await expect(o).toHaveURL(`${projectUrl}?x=1`);
    await expect(o.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    await expect(o.getByTestId("project-missing")).toHaveCount(0);
    expect(await o.evaluate(() => localStorage.getItem("cad.workspace"))).toBe(ws);
    await other.close();
    // The other browser took over the workspace
    await page.getByRole("button", { name: "Use this tab instead" }).click();
    // One generic MCP URL; the agent's approval picks the workspace
    await page.getByTestId("agent-pill").click();
    await expect(page.getByTestId("mcp-url")).toHaveText(/\/mcp$/);
  });

  test("background tab: agent screenshots and edits work with animation frames stopped; the tab holds a Web Lock", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "a", primitive: box });
    await expect(page.locator('[data-part="a"]')).toHaveAttribute("data-status", "ok");
    expect(await page.evaluate(async () => (await navigator.locks.query()).held!.some((l) => l.name!.startsWith("not-a-cad-tab-")))).toBe(true);
    // Like a hidden tab: no animation frames at all
    await page.evaluate(() => {
      window.requestAnimationFrame = () => 0;
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const t0 = Date.now();
    const shot = await cad.call("get_view_image", { part: "a", direction: "iso" });
    expect(shot.isError, text(shot)).toBeFalsy();
    expect(shot.content[0].type).toBe("image");
    expect(Date.now() - t0).toBeLessThan(15_000);
    const r = await cad.call("create_primitive", { name: "b", primitive: box });
    expect(r.isError, text(r)).toBeFalsy();
  });

  test("malformed links show not found", async ({ page }) => {
    await page.goto("/w/nope");
    await expect(page.getByTestId("not-found")).toBeVisible();
  });

  test("second tab supersedes first; take over", async ({ page, context, sessionId, cad }) => {
    await openApp(page, sessionId);
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.getByTestId("conn")).toHaveText("connected");
    await expect(page.getByTestId("conn")).toHaveText("active in another tab");
    await expect(page.getByTestId("paused")).toContainText("not-a-cad is open in another tab");
    await expect(page.getByTestId("agent-pill")).toHaveText("Paused · other tab");
    await page.getByRole("button", { name: "Use this tab instead" }).click();
    await expect(page.getByTestId("paused")).toHaveCount(0);
    await expect(page.getByTestId("conn")).toHaveText("connected");
    await expect(page2.getByTestId("conn")).toHaveText("active in another tab");
    await expect(page.getByTestId("loading")).toBeHidden();
    expect((await cad.call("list_parts")).isError).toBe(false);
  });

  test("reconnects after the connection drops", async ({ page, sessionId, cad }) => {
    const sockets: { close: (o: { code: number }) => Promise<void> }[] = [];
    await page.routeWebSocket(/\/ws\//, (ws) => {
      ws.connectToServer();
      sockets.push(ws);
    });
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "a", primitive: box });
    await expect(page.locator('[data-part="a"]')).toHaveAttribute("data-status", "ok");
    // Record any status change; an unchanged model must not rebuild on reconnect
    await page.evaluate(() => {
      const w = window as unknown as { statuses: string[] };
      w.statuses = [];
      new MutationObserver((ms) => ms.forEach((m) => w.statuses.push((m.target as Element).getAttribute("data-status")!)))
        .observe(document.querySelector('[data-testid="parts"]')!, { attributes: true, attributeFilter: ["data-status"], subtree: true });
    });
    await sockets[0].close({ code: 3000 });
    await expect(page.getByTestId("conn")).toHaveText("disconnected");
    await expect(page.getByTestId("reconnecting")).toHaveText("Reconnecting…");
    await expect(page.getByTestId("console-latest")).toContainText("Connection lost. Reconnecting… Your project is safe in this browser");
    await expect(page.getByTestId("agent-pill")).toHaveText("Reconnecting…");
    await expect(page.getByTestId("conn")).toHaveText("connected", { timeout: 15_000 });
    await expect(page.getByTestId("reconnecting")).toHaveCount(0);
    await expect(page.getByTestId("console-latest")).toContainText("Reconnected");
    expect(sockets.length).toBe(2);
    expect((await cad.call("list_parts")).isError).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { statuses: string[] }).statuses)).toEqual([]);
  });
});

test.describe("parts and assembly", () => {
  test("parts list updates live and shows errors", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "plate", primitive: box });
    const item = page.locator('[data-part="plate"]');
    await expect(item).toHaveAttribute("data-status", "ok");
    await cad.call("set_part_script", { name: "broken", source: "const main = () => { throw new Error('nope') }" });
    const bad = page.locator('[data-part="broken"]');
    await expect(bad).toHaveAttribute("data-status", "error");
    await expect(bad.locator(".st")).toHaveText("Failed");
    await bad.getByRole("button", { name: /Build failed/ }).click();
    await expect(bad.locator(".err-msg")).toHaveText("nope");
    await expect(page.getByTestId("export")).toBeDisabled();
    await item.locator(".part-row").click();
    await expect(shown(page)).toHaveText(/^plate,/);
    await expect(page.getByTestId("export")).toBeEnabled();
  });

  test("delete is refused for referenced parts and cleans assembly", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "a", primitive: box });
    await cad.call("create_primitive", { name: "b", primitive: { type: "sphere", radius: 3 } });
    await cad.call("boolean_op", { name: "c", op: "union", target: "a", tools: ["b"] });
    let r = await cad.call("delete_part", { name: "a" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/referenced by: c/);
    await cad.call("set_assembly", { instances: [{ part: "c" }, { part: "b", position: [30, 0, 0] }] });
    r = await cad.call("delete_part", { name: "c" });
    expect(r.isError, text(r)).toBe(false);
    expect(json(await cad.call("get_assembly")).instances.map((i: { part: string }) => i.part)).toEqual(["b"]);
    expect((await cad.call("set_assembly", { instances: [{ part: "zzz" }] })).isError).toBe(true);
    expect((await cad.call("delete_part", { name: "zzz" })).isError).toBe(true);
  });

  test("model is restored after reload", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "a", primitive: box });
    await cad.call("fillet", { part: "a", radius: 1 });
    await cad.call("set_assembly", { instances: [{ part: "a", position: [5, 0, 0], color: "#ff8800" }] });
    await page.reload();
    await expect(page.locator('[data-part="a"]')).toHaveAttribute("data-status", "ok");
    await expect(page.getByTestId("assembly-row")).toContainText("1 instance");
    const a = json(await cad.call("get_part", { name: "a" }));
    expect(a.source).toMatch(/fillet/);
    expect(json(await cad.call("get_assembly")).instances[0].color).toBe("#ff8800");
  });

  test("empty project shows hint", async ({ page, sessionId }) => {
    await openApp(page, sessionId);
    await expect(page.getByText("No parts yet")).toBeVisible();
  });
});

test.describe("view and export", () => {
  test("agent export over the size limit is an error", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?agentExportMax=500");
    await cad.call("create_primitive", { name: "s", primitive: { type: "sphere", radius: 10 } });
    const r = await cad.call("export", { part: "s" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/over the 500 byte export limit/);
    expect(r.content.some((c) => c.type === "resource")).toBe(false);
  });

  test("get_view_image returns PNG and switches view", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "a", primitive: box });
    await cad.call("create_primitive", { name: "b", primitive: { type: "cylinder", radius: 4, height: 12 } });
    await cad.call("show", {});
    const r = await cad.call("get_view_image", { part: "b", direction: "top" });
    expect(r.isError).toBe(false);
    expect(r.content[0].type).toBe("image");
    const png = Buffer.from(r.content[0].data!, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    await expect(shown(page)).toHaveText(/^b,/);
    expect((await cad.call("show", { part: "nope" })).isError).toBe(true);
  });

  test("STL export from UI and MCP", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "bracket", primitive: box });
    await page.locator('[data-part="bracket"] .part-row').click();
    const d = await exportFromDialog(page, { format: "stl" });
    expect(d.suggestedFilename()).toBe("bracket.stl");
    const stl = readFileSync((await d.path())!);
    const tris = stl.readUInt32LE(80);
    expect(tris).toBe(12);
    expect(stl.length).toBe(84 + 50 * tris);
    // Vertex coordinates span the box in mm
    const xs: number[] = [];
    for (let i = 0; i < tris; i++) for (let v = 0; v < 3; v++) xs.push(stl.readFloatLE(84 + i * 50 + 12 + v * 12));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 4);

    // Agent export returns the file and never downloads
    let downloads = 0;
    page.on("download", () => downloads++);
    const pr = await cad.call("export", { part: "bracket" });
    expect(pr.isError, text(pr)).toBe(false);
    const ps = resourceBytes(pr);
    expect(ps.uri).toBe("file:///bracket.stl");
    expect(ps.mimeType).toBe("model/stl");
    expect(ps.bytes.readUInt32LE(80)).toBe(12);

    await cad.call("set_assembly", { instances: [{ part: "bracket" }, { part: "bracket", position: [100, 0, 0], rotation: [0, 0, 90] }] });
    const r = await cad.call("export", {});
    expect(r.isError, text(r)).toBe(false);
    // Across all files: assembly (2 × 12) + the part (12)
    expect(json(r).triangles).toBe(36);
    expect(json(r).contents).toEqual(["assembly.stl", "parts/bracket.stl"]);
    const zr = resourceBytes(r);
    expect(zr.mimeType).toBe("application/zip");
    expect(zr.bytes.length).toBe(json(r).bytes);
    const zip = unzipSync(zr.bytes);
    expect(Object.keys(zip).sort()).toEqual(["assembly.stl", "parts/bracket.stl"]);
    const a = Buffer.from(zip["assembly.stl"]);
    const ax: number[] = [];
    for (let i = 0; i < 24; i++) for (let v = 0; v < 3; v++) ax.push(a.readFloatLE(84 + i * 50 + 12 + v * 12));
    // Second instance rotated 90° (20 wide in X) at x=100
    expect(Math.max(...ax)).toBeCloseTo(110, 4);
    // Unique part in its own coordinates
    expect(Buffer.from(zip["parts/bracket.stl"]).readUInt32LE(80)).toBe(12);
    await page.waitForTimeout(500);
    expect(downloads).toBe(0);
    await expect(page.locator(".toast")).toHaveCount(0);
    // The Export dialog still downloads for the user
    await page.getByTestId("assembly-row").click();
    expect((await exportFromDialog(page, { format: "stl", parts: true, assembled: true })).suggestedFilename()).toBe("assembly.zip");
  });
});
