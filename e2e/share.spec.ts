import { readFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { newSessionId } from "../shared/src/ids";
import { expect, json, mcpClient, openApp, openShare, test, text } from "./fixtures";

const form = { params: [{ name: "w", label: "Width", type: "slider", min: 5, max: 60, step: 1, default: 20, unit: "mm" }] };
const script = `const main = () => makeBaseBox(param("w"), 10, 10);`;

// X extent of the first exported STL (part or zip-free)
const stlWidth = (buf: Buffer) => {
  const tris = buf.readUInt32LE(80);
  const xs: number[] = [];
  for (let i = 0; i < tris; i++) for (let v = 0; v < 3; v++) xs.push(buf.readFloatLE(84 + i * 50 + 12 + v * 12));
  return Math.max(...xs) - Math.min(...xs);
};

async function exportFromToolbar(page: Page) {
  const dl = page.waitForEvent("download");
  await page.getByTestId("export").click();
  return readFileSync((await (await dl).path())!);
}

async function buildModel(page: Page, cad: Awaited<ReturnType<typeof mcpClient>>, sessionId: string) {
  await openApp(page, sessionId);
  await cad.call("set_model_info", { name: "Test block", description: "A block <with> width" });
  await cad.call("set_params_form", form);
  await cad.call("set_part_script", { name: "block", source: script });
}

async function publish(page: Page) {
  await openShare(page);
  await page.getByTestId("publish").click();
  const url = await page.getByTestId("share-url").textContent();
  return url!;
}

async function viewer(browser: Browser, url: string) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  let sockets = 0;
  page.on("websocket", () => sockets++);
  await page.goto(url);
  return { page, ctx, sockets: () => sockets };
}

test.describe("sharing", () => {
  test("model info: agent sets it, user edits persist", async ({ page, sessionId, cad }) => {
    await buildModel(page, cad, sessionId);
    await expect(page.getByTestId("model-name")).toHaveText("Test block");
    await expect(page.getByTestId("model-desc")).toHaveText("A block <with> width");
    // Edited in the Share dialog
    await openShare(page);
    await page.locator("#share-name").fill("Renamed block");
    await page.locator("#share-desc").click(); // blur name
    await expect(page.getByTestId("model-name")).toHaveText("Renamed block");
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByTestId("model-name")).toHaveText("Renamed block");
  });

  test("publish, republish keeps URL, unpublish", async ({ page, sessionId, cad, browser }) => {
    await openApp(page, sessionId);
    await expect(page.getByTestId("share-open")).toBeDisabled(); // no parts
    await cad.call("set_part_script", { name: "block", source: `const main = () => makeBaseBox(1, 1, 1);` });
    await openShare(page);
    await expect(page.getByTestId("share-state")).toContainText("Not shared");
    await expect(page.getByTestId("publish")).toBeDisabled(); // no name
    await expect(page.getByText("A name is required to share.")).toBeVisible();
    await page.locator("#share-name").fill("Cube");
    const url = await publish(page);
    expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);
    expect(url).not.toContain(sessionId);
    await page.getByRole("button", { name: "Republish" }).click();
    await expect(page.getByTestId("share-url")).toHaveText(url);
    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(page.getByText("Unpublish? The link stops working.")).toBeVisible();
    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(page.getByTestId("publish")).toBeVisible();
    const v = await viewer(browser, url);
    await expect(v.page.getByTestId("share-missing")).toContainText("This share doesn't exist");
    await v.ctx.close();
  });

  test("errored parts warn before publishing", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("set_model_info", { name: "Broken" });
    await cad.call("set_part_script", { name: "bad", source: `const main = () => { throw new Error("x") };` });
    await openShare(page);
    await page.getByTestId("publish").click();
    await expect(page.getByTestId("share-failed")).toContainText("failed to build: bad");
    await page.getByRole("button", { name: "Publish anyway" }).click();
    await expect(page.getByTestId("share-url")).toBeVisible();
  });

  test("viewer builds locally, params are local and kept in the link, export reflects them, no socket", async ({ page, sessionId, cad, browser }) => {
    await buildModel(page, cad, sessionId);
    const url = await publish(page);
    const v = await viewer(browser, url);
    await expect(v.page.getByTestId("share-head")).toContainText("Test block");
    await expect(v.page.getByTestId("share-head")).toContainText("A block <with> width");
    await expect(v.page.locator('[data-part="block"]')).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
    await expect(v.page.getByTestId("loading")).toBeHidden();
    await expect(v.page.getByTestId("mcp-url")).toHaveCount(0);
    expect(await v.page.title()).toBe("Test block");
    expect(stlWidth(await exportFromToolbar(v.page))).toBeCloseTo(20, 3);
    await v.page.locator('[data-param="w"] input[type=range]').fill("35");
    await expect(v.page.locator('[data-param="w"] .readout')).toHaveText("35 mm");
    await expect.poll(async () => stlWidth(await exportFromToolbar(v.page))).toBeCloseTo(35, 3);
    expect(v.sockets()).toBe(0);
    // Owner's session unaffected
    expect(json(await cad.call("get_params")).values.w).toBe(20);
    // Edits are kept in the link: only changed values, compact
    await expect(v.page).toHaveURL(`${url}#w=35`);
    await v.page.reload();
    await expect(v.page.locator('[data-param="w"] .readout')).toHaveText("35 mm");
    await expect.poll(async () => stlWidth(await exportFromToolbar(v.page))).toBeCloseTo(35, 3);
    expect(v.sockets()).toBe(0);
    // Back to the published values: a clean link
    await v.page.locator('[data-param="w"] input[type=range]').fill("20");
    await expect(v.page).toHaveURL(url);
    await v.ctx.close();
    // Someone else opening a link with edits sees them; unknown or invalid values are ignored
    const o = await viewer(browser, `${url}#w=12&w2=3&nope`);
    await expect(o.page.locator('[data-param="w"] .readout')).toHaveText("12 mm");
    await expect(o.page.locator('[data-part="block"]')).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
    expect(stlWidth(await exportFromToolbar(o.page))).toBeCloseTo(12, 3);
    await o.page.goto(`${url}#w=999`);
    await expect(o.page.locator('[data-param="w"] .readout')).toHaveText("20 mm");
    await o.ctx.close();
  });

  test("link preview: publishing saves a 1200×630 image; the share page carries it for social cards", async ({ page, sessionId, cad }) => {
    await buildModel(page, cad, sessionId);
    await expect(page.locator('[data-part="block"]')).toHaveAttribute("data-status", "ok");
    await openShare(page);
    await expect(page.getByTestId("share-dialog").getByAltText("Link preview")).toBeVisible();
    const url = await publish(page);
    const html = await (await page.request.get(url)).text();
    const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    expect(og, html).toBeTruthy();
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    const img = await page.request.get(og!.replace(/&amp;/g, "&"));
    expect(img.headers()["content-type"]).toBe("image/jpeg");
    // Decodes as a 1200×630 picture with the model in it (not just background)
    const info = await page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const bg = [d[0], d[1], d[2]];
      let other = 0;
      for (let i = 0; i < d.length; i += 4 * 97) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 30) other++;
      return { w: bmp.width, h: bmp.height, other };
    }, (await img.body()).toString("base64"));
    expect(info).toMatchObject({ w: 1200, h: 630 });
    expect(info.other).toBeGreaterThan(100);
  });

  test("snapshot: agent edits after publish are not shared until republish", async ({ page, sessionId, cad, browser }) => {
    await buildModel(page, cad, sessionId);
    const url = await publish(page);
    await cad.call("set_part_script", { name: "block", source: `const main = () => makeBaseBox(param("w") * 2, 10, 10);` });
    let v = await viewer(browser, url);
    await expect(v.page.locator('[data-part="block"]')).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
    expect(stlWidth(await exportFromToolbar(v.page))).toBeCloseTo(20, 3);
    await v.ctx.close();
    await page.getByRole("button", { name: "Republish" }).click();
    await expect(page.getByText(/Updated/)).toBeVisible();
    await page.waitForTimeout(300);
    v = await viewer(browser, url);
    await expect(v.page.locator('[data-part="block"]')).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
    expect(stlWidth(await exportFromToolbar(v.page))).toBeCloseTo(40, 3);
    await v.ctx.close();
  });

  test("viewer frames an assembly whose instances arrive after the cached meshes", async ({ page, sessionId, cad, browser }) => {
    await openApp(page, sessionId);
    await cad.call("set_model_info", { name: "Two blocks", description: "Placed by an assembly script" });
    await cad.call("set_part_script", { name: "block", source: "const main = () => makeBaseBox(20, 20, 20);" });
    await cad.call("set_assembly_script", { source: "const main = () => [{ part: \"block\" }, { part: \"block\", position: [100, 0, 0] }];" });
    await expect(page.locator('[data-part="block"]')).toHaveAttribute("data-status", "ok");
    const url = await publish(page);
    const v = await viewer(browser, url);
    await expect(v.page.getByTestId("share-head")).toContainText("120 × 20 × 20 mm", { timeout: 30_000 });
    await v.ctx.close();
  });

  test("unknown share shows not found", async ({ browser }) => {
    const v = await viewer(browser, `/s/${newSessionId()}`);
    await expect(v.page.getByTestId("share-missing")).toContainText("This share doesn't exist");
    await v.ctx.close();
  });

  test("agent forks a share with load_share; original unchanged", async ({ page, sessionId, cad, browser, baseURL }) => {
    await buildModel(page, cad, sessionId);
    const url = await publish(page);
    // Second user with their own session
    const sid2 = newSessionId();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await openApp(page2, sid2);
    const cad2 = await mcpClient(baseURL!, sid2);
    await cad2.call("create_primitive", { name: "mine", primitive: { type: "sphere", radius: 3 } });
    const before = page2.url();
    const r = await cad2.call("load_share", { share: url });
    expect(r.isError, text(r)).toBe(false);
    expect(JSON.parse(r.content[1].text!).map((p: { name: string }) => p.name)).toEqual(["block"]);
    // Opens as a new project; the previous one keeps its part
    await expect(page2).not.toHaveURL(before);
    await expect(page2.locator('[data-part="mine"]')).toHaveCount(0);
    await expect(page2.locator('[data-part="block"]')).toHaveAttribute("data-status", "ok");
    await expect(page2.getByTestId("model-name")).toHaveText("Test block");
    await expect(page2.locator('[data-param="w"]')).toBeVisible();
    // Stored for the new project (survives reload)
    await page2.reload();
    await expect(page2.locator('[data-part="block"]')).toHaveAttribute("data-status", "ok");
    expect((await cad2.call("list_parts")).content[0].text).not.toContain("mine");
    // Change and publish as their own share
    await cad2.call("set_model_info", { name: "Wider block" });
    await cad2.call("set_param_values", { values: { w: 50 } });
    const url2 = await publish(page2);
    expect(url2).not.toBe(url);
    const v = await viewer(browser, url);
    await expect(v.page.getByTestId("share-head")).toContainText("Test block");
    await expect(v.page.locator('[data-param="w"] .readout')).toHaveText("20 mm");
    await v.ctx.close();
    expect((await cad2.call("load_share", { share: "nope" })).isError).toBe(true);
    await cad2.client.close();
    await ctx2.close();
  });
});
