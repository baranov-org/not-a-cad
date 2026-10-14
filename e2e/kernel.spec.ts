import { expect, json, openApp, test, text } from "./fixtures";

test.describe("browser kernel", () => {
  test("builds a box", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    const r = await cad.call("create_primitive", { name: "box", primitive: { type: "box", width: 10, depth: 20, height: 5 } });
    expect(r.isError, text(r)).toBe(false);
    const p = json(r);
    expect(p.status).toBe("ok");
    expect(p.size).toEqual([10, 20, 5]);
    expect(p.volume).toBeCloseTo(1000, 3);
    expect(p.faces).toBe(6);
    expect(p.edges).toBe(12);
  });

  test("all primitives build", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    const prims = {
      cyl: { type: "cylinder", radius: 5, height: 10 },
      sph: { type: "sphere", radius: 5 },
      cone: { type: "cone", radius1: 5, radius2: 2, height: 10 },
      tip: { type: "cone", radius1: 5, radius2: 0, height: 10 },
      tor: { type: "torus", majorRadius: 10, minorRadius: 2 },
    };
    for (const [name, primitive] of Object.entries(prims)) {
      const r = await cad.call("create_primitive", { name, primitive });
      expect(r.isError, `${name}: ${text(r)}`).toBe(false);
    }
    expect(json(await cad.call("get_part", { name: "cyl" })).volume).toBeCloseTo(Math.PI * 250, 0);
    const cone = json(await cad.call("get_part", { name: "cone" }));
    expect(cone.bbox.min[2]).toBeCloseTo(0);
    expect(cone.bbox.max[2]).toBeCloseTo(10);
    expect(cone.volume).toBeCloseTo((Math.PI * 10 * (25 + 10 + 4)) / 3, 0);
    expect(json(await cad.call("get_part", { name: "tor" })).volume).toBeCloseTo(2 * Math.PI ** 2 * 10 * 4, 0);
  });

  test("script errors are reported and stored", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    let r = await cad.call("set_part_script", { name: "bad", source: "const main = () => { throw new Error('boom') }" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("boom");
    r = await cad.call("set_part_script", { name: "flat", source: "const main = () => drawCircle(5)" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/3D shape/);
    r = await cad.call("set_part_script", { name: "nomain", source: "const x = 1" });
    expect(text(r)).toMatch(/define `const main/);
    expect(json(await cad.call("get_part", { name: "bad" })).status).toBe("error");
  });

  test("dependents rebuild and cycles error", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    await cad.call("create_primitive", { name: "a", primitive: { type: "box", width: 10, depth: 10, height: 10 } });
    await cad.call("create_primitive", { name: "b", primitive: { type: "cylinder", radius: 2, height: 20 } });
    let r = await cad.call("boolean_op", { name: "c", op: "cut", target: "a", tools: ["b"] });
    expect(r.isError, text(r)).toBe(false);
    expect(json(r).volume).toBeCloseTo(1000 - Math.PI * 4 * 10, 1);
    await cad.call("create_primitive", { name: "a", primitive: { type: "box", width: 20, depth: 10, height: 10 } });
    expect(json(await cad.call("get_part", { name: "c" })).volume).toBeCloseTo(2000 - Math.PI * 4 * 10, 1);

    r = await cad.call("set_part_script", { name: "a", source: `const main = () => part("c")` });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/cycle/i);
    const c = json(await cad.call("get_part", { name: "c" }));
    expect(c.status).toBe("error");
    // b is unaffected
    expect(json(await cad.call("get_part", { name: "b" })).status).toBe("ok");
  });

  test("infinite loop times out, other parts stay usable", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId, "?buildTimeout=2000");
    await cad.call("create_primitive", { name: "base", primitive: { type: "box", width: 10, depth: 10, height: 10 } });
    const r = await cad.call("set_part_script", { name: "loop", source: "const main = () => { for(;;){} }" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/timed out/);
    const d = await cad.call("set_part_script", { name: "derived", source: `const main = () => part("base").fillet(1)` });
    expect(d.isError, text(d)).toBe(false);
    expect(json(await cad.call("get_part", { name: "base" })).status).toBe("ok");
  });

  test("scripts cannot use the network", async ({ page, sessionId, cad }) => {
    await openApp(page, sessionId);
    let hit = false;
    // CSP-blocked requests fail with "csp" and never finish
    page.on("requestfinished", (req) => {
      if (req.url().includes("exfil")) hit = true;
    });
    const r = await cad.call("set_part_script", {
      name: "net",
      source: `const main = () => { fetch("/exfil?x=1").catch(() => {}); return makeBaseBox(1, 1, 1) };`,
    });
    expect(r.isError, text(r)).toBe(false);
    const s = await cad.call("set_part_script", {
      name: "xhr",
      source: `const main = () => { const x = new XMLHttpRequest(); x.open("GET", "/exfil2", false); x.send(); return makeBaseBox(1, 1, 1) };`,
    });
    expect(s.isError).toBe(true);
    await page.waitForTimeout(500);
    expect(hit).toBe(false);
  });
});
