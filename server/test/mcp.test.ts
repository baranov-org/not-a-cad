import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyChanges, emptyModel, newSessionId, type Model } from "shared";
import { FakeBrowser, grant, seed, sleep, startServer } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let client: Client;
let browser: FakeBrowser;
let id: string;
let pid: string;
const calls: { op: string; args: unknown }[] = [];

// Fake browser holding its own model, like the real one
function attachBrowser() {
  let model: Model = emptyModel();
  browser = new FakeBrowser(`${srv.ws}/ws/${id}`);
  browser.handler = (op, args, project) => {
    if (project !== pid) model = emptyModel();
    calls.push({ op, args });
    if (op === "set_part") {
      const a = args as { name: string; source: string };
      const changes = { upsert: [a] };
      model = applyChanges(model, changes);
      return { ok: true, content: [{ type: "text", text: `built ${a.name}` }], changes };
    }
    return { ok: true, content: [{ type: "text", text: op }] };
  };
}

async function connectClient() {
  client = new Client({ name: "test", version: "0" });
  const { token } = await grant(srv.base, id, "Claude Code");
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
}

const text = (r: unknown) => JSON.stringify((r as { content: unknown }).content);

beforeEach(async () => {
  calls.length = 0;
  srv = await startServer({ maxBytes: 5000 });
  ({ ws: id, pid } = await seed(srv.store));
  attachBrowser();
  await browser.open(pid);
  await connectClient();
});
afterEach(async () => {
  await client.close();
  browser.close();
  await srv.app.close();
});

describe("MCP endpoint", () => {
  it("lists tools with schemas and instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "boolean_op", "chamfer", "create_primitive", "delete_part", "export", "fillet", "get_assembly",
      "create_project", "get_params", "get_part", "get_view_image", "get_workspace_link", "guide", "inspect_part", "list_parts", "list_projects", "measure",
      "load_share", "open_project", "set_assembly", "set_assembly_script", "set_model_info",
      "set_param_values", "set_params_form", "set_part_groups", "set_part_script", "show", "transform",
    ].sort());
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
    expect(client.getInstructions()).toMatch(/const main/);
    expect(client.getInstructions()).toMatch(/param\("thickness"\)/);
    expect(client.getInstructions()).toMatch(/set_params_form/);
    expect(client.getInstructions()).toMatch(/set_model_info/);
    expect(client.getInstructions()).toMatch(/set_assembly_script/);
    expect(client.getInstructions()).toMatch(/inspect_part/);
    expect(client.getInstructions()).toMatch(/follow: \{ joint: "Legs\/Left hip", ratio: -1/);
  });

  it("records every tool call in the project's activity, with parameter changes", async () => {
    await client.callTool({ name: "create_primitive", arguments: { name: "box", primitive: { type: "box", width: 1, depth: 1, height: 1 } } });
    await client.callTool({ name: "get_workspace_link", arguments: {} });
    const entries = await srv.activity.list(id, pid);
    expect(entries.map((e) => [e.who, e.verb, e.object])).toEqual([
      ["Claude Code", "asked for the workspace link", null],
      ["Claude Code", "created part", "box"],
    ]);
  });

  it("guide lists topics and returns one, credited; no browser call; logged", async () => {
    const list = await client.callTool({ name: "guide", arguments: {} });
    for (const t of ["modeling:", "assemblies:", "printing:", "dfm:", "standard_parts:"]) expect(text(list)).toContain(t);
    const printing = await client.callTool({ name: "guide", arguments: { topic: "printing" } });
    expect(printing.isError).toBeFalsy();
    expect(text(printing)).toContain("Self-supporting angle");
    const asm = await client.callTool({ name: "guide", arguments: { topic: "assemblies" } });
    expect(text(asm)).toMatch(/pivot on the real axis/);
    expect(text(asm)).toMatch(/measure between the mating faces/);
    expect(text(printing)).toMatch(/inspect_part gives the smallest holes/);
    // Credit lives in the source notice, not in the agent's context
    expect(text(printing)).not.toContain("text-to-cad");
    expect((await client.callTool({ name: "guide", arguments: { topic: "nope" } })).isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(client.getInstructions()).toMatch(/call guide with a topic/);
    const entries = await srv.activity.list(id, pid);
    expect(entries.map((e) => e.object).slice(0, 2)).toEqual(["assemblies", "printing"]);
  });

  it("404 for malformed workspace id", async () => {
    const r = await fetch(`${srv.base}/mcp/nope`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(404);
  });

  it("creates a primitive via relay and persists it", async () => {
    const r = await client.callTool({ name: "create_primitive", arguments: { name: "box", primitive: { type: "box", width: 10, depth: 10, height: 5 } } });
    expect(r.isError).toBe(false);
    expect(calls[0].op).toBe("set_part");
    expect((await srv.store.getModel(id, pid))!.parts.box).toMatch(/makeBaseBox\(10, 10, 5\)/);
  });

  it("boolean_op: missing part error and no change", async () => {
    const r = await client.callTool({ name: "boolean_op", arguments: { name: "c", op: "cut", target: "a", tools: ["b"] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Unknown part\(s\): a, b/);
    expect(calls).toHaveLength(0);
  });

  it("boolean_op: rejects result equal to input", async () => {
    await client.callTool({ name: "create_primitive", arguments: { name: "a", primitive: { type: "sphere", radius: 1 } } });
    const r = await client.callTool({ name: "boolean_op", arguments: { name: "a", op: "union", target: "a", tools: ["a"] } });
    expect(r.isError).toBe(true);
  });

  it("fillet in place wraps previous source", async () => {
    await client.callTool({ name: "create_primitive", arguments: { name: "a", primitive: { type: "box", width: 1, depth: 1, height: 1 } } });
    const r = await client.callTool({ name: "fillet", arguments: { part: "a", radius: 0.1 } });
    expect(r.isError).toBe(false);
    const src = (await srv.store.getModel(id, pid))!.parts.a;
    expect(src).toMatch(/const prev = /);
    expect(src).toMatch(/makeBaseBox/);
  });

  it("validation errors are tool errors and do not relay", async () => {
    const r = await client.callTool({ name: "set_part_script", arguments: { name: "bad name", source: "" } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("size limit rejects without relaying", async () => {
    const r = await client.callTool({ name: "set_part_script", arguments: { name: "big", source: "x".repeat(6000) } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/limit/);
    expect(calls).toHaveLength(0);
  });

  it("browser not connected", async () => {
    browser.close();
    await new Promise((r) => setTimeout(r, 50));
    const r = await client.callTool({ name: "list_parts", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No browser is connected/);
  });

  it("relays view/assembly/export ops with parsed args", async () => {
    await client.callTool({ name: "set_part_script", arguments: { name: "a", source: "const main = () => makeBaseBox(1,1,1)" } });
    calls.length = 0;
    await client.callTool({ name: "set_assembly", arguments: { instances: [{ part: "a" }] } });
    await client.callTool({ name: "get_view_image", arguments: {} });
    await client.callTool({ name: "export", arguments: { part: "a" } });
    await client.callTool({ name: "export", arguments: { format: "step", include: "assembled" } });
    expect(calls).toEqual([
      { op: "set_assembly", args: { assembly: { instances: [{ part: "a", position: [0, 0, 0], rotation: [0, 0, 0] }] } } },
      { op: "get_view_image", args: { direction: "iso" } },
      // STL of everything by default
      { op: "export", args: { part: "a", format: "stl", include: "both", quality: "normal" } },
      { op: "export", args: { format: "step", include: "assembled", quality: "normal" } },
    ]);
  });

  it("set_assembly: groups go as a tree, unknown parts in groups are rejected; scripts are relayed as source", async () => {
    await client.callTool({ name: "set_part_script", arguments: { name: "a", source: "const main = () => makeBaseBox(1,1,1)" } });
    calls.length = 0;
    const bad = await client.callTool({ name: "set_assembly", arguments: { instances: [{ group: "G", children: [{ part: "nope" }] }] } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("Unknown part(s): nope");
    await client.callTool({ name: "set_assembly", arguments: { instances: [{ group: "Leg", axis: [0, 1, 0], angle: 20, limits: [0, 90], children: [{ part: "a" }] }] } });
    const script = "const main = () => [instance(\"a\")];";
    await client.callTool({ name: "set_assembly_script", arguments: { source: script } });
    expect(calls).toEqual([
      { op: "set_assembly", args: { assembly: { instances: [], tree: [
        { group: "Leg", axis: [0, 1, 0], angle: 20, limits: [0, 90], children: [{ part: "a", position: [0, 0, 0], rotation: [0, 0, 0] }] },
      ] } } },
      { op: "set_assembly", args: { assembly: { instances: [], script } } },
    ]);
    const entries = await srv.activity.list(id, pid);
    expect(entries[0]).toMatchObject({ verb: "set the assembly script" });
  });

  it("inspect_part and measure relay their arguments; malformed references are refused", async () => {
    await client.callTool({ name: "inspect_part", arguments: { part: "a", type: "hole" } });
    await client.callTool({ name: "measure", arguments: { a: "a:F3", b: "Leg/a#2:E1" } });
    expect(calls).toEqual([
      { op: "inspect_part", args: { part: "a", type: "hole", limit: 50 } },
      { op: "measure", args: { a: "a:F3", b: "Leg/a#2:E1" } },
    ]);
    const bad = await client.callTool({ name: "measure", arguments: { a: "a F3" } });
    expect(bad.isError).toBe(true);
    const entries = await srv.activity.list(id, pid);
    expect(entries[0]).toMatchObject({ verb: "measured", object: "a:F3", detail: "and Leg/a#2:E1" });
  });

  it("set_params_form: invalid form is a tool error and is not relayed", async () => {
    const r = await client.callTool({ name: "set_params_form", arguments: {
      params: [
        { name: "a", label: "A", type: "number", default: 50, max: 10 },
        { name: "a", label: "B", type: "checkbox", default: true, group: "nope" },
      ],
    } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Duplicate parameter/);
    expect(text(r)).toMatch(/unknown group/);
    expect(text(r)).toMatch(/default must be ≤ 10/);
    expect(calls).toHaveLength(0);
  });

  it("set_params_form: valid form is relayed with defaults applied", async () => {
    const r = await client.callTool({ name: "set_params_form", arguments: {
      groups: [{ id: "g", label: "Geometry" }],
      params: [{ name: "w", label: "Width", type: "slider", min: 1, max: 9, default: 3, unit: "mm", group: "g" }],
    } });
    expect(r.isError).toBe(false);
    expect(calls).toEqual([{ op: "set_params", args: { form: {
      groups: [{ id: "g", label: "Geometry", collapsed: false }],
      params: [{ name: "w", label: "Width", type: "slider", min: 1, max: 9, default: 3, unit: "mm", group: "g" }],
    } } }]);
  });

  it("set_params_form: size limit", async () => {
    const params = Array.from({ length: 60 }, (_, i) => ({ name: `p${i}`, label: "x".repeat(80), type: "checkbox", default: true }));
    const r = await client.callTool({ name: "set_params_form", arguments: { params } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/limit/);
    expect(calls).toHaveLength(0);
  });

  it("set_param_values / get_params relay", async () => {
    await client.callTool({ name: "set_param_values", arguments: { values: { w: 4, on: true, s: "x" } } });
    await client.callTool({ name: "get_params", arguments: {} });
    expect(calls).toEqual([
      { op: "set_param_values", args: { values: { w: 4, on: true, s: "x" } } },
      { op: "get_params", args: {} },
    ]);
  });

  it("load_share: not found creates nothing", async () => {
    const r = await client.callTool({ name: "load_share", arguments: { share: "https://cad.example/s/AAAAAAAAAAAAAAAAAAAAAA" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Share not found/);
    expect(await srv.store.listProjects(id)).toHaveLength(1);
  });

  it("load_share forks into a new active project and leaves the current one", async () => {
    await client.callTool({ name: "create_primitive", arguments: { name: "mine", primitive: { type: "sphere", radius: 1 } } });
    const shared = { ...emptyModel(), parts: { p: "x" }, info: { name: "N" } };
    const pub = await srv.shares.publish(newSessionId(), shared);
    if (!pub.ok) throw new Error("publish");
    calls.length = 0;
    const r = await client.callTool({ name: "load_share", arguments: { share: `https://cad.example/s/${pub.id}` } });
    expect(r.isError).toBe(false);
    const list = await srv.store.listProjects(id);
    const fork = list.find((p) => p.id !== pid)!;
    expect(fork).toMatchObject({ name: "N", forkedFromShare: pub.id });
    expect(text(r)).toContain(fork.id);
    expect(calls).toEqual([{ op: "list_parts", args: {} }]);
    expect(srv.hub.openProject(id)).toBe(fork.id);
    expect(await srv.store.getModel(id, fork.id)).toEqual(shared);
    expect(Object.keys((await srv.store.getModel(id, pid))!.parts)).toEqual(["mine"]);
    expect((await srv.shares.get(pub.id))?.model).toEqual(shared);
  });

  it("project tools: create, list, open, link", async () => {
    let r = await client.callTool({ name: "create_project", arguments: { name: "Shelf bracket" } });
    expect(r.isError).toBeFalsy();
    const created = (await srv.store.listProjects(id)).find((p) => p.name === "Shelf bracket")!;
    expect(text(r)).toContain(created.id);
    expect(browser.msgs.some((m) => m.type === "navigate" && m.project === created.id)).toBe(true);
    expect(srv.hub.openProject(id)).toBe(created.id);

    r = await client.callTool({ name: "list_projects", arguments: {} });
    const listed = JSON.parse((r.content as { text: string }[])[0].text) as { id: string; active: boolean }[];
    expect(listed.map((p) => [p.id, p.active]).sort()).toEqual([[created.id, true], [pid, false]].sort());

    // Model tools now act on the new project
    await client.callTool({ name: "create_primitive", arguments: { name: "b", primitive: { type: "sphere", radius: 1 } } });
    expect(Object.keys((await srv.store.getModel(id, created.id))!.parts)).toEqual(["b"]);

    r = await client.callTool({ name: "open_project", arguments: { id: pid } });
    expect(r.isError).toBeFalsy();
    expect(srv.hub.openProject(id)).toBe(pid);
    r = await client.callTool({ name: "open_project", arguments: { id: newSessionId() } });
    expect(r.isError).toBe(true);

    r = await client.callTool({ name: "get_workspace_link", arguments: {} });
    expect(text(r)).toContain(`/w/${id}`);
  });

  it("notes when the user switched the active project", async () => {
    await client.callTool({ name: "list_parts", arguments: {} });
    const other = (await srv.store.createProject(id, { name: "Wall mount" })) as { id: string };
    await browser.open(other.id);
    let r = await client.callTool({ name: "list_parts", arguments: {} });
    expect(text(r)).toMatch(/active project to \\"Wall mount\\"/);
    r = await client.callTool({ name: "list_parts", arguments: {} });
    expect(text(r)).not.toMatch(/Wall mount/);
  });

  it("opens a project when the tab shows the library", async () => {
    await browser.open(null);
    await sleep(20);
    const r = await client.callTool({ name: "create_primitive", arguments: { name: "a", primitive: { type: "sphere", radius: 1 } } });
    expect(r.isError).toBe(false);
    expect(Object.keys((await srv.store.getModel(id, pid))!.parts)).toEqual(["a"]);
  });

  it("set_model_info relays trimmed info", async () => {
    await client.callTool({ name: "set_model_info", arguments: { name: "  Hook ", description: "A hook" } });
    expect(calls).toEqual([{ op: "set_model_info", args: { info: { name: "Hook", description: "A hook" } } }]);
    const bad = await client.callTool({ name: "set_model_info", arguments: { name: "" } });
    expect(bad.isError).toBe(true);
  });

  it("set_part_groups validates parts and groups; set_part_script group must exist", async () => {
    await client.callTool({ name: "create_primitive", arguments: { name: "a", primitive: { type: "sphere", radius: 1 } } });
    calls.length = 0;
    let r = await client.callTool({ name: "set_part_groups", arguments: { groups: [{ id: "g", label: "G" }], assign: { a: "g", ghost: "g" } } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Unknown part\(s\): ghost/);
    r = await client.callTool({ name: "set_part_groups", arguments: { groups: [{ id: "g", label: "G" }], assign: { a: "zz" } } });
    expect(text(r)).toMatch(/unknown group \\?"zz/);
    expect(calls).toHaveLength(0);
    r = await client.callTool({ name: "set_part_groups", arguments: { groups: [{ id: "g", label: "G", collapsed: true }], assign: { a: "g" } } });
    expect(calls).toEqual([{ op: "set_part_groups", args: { groups: { groups: [{ id: "g", label: "G", collapsed: true }], assign: { a: "g" } } } }]);
    // Fake browser doesn't store groups, so the project model has none: group must be rejected
    calls.length = 0;
    r = await client.callTool({ name: "set_part_script", arguments: { name: "b", source: "x", group: "g" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Unknown part group \\?"g/);
    expect(calls).toHaveLength(0);
  });
});
