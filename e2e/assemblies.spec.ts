import type { Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { expect, json, openApp, openLog, publishShare, resourceBytes, test, text } from "./fixtures";

type P = { key: string; position: number[]; rotation: number[] };
// Empty until the page's store exists (e.g. right after a reload)
const placed = (page: Page): Promise<P[]> =>
  page.evaluate(() => (globalThis as unknown as { cadStore?: { getState(): { assembly: { instances: P[] } } } })
    .cadStore?.getState().assembly.instances.map(({ key, position, rotation }) => ({ key, position, rotation })) ?? []);
const at = async (page: Page, key: string) => (await placed(page)).find((p) => p.key === key);
const builds = (page: Page) => page.evaluate(() => (globalThis as unknown as { cadEngine: { builds: number } }).cadEngine.builds);
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

const SCRIPT = `
const leg = (side, y, hip, knee) => group(side + " hip", { pivot: [0, y, 90], axis: [0, 1, 0], ...hip, limits: [-60, 60] }, [
  instance("thigh", { position: [0, y, 50] }),
  group("Knee", { pivot: [0, y, 50], axis: [0, 1, 0], ...knee, limits: [0, 120] }, [instance("shin", { position: [0, y, 10] })]),
]);
const main = () => {
  if (param("posts") > 8) throw new Error("Too many posts");
  return [
    group("Head", { position: [0, 0, 120] }, [instance("body")]),
    group("Legs", {}, [
      leg("Left", 20, { angle: param("hip") }, { angle: param("knee") }),
      leg("Right", -20, { follow: { joint: "Legs/Left hip", ratio: -1 } }, { follow: { joint: "Legs/Left hip/Knee", ratio: 1 } }),
    ]),
    ...Array.from({ length: param("posts") }, (_, i) => instance("post", { position: [i * 50, 200, 0] })),
  ];
};`;

async function robot(cad: { call: (n: string, a?: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text?: string }[] }> }) {
  await cad.call("set_model_info", { name: "Walker" });
  for (const [name, [w, d, h]] of Object.entries({ body: [40, 60, 30], thigh: [10, 10, 40], shin: [8, 8, 40], post: [6, 6, 30] })) {
    await cad.call("create_primitive", { name, primitive: { type: "box", width: w, depth: d, height: h } });
  }
  await cad.call("set_params_form", { params: [
    { name: "hip", label: "Hip", type: "slider", min: -30, max: 30, step: 1, default: 0 },
    { name: "knee", label: "Knee", type: "slider", min: 0, max: 150, step: 1, default: 0 },
    { name: "posts", label: "Posts", type: "number", min: 1, max: 10, default: 3 },
  ] });
  return cad.call("set_assembly_script", { source: SCRIPT });
}

test.describe("parametric assemblies", () => {
  test("script: count, warnings, tree with groups, live re-pose without rebuilding, hidden kept, limits, mirrored joint", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?debug");
    const r = await robot(cad);
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toContain("Assembly script set: 8 instance(s)");
    expect(text(r)).toContain('Joint "Legs/Left hip/Knee" is limited to 0…120 but parameter "knee" ranges 0…150');
    const got = json(await cad.call("get_assembly"));
    expect(got.script).toBe(SCRIPT);
    expect(got.count).toBe(8);

    // Tree: groups with counts, nested
    const tree = page.getByTestId("instances");
    await expect(tree.locator('[data-asm-group="Legs"] > .group-row .count')).toHaveText("4");
    await expect(tree.locator('[data-asm-group="Legs/Left hip/Knee"] [data-key="Legs/Left hip/Knee/shin"]')).toBeVisible();
    await tree.locator('[data-asm-group="Legs/Left hip"] > .group-row .tog').click();
    await expect(tree.locator('[data-key="Legs/Left hip/thigh"]')).toHaveCount(0);

    // Hide the head, then drag the hip slider: it moves before the slider would have debounced; no part rebuilds
    await tree.locator('[data-asm-group="Head"] > .group-row button.eye').click();
    const before = await builds(page);
    await page.locator('[data-param="hip"] input[type=range]').fill("20");
    await expect.poll(async () => (await at(page, "Legs/Left hip/thigh"))?.rotation, { timeout: 300, intervals: [20] }).toEqual([0, 20, 0]);
    expect((await at(page, "Legs/Right hip/thigh"))?.rotation).toEqual([0, -20, 0]);
    await expect(page.locator('[data-part][data-status="building"]')).toHaveCount(0);
    expect(await builds(page)).toBe(before);
    await expect(tree.locator('[data-asm-group="Head"]')).toHaveClass(/asm-group/);
    await expect(tree.locator('[data-asm-group="Head"] > .group-row')).toHaveClass(/off/);
    expect(await page.evaluate(() => [...(globalThis as unknown as { cadStore: { getState(): { hidden: Set<string> } } }).cadStore.getState().hidden]))
      .toEqual(["Head/body"]);

    // Count from a parameter; the knee clamps at its 120° limit
    await cad.call("set_param_values", { values: { posts: 5, hip: 0, knee: 150 } });
    await expect.poll(async () => (await placed(page)).filter((p) => p.key.startsWith("post")).length).toBe(5);
    await expect.poll(async () => near((await at(page, "Legs/Left hip/Knee/shin"))!.position, [-34.641, 20, 70])).toBe(true);
    expect(await builds(page)).toBe(before);
  });

  test("errors: unknown parts are refused; a script failing on a parameter keeps the last pose and shows the error", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?debug");
    await robot(cad);
    const bad = await cad.call("set_assembly_script", { source: `const main = () => [instance("nope")];` });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('Unknown part "nope"');
    expect(json(await cad.call("get_assembly")).script).toBe(SCRIPT);

    await cad.call("set_param_values", { values: { posts: 9 } });
    const entry = page.getByTestId("assembly-entry");
    await expect(entry).toHaveAttribute("data-status", "error");
    await expect(entry.getByTestId("error-card")).toContainText("Too many posts");
    expect((await placed(page)).filter((p) => p.key.startsWith("post"))).toHaveLength(3);
    const log = await openLog(page, "problems");
    await expect(log).toContainText("Assembly failed");
    await page.getByTestId("console-close").click();
    await cad.call("set_param_values", { values: { posts: 4 } });
    await expect(entry).toHaveAttribute("data-status", "ok");
    await expect.poll(async () => (await placed(page)).filter((p) => p.key.startsWith("post")).length).toBe(4);
  });

  test("static groups; exports name instances by group path (STEP products, 3MF item part numbers)", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "a", primitive: { type: "box", width: 5, depth: 5, height: 5 } });
    const r = await cad.call("set_assembly", { instances: [
      { part: "a" },
      { group: "Arm", pivot: [0, 0, 10], axis: [0, 1, 0], angle: 90, children: [{ part: "a", position: [0, 0, 20] }, { part: "a", label: "tip" }] },
    ] });
    expect(r.isError, text(r)).toBeFalsy();
    await expect(page.getByTestId("instances").locator('[data-asm-group="Arm"] > .group-row .count')).toHaveText("2");
    const xml = strFromU8(unzipSync(new Uint8Array(resourceBytes(await cad.call("export", { format: "3mf", include: "assembled" })).bytes))["3D/3dmodel.model"]);
    expect(xml).toContain('partnumber="Arm / a"');
    expect(xml).toContain('partnumber="Arm / tip"');
    const step = resourceBytes(await cad.call("export", { format: "step", include: "assembled" })).bytes.toString();
    expect(step).toContain("PRODUCT('Arm / a'");
    expect(step).toContain("PRODUCT('Arm / tip'");
  });

  test("share viewer re-poses with the visitor's slider and keeps the pose in the link", async ({ page, sessionId, cad, browser }) => {
    await openApp(page, sessionId);
    await robot(cad);
    await expect(page.locator('[data-part="shin"]')).toHaveAttribute("data-status", "ok");
    const url = await publishShare(page);
    const v = await browser.newPage();
    await v.goto(`${url}?debug`);
    await expect(v.locator('[data-part="shin"]')).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
    await v.locator('[data-param="hip"] input[type=range]').fill("-15");
    await expect.poll(async () => (await at(v, "Legs/Left hip/thigh"))?.rotation).toEqual([0, -15, 0]);
    await expect(v).toHaveURL(/#hip=-15$/);
    await v.reload();
    await expect.poll(async () => (await at(v, "Legs/Left hip/thigh"))?.rotation, { timeout: 60_000 }).toEqual([0, -15, 0]);
    await v.close();
  });
});
