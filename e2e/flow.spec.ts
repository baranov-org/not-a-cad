import { expect, json, openApp, resourceBytes, test, text } from "./fixtures";

test("agent flow: box, cylinder, cut, fillet, assembly, screenshot, export", async ({ page, sessionId, cad }) => {
  await openApp(page, sessionId);
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await cad.call(name, args);
    expect(r.isError, `${name}: ${text(r)}`).toBe(false);
    return r;
  };
  await ok("create_primitive", { name: "block", primitive: { type: "box", width: 40, depth: 40, height: 10 } });
  await ok("create_primitive", { name: "drill", primitive: { type: "cylinder", radius: 5, height: 30 } });
  await ok("transform", { part: "drill", translate: [0, 0, -10] });
  await ok("boolean_op", { name: "plate", op: "cut", target: "block", tools: ["drill"] });
  const f = json(await ok("fillet", { part: "plate", radius: 2, edges: { parallelTo: "Z" }, result: "plate_r" }));
  expect(f.faces).toBeGreaterThan(7);
  await ok("set_assembly", { instances: [
    { part: "plate_r", color: "#6688cc" },
    { part: "plate_r", position: [0, 0, 20], rotation: [0, 0, 45], color: "#cc8866" },
  ] });
  const img = await ok("get_view_image", { direction: "iso" });
  expect(img.content[0].type).toBe("image");
  const ex = await ok("export", {});
  const e = json(ex);
  expect(resourceBytes(ex).bytes.length).toBe(e.bytes);
  expect(e.contents).toEqual(["assembly.stl", "parts/plate_r.stl"]);
  const names = json(await ok("list_parts", {})).map((p: { name: string }) => p.name).sort();
  expect(names).toEqual(["block", "drill", "plate", "plate_r"]);
});
