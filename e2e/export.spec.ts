import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { expect, exportFromDialog, json, openApp, resourceBytes, test, text } from "./fixtures";

const box = (w: number, d: number, h: number) => ({ type: "box", width: w, depth: d, height: h });
const fileOf = async (dl: Awaited<ReturnType<typeof exportFromDialog>>) => readFileSync((await dl.path())!);
// Volume of a STEP file re-imported into the page's kernel (?debug exposes the engine)
const stepVolume = (page: Page, bytes: Buffer) =>
  page.evaluate((b) => (globalThis as unknown as { cadEngine: { stepVolume(u: Uint8Array): Promise<number> } }).cadEngine.stepVolume(new Uint8Array(b)), [...bytes]);

async function twoParts(cad: { call: (n: string, a?: Record<string, unknown>) => Promise<unknown> }) {
  await cad.call("create_primitive", { name: "plate", primitive: box(20, 10, 2) });
  await cad.call("create_primitive", { name: "peg", primitive: { type: "cylinder", radius: 2, height: 10 } });
  await cad.call("set_assembly", { instances: [
    { part: "plate", color: "#cc3300" },
    { part: "peg", position: [5, 0, 2] },
    { part: "peg", position: [-5, 0, 2] },
  ] });
}

test.describe("export", () => {
  test("STEP: part and assembly are exact, one product per instance, same volume on re-import", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?debug");
    await twoParts(cad);
    const part = await cad.call("export", { part: "plate", format: "step" });
    expect(part.isError, text(part)).toBeFalsy();
    const p = resourceBytes(part);
    expect(p.uri).toBe("file:///plate.step");
    expect(p.mimeType).toBe("model/step");
    expect(p.bytes.subarray(0, 12).toString()).toBe("ISO-10303-21");
    expect(await stepVolume(page, p.bytes)).toBeCloseTo(400, 3);

    const asm = resourceBytes(await cad.call("export", { format: "step", include: "assembled" }));
    expect(asm.uri).toBe("file:///assembly.step");
    const step = asm.bytes.toString();
    for (const name of ["plate", "peg #1", "peg #2"]) expect(step).toContain(`PRODUCT('${name}'`);
    expect(await stepVolume(page, asm.bytes)).toBeCloseTo(400 + 2 * Math.PI * 4 * 10, 1);
  });

  test("dialog: each format for a part; assembly switches, file list, ZIP; remembered choice", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await twoParts(cad);
    await page.locator('[data-part="plate"] .part-row').click();
    for (const [format, check] of [
      ["stl", (b: Buffer) => expect(b.readUInt32LE(80)).toBe(12)],
      ["obj", (b: Buffer) => expect(b.toString().match(/^f /gm)).toHaveLength(12)],
      ["3mf", (b: Buffer) => expect(strFromU8(unzipSync(new Uint8Array(b))["3D/3dmodel.model"]).match(/<object /g)).toHaveLength(1)],
      ["step", (b: Buffer) => expect(b.subarray(0, 12).toString()).toBe("ISO-10303-21")],
    ] as const) {
      const dl = await exportFromDialog(page, { format });
      expect(dl.suggestedFilename()).toBe(`plate.${format}`);
      check(await fileOf(dl));
    }

    await page.getByTestId("assembly-row").click();
    await page.getByTestId("export").click();
    const dlg = page.getByTestId("export-dialog");
    const files = page.getByTestId("export-files");
    await dlg.locator('[data-format="stl"]').click();
    await expect(files).toContainText("assembly.stl");
    await expect(files).toContainText("parts/plate.stl");
    await expect(files).toContainText("parts/peg.stl");
    await expect(dlg).toContainText("3 files · ZIP");
    // Nothing selected
    await dlg.locator('[data-include="parts"]').click();
    await dlg.locator('[data-include="assembled"]').click();
    await expect(dlg).toContainText("Pick at least one thing to include.");
    await expect(dlg.getByTestId("export-go")).toBeDisabled();
    await page.keyboard.press("Escape");

    // 3MF, assembled only: one file, parts as objects placed per instance, colours
    const tmf = await fileOf(await exportFromDialog(page, { format: "3mf", parts: false, assembled: true }));
    const xml = strFromU8(unzipSync(new Uint8Array(tmf))["3D/3dmodel.model"]);
    expect(xml.match(/<object /g)).toHaveLength(2);
    expect(xml.match(/<item /g)).toHaveLength(3);
    expect(xml).toContain('transform="1 0 0 0 1 0 0 0 1 5 0 2"');
    expect(xml).toContain('displaycolor="#CC3300FF"');

    // STL, both: ZIP with parts resting on Z = 0 and the assembly in place
    const zip = unzipSync(new Uint8Array(await fileOf(await exportFromDialog(page, { format: "stl", parts: true, assembled: true }))));
    expect(Object.keys(zip).sort()).toEqual(["assembly.stl", "parts/peg.stl", "parts/plate.stl"]);
    const zs = (b: Uint8Array) => {
      const buf = Buffer.from(b);
      const z: number[] = [];
      for (let i = 0; i < buf.readUInt32LE(80); i++) for (let v = 0; v < 3; v++) z.push(buf.readFloatLE(84 + i * 50 + 20 + v * 12));
      return [Math.min(...z), Math.max(...z)];
    };
    expect(zs(zip["parts/peg.stl"])[0]).toBeCloseTo(0, 4);
    expect(zs(zip["assembly.stl"])[1]).toBeCloseTo(12, 4);

    // OBJ assembled: one object per instance, merged into one file
    const obj = (await fileOf(await exportFromDialog(page, { format: "obj", parts: false, assembled: true }))).toString();
    expect(obj.match(/^o /gm)).toHaveLength(3);

    // The last choice is remembered
    await page.reload();
    await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    await page.getByTestId("export").click();
    await expect(page.getByTestId("export-dialog").locator('[data-format="obj"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("export-dialog").locator('[data-include="parts"]')).toHaveAttribute("aria-checked", "false");
  });

  test("mesh quality: re-meshed exports follow curves closely; draft is the viewer's mesh; boxes stay boxes; remembered", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "ball", primitive: { type: "sphere", radius: 20 } });
    await page.locator('[data-part="ball"] .part-row').click();
    const tris = async (quality: string) => {
      const b = await fileOf(await exportFromDialog(page, { format: "stl", quality }));
      // Worst radius error over all vertices (exact sphere r = 20)
      let dev = 0;
      for (let i = 0; i < b.readUInt32LE(80); i++) for (let v = 0; v < 3; v++) {
        const o = 84 + i * 50 + 12 + v * 12;
        dev = Math.max(dev, Math.abs(Math.hypot(b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)) - 20));
      }
      return { n: b.readUInt32LE(80), dev };
    };
    const draft = await tris("draft");
    const normal = await tris("normal");
    const fine = await tris("fine");
    expect(normal.n).toBeGreaterThan(draft.n * 2);
    expect(fine.n).toBeGreaterThan(normal.n);
    expect(normal.dev).toBeLessThan(1e-3);
    // Remembered
    await page.reload();
    await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
    await page.getByTestId("export").click();
    await expect(page.getByTestId("export-dialog").locator('[data-quality="fine"]')).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    // Flat faces don't gain triangles
    await cad.call("create_primitive", { name: "block", primitive: box(10, 10, 10) });
    await page.locator('[data-part="block"] .part-row').click();
    expect((await tris("normal")).n).toBe(12);
    // STEP has no mesh quality
    await page.getByTestId("export").click();
    await page.getByTestId("export-dialog").locator('[data-format="step"]').click();
    await expect(page.getByTestId("export-dialog").locator("[data-quality]")).toHaveCount(0);
  });

  test("failed parts are listed and left out; a failed part can't be exported", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await twoParts(cad);
    await cad.call("set_part_script", { name: "peg", source: "const main = () => { throw new Error('x') };" });
    await page.getByTestId("assembly-row").click();
    await page.getByTestId("export").click();
    await expect(page.getByTestId("export-skipped")).toHaveText("peg failed to build and is left out.");
    await expect(page.getByTestId("export-files")).not.toContainText("peg");
    await page.keyboard.press("Escape");
    await page.locator('[data-part="peg"] .part-row').click();
    await expect(page.getByTestId("export")).toBeDisabled();
  });

  test("file names follow the model name", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await twoParts(cad);
    await cad.call("set_model_info", { name: "Peg Board — M4 (v2)" });
    const r = await cad.call("export", { format: "3mf", include: "assembled" });
    expect(resourceBytes(r).uri).toBe("file:///peg-board-m4-v2.3mf");
    expect(json(await cad.call("export", { format: "stl", include: "both" })).contents)
      .toEqual(["peg-board-m4-v2.stl", "parts/plate.stl", "parts/peg.stl"]);
    await page.getByTestId("assembly-row").click();
    expect((await exportFromDialog(page, { format: "stl", parts: true, assembled: true })).suggestedFilename()).toBe("peg-board-m4-v2.zip");
    await page.locator('[data-part="peg"] .part-row').click();
    expect((await exportFromDialog(page, { format: "obj" })).suggestedFilename()).toBe("peg-board-m4-v2-peg.obj");
  });

  test("agent: 3MF and STEP as resources, include modes, size limit, nothing downloads", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?agentExportMax=4000");
    await twoParts(cad);
    let downloads = 0;
    page.on("download", () => downloads++);
    const r = await cad.call("export", { format: "3mf", include: "assembled", quality: "draft" });
    expect(r.isError, text(r)).toBeFalsy();
    expect(resourceBytes(r)).toMatchObject({ uri: "file:///assembly.3mf", mimeType: "model/3mf" });
    expect(json(r).contents).toEqual(["assembly.3mf"]);
    // Re-meshed (normal) is finer than the viewer's mesh: over this tiny limit, with a hint
    const fine = await cad.call("export", { format: "3mf", include: "assembled" });
    expect(fine.isError).toBe(true);
    expect(text(fine)).toContain('Try quality "draft"');
    const parts = await cad.call("export", { format: "stl", include: "parts", quality: "draft" });
    expect(json(parts).contents).toEqual(["parts/plate.stl", "parts/peg.stl"]);
    const big = await cad.call("export", { format: "step", include: "both" });
    expect(big.isError).toBe(true);
    expect(text(big)).toMatch(/over the 4000 byte export limit/);
    await page.waitForTimeout(500);
    expect(downloads).toBe(0);
  });
});
