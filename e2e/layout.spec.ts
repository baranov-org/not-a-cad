import type { Page } from "@playwright/test";
import { expect, openApp, test } from "./fixtures";

// Layout audit at extreme sizes: no text clipped (unless ellipsised on purpose), nothing sticking out of its container
const LONG = "Extremely long part name that keeps going";

type Problem = { what: string; why: string };
async function audit(page: Page): Promise<Problem[]> {
  return page.evaluate(() => {
    const out: { what: string; why: string }[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
    const containers = [".viewtools", ".tool-card", ".tool-pill", ".tool-pills", ".tool-stack", ".measure-card", ".measure-pill", ".sheet-bar", ".con-bar", ".con-drawer", ".topbar", ".side", ".modal", ".stage"];
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const targets = document.querySelectorAll("button, .tool-head, .tool-row-main, .tool-ctl > label, .num, .tool-limit, .seg, .mc-row, .mc-head, .viewtools, .measure-card, .nav-pop, .con-head, h1, h2, .chip, .pill, .sheet-tabs");
    for (const el of targets) {
      if (!visible(el) || el.closest("[hidden]")) continue;
      // Inside a horizontally scrollable strip (e.g. the log filters): scrolling is the intended overflow
      let scroller = el.parentElement;
      while (scroller && !["auto", "scroll"].includes(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
      if (scroller && scroller !== document.documentElement && scroller !== document.body && !el.contains(scroller)) {
        if (scroller.closest(".con-head")) continue;
      }
      const cs = getComputedStyle(el);
      // Clipped text (ellipsis is a deliberate truncation)
      if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis" && cs.overflowX !== "auto" && cs.overflowX !== "scroll") {
        out.push({ what: name(el), why: `content ${el.scrollWidth}px > box ${el.clientWidth}px` });
      }
      // Sticking out of its container
      const box = containers.map((c) => el.parentElement?.closest(c)).find(Boolean);
      if (box && box !== el) {
        const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
        if (a.left < b.left - 1 || a.right > b.right + 1) out.push({ what: name(el), why: `outside ${name(box).split(" ")[0]} (${Math.round(a.left)}–${Math.round(a.right)} vs ${Math.round(b.left)}–${Math.round(b.right)})` });
      }
    }
    // The page itself never scrolls sideways
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push({ what: "page", why: `scrollWidth ${document.documentElement.scrollWidth} > ${innerWidth}` });
    return out;
  });
}

async function scene(page: Page, label: string, problems: Map<string, string[]>) {
  await page.waitForTimeout(400);
  const p = await audit(page);
  if (p.length) problems.set(label, p.map((x) => `${x.what}: ${x.why}`));
  if (process.env.SHOTS) await page.screenshot({ path: `test-results/layout-${label}.png` });
}

const SIZES: { label: string; w: number; h: number; panels?: { left: number; right: number } }[] = [
  { label: "desktop-wide-panels", w: 1360, h: 800, panels: { left: 480, right: 560 } }, // 320 px viewport
  { label: "desktop-default", w: 1280, h: 800 },
  { label: "window-just-above-phone", w: 760, h: 700 },
  { label: "short-window", w: 1280, h: 520 },
  { label: "phone-390", w: 390, h: 844 },
  { label: "phone-320", w: 320, h: 640 },
  { label: "huge", w: 2560, h: 1440 },
];

test.describe("layout at extreme sizes", () => {
  for (const s of SIZES) {
    test(`nothing clipped or sticking out: ${s.label}`, async ({ page, sessionId, cad }) => {
      if (s.panels) await page.addInitScript((p) => localStorage.setItem("cad.layout", JSON.stringify(p)), s.panels);
      await page.setViewportSize({ width: s.w, height: s.h });
      await openApp(page, sessionId);
      await cad.call("set_model_info", { name: "A model with a rather long name to test wrapping in the panel", description: "Description" });
      await cad.call("set_params_form", { params: [
        { name: "a", label: "A parameter label that is long enough to wrap twice", type: "number", default: 10, min: 1, max: 100, unit: "mm" },
        { name: "b", label: "Choice", type: "radio", default: "x", options: [{ value: "x", label: "Extra small" }, { value: "y", label: "Medium sized" }, { value: "z", label: "Enormous option" }] },
      ] });
      await cad.call("set_part_script", { name: LONG.replace(/ /g, "_"), source: "const main = () => makeBaseBox(40, 30, 20);" });
      await expect(page.getByTestId("loading")).toBeHidden();
      const problems = new Map<string, string[]>();
      await scene(page, `${s.label}-base`, problems);
      // Section with three planes, offset and tilt tabs
      await page.keyboard.press("s");
      await page.getByTestId("section-add").click();
      await page.getByTestId("section-add").click();
      await page.getByLabel(/^Offset [xyz]$/).fill("-12.5");
      await page.getByLabel(/^Offset [xyz]$/).press("Enter");
      await scene(page, `${s.label}-section-offset`, problems);
      await page.getByTestId("section-bar").getByRole("tab", { name: "Tilt" }).click();
      await scene(page, `${s.label}-section-tilt`, problems);
      await page.keyboard.press("s");
      // Measure card, open and minimised
      await page.keyboard.press("m");
      await scene(page, `${s.label}-measure`, problems);
      await page.getByRole("button", { name: "Minimise" }).click();
      await scene(page, `${s.label}-measure-min`, problems);
      await page.keyboard.press("m");
      // Log drawer
      await page.getByTestId("console-toggle").click();
      await scene(page, `${s.label}-log`, problems);
      expect(Object.fromEntries(problems)).toEqual({});
    });
  }
});
