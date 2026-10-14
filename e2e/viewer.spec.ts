import { writeFileSync } from "node:fs";
import { expect, openApp, test } from "./fixtures";

const shot = process.env.SHOT_DIR;

test("viewport renders and responds to orbit/pan/zoom/fit", async ({ page, sessionId, cad }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, sessionId);
  await cad.call("set_part_script", {
    name: "bracket",
    source: `const main = () => {
  const plate = drawRoundedRectangle(60, 40, 5).sketchOnPlane("XY").extrude(6);
  const wall = makeBaseBox(60, 6, 30).translate([0, -17, 0]);
  const hole = makeCylinder(4, 20, [15, 5, -5]);
  return plate.fuse(wall).cut(hole).cut(makeCylinder(4, 20, [-15, 5, -5]));
};`,
  });
  await cad.call("create_primitive", { name: "pin", primitive: { type: "cylinder", radius: 3.8, height: 20 } });
  await cad.call("set_assembly", { instances: [
    { part: "bracket", color: "#7aa2d6" },
    { part: "pin", position: [15, 5, -5], color: "#d68a3a" },
    { part: "pin", position: [-15, 5, -5], color: "#d68a3a" },
  ] });
  const canvas = page.locator("canvas").first();
  await page.waitForTimeout(500);
  const a = await canvas.screenshot();
  if (shot) await page.screenshot({ path: `${shot}/assembly.png` });
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  // orbit
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 150, cy + 40, { steps: 5 }); await page.mouse.up();
  const b = await canvas.screenshot();
  expect(b.equals(a)).toBe(false);
  // pan (right drag)
  await page.mouse.move(cx, cy); await page.mouse.down({ button: "right" }); await page.mouse.move(cx + 80, cy, { steps: 5 }); await page.mouse.up({ button: "right" });
  const c = await canvas.screenshot();
  expect(c.equals(b)).toBe(false);
  // zoom
  await page.mouse.move(cx, cy); await page.mouse.wheel(0, 400); await page.waitForTimeout(300);
  const d = await canvas.screenshot();
  expect(d.equals(c)).toBe(false);
  await page.getByTestId("view-toolbar").getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(300);
  if (shot) await page.screenshot({ path: `${shot}/fit.png` });
  await page.locator('[data-part="bracket"]').click();
  await page.waitForTimeout(500);
  if (shot) await page.screenshot({ path: `${shot}/part.png` });
  const img = await cad.call("get_view_image", { part: "bracket", direction: "front" });
  if (shot) writeFileSync(`${shot}/front.png`, Buffer.from(img.content[0].data!, "base64"));
});
