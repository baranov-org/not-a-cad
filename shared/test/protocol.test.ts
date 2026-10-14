import { describe, expect, it } from "vitest";
import { ClientMsg, Model, ServerMsg, applyChanges, emptyModel, emptyParams, partRefs } from "../src";

describe("ws messages", () => {
  it("parses valid messages", () => {
    expect(ServerMsg.parse({ type: "restore", project: "p", model: emptyModel() }).type).toBe("restore");
    expect(ServerMsg.parse({ type: "call", id: "1", op: "set_part", args: {}, project: "p" }).type).toBe("call");
    expect(ServerMsg.parse({ type: "navigate", project: "p", by: "Claude" }).type).toBe("navigate");
    expect(ClientMsg.parse({ type: "open", project: null }).type).toBe("open");
    expect(ClientMsg.parse({ type: "visibility", visible: false }).type).toBe("visibility");
    expect(ServerMsg.parse({ type: "superseded" }).type).toBe("superseded");
    const r = ClientMsg.parse({
      type: "result", id: "1", ok: true,
      content: [
        { type: "text", text: "ok" },
        { type: "image", data: "AA==", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///a.stl", mimeType: "model/stl", blob: "AA==" } },
      ],
      changes: { upsert: [{ name: "a", source: "x" }], delete: ["b"] },
    });
    expect(r.type === "result" && r.ok).toBe(true);
    const c = ClientMsg.parse({ type: "changes", project: "p", changes: { params: { form: { params: [] }, values: {} } } });
    expect(c.type).toBe("changes");
  });
  it("rejects invalid messages", () => {
    expect(ServerMsg.safeParse({ type: "call", id: "1", op: "rm_rf", args: {}, project: "p" }).success).toBe(false);
    expect(ServerMsg.safeParse({ type: "call", id: "1", op: "set_part", args: {} }).success).toBe(false);
    expect(ServerMsg.safeParse({ type: "nope" }).success).toBe(false);
    expect(ClientMsg.safeParse({ type: "result", id: "1", ok: true }).success).toBe(false);
    expect(ClientMsg.safeParse({ type: "result", id: "1", ok: true, content: [{ type: "resource", resource: { uri: "x" } }] }).success).toBe(false);
    expect(ClientMsg.safeParse({ type: "result", id: "1", ok: true, content: [], changes: { delete: ["bad name"] } }).success).toBe(false);
  });
});

describe("model helpers", () => {
  it("applies changes", () => {
    const m = applyChanges({ parts: { a: "1", b: "2" }, assembly: { instances: [] }, params: emptyParams(), info: {}, groups: { groups: [], assign: {} } }, {
      upsert: [{ name: "c", source: "3" }], delete: ["a"],
      assembly: { instances: [{ part: "c", position: [1, 2, 3], rotation: [0, 0, 0] }] },
    });
    expect(m.parts).toEqual({ b: "2", c: "3" });
    expect(m.assembly.instances).toHaveLength(1);
  });
  it("loads models stored before params existed", () => {
    const old = Model.parse({ parts: { a: "x" }, assembly: { instances: [] } });
    expect(old.params).toEqual(emptyParams());
    expect(old.info).toEqual({});
    expect(Model.safeParse({ ...old, info: { name: "x".repeat(81) } }).success).toBe(false);
    expect(Model.parse({ ...old, info: { name: "  Bracket " } }).info.name).toBe("Bracket");
  });

  it("applies params changes", () => {
    const params = { form: { params: [{ name: "w", label: "W", type: "checkbox" as const, default: true }], groups: [] }, values: { w: false } };
    expect(applyChanges(emptyModel(), { params }).params).toEqual(params);
  });

  it("finds part refs", () => {
    expect(partRefs(`part("a").cut(part('b')).fuse(part( \`c\` )); part(x)`).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("part groups", () => {
  it("defaults for old models and validates", async () => {
    const { Model, PartGroups, applyChanges, emptyModel } = await import("../src");
    expect(Model.parse({ parts: {}, assembly: { instances: [] } }).groups).toEqual({ groups: [], assign: {} });
    expect(PartGroups.safeParse({ groups: [{ id: "a", label: "A" }], assign: { p: "a" } }).success).toBe(true);
    const bad = PartGroups.safeParse({ groups: [{ id: "a", label: "A" }, { id: "a", label: "B" }], assign: { p: "zz" } });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.message).join()).toMatch(/Duplicate group "a".*unknown group "zz"/);
    // Deleting a part drops its assignment
    const m = applyChanges({ ...emptyModel(), parts: { p: "x", q: "y" }, groups: { groups: [{ id: "a", label: "A", collapsed: false }], assign: { p: "a", q: "a" } } }, { delete: ["p"] });
    expect(m.groups.assign).toEqual({ q: "a" });
  });
});
