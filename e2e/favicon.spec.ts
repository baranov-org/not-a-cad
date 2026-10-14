import type { Page } from "@playwright/test";
import { expect, openApp, test } from "./fixtures";

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { value: h ? "hidden" : "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: h, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

// Colour of the tab icon's status dot: "none" when the plain icon shows
const dot = (page: Page) => page.evaluate(async () => {
  const link = document.querySelector<HTMLLinkElement>("link[rel~=icon]")!;
  if (!link.href.startsWith("data:")) return "none";
  const img = new Image();
  img.src = link.href;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const [r, g, b] = ctx.getImageData(49, 49, 1, 1).data;
  if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && r > 100 && r < 180) return "grey";
  if (b > r + 60) return "blue";
  if (r > b + 60) return "red";
  return "plain";
});

test("tab icon: grey blinking dot while working, blue for news in the background, cleared on return", async ({ page, sessionId, cad }) => {
  await openApp(page, sessionId);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png");
  expect((await page.request.get("/favicon.svg")).headers()["content-type"]).toContain("svg");
  expect(await dot(page)).toBe("none");

  // A slow build: grey dot, blinking (sometimes the plain icon)
  const slow = `const main = () => { const t = Date.now(); while (Date.now() - t < 3000); return makeBaseBox(10, 10, 10); };`;
  const call = cad.call("set_part_script", { name: "slow", source: slow });
  const seen = new Set<string>();
  await expect.poll(async () => { seen.add(await dot(page)); return seen.has("grey") && seen.has("plain"); }, { intervals: [150] }).toBe(true);
  await call;
  await expect.poll(() => dot(page)).toBe("none");

  // Agent changes something while the tab is in the background: blue until the user comes back
  await setHidden(page, true);
  await cad.call("create_primitive", { name: "b", primitive: { type: "box", width: 5, depth: 5, height: 5 } });
  await expect.poll(() => dot(page)).toBe("blue");
  await setHidden(page, false);
  await expect.poll(() => dot(page)).toBe("none");
});
