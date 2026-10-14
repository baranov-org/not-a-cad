import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  booleanSource, chamferSource, filletSource, mergeValues, PartGroups, primitiveSource, ToolInputs, transformSource,
  type AssemblyNode, type Model, type OpName,
} from "shared";
import type { ActivityLog } from "./activity";
import type { CallResult, Hub } from "./hub";
import { INSTRUCTIONS } from "./instructions";
import type { ShareStore } from "./shareStore";
import type { Store } from "./store";
import { GUIDES } from "./guides";

const toResult = (r: CallResult): CallToolResult => ({ content: r.content, isError: !r.ok });
const reject = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });
const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

// Share id from a /s/<id> URL or a bare id
const shareIdOf = (s: string) => s.trim().match(/(?:\/s\/)?([A-Za-z0-9_-]{22})\/?(?:[?#].*)?$/)?.[1];

// One MCP server per request, bound to a workspace; model tools act on its active project
// Activity entries for a tool call (verb, object, detail)
type Entry = { verb: string; object?: string; detail?: string };
const VERBS: Record<string, string> = {
  list_parts: "listed parts", get_part: "inspected part", set_part_script: "set script of part", delete_part: "deleted part",
  create_primitive: "created part", boolean_op: "combined parts into", fillet: "filleted", chamfer: "chamfered",
  transform: "transformed", set_assembly: "set the assembly", set_assembly_script: "set the assembly script", get_assembly: "read the assembly", show: "showed",
  get_view_image: "took a screenshot of", export: "exported", set_params_form: "defined parameters",
  set_param_values: "changed parameter", get_params: "read parameters", set_part_groups: "grouped parts",
  set_model_info: "renamed model", load_share: "forked share", list_projects: "listed projects", open_project: "opened project",
  create_project: "created project", get_workspace_link: "asked for the workspace link", guide: "read the guide",
  inspect_part: "inspected the features of", measure: "measured",
};

function describe(name: string, a: Record<string, unknown>, before?: Model): Entry[] {
  const verb = VERBS[name] ?? name;
  const s = (v: unknown) => (v === undefined ? undefined : String(v));
  switch (name) {
    case "set_param_values":
      return Object.entries(a.values as Record<string, unknown>).map(([k, v]) => ({
        verb, object: k, detail: `${before?.params.values[k] ?? "—"} → ${v}`,
      }));
    case "create_primitive":
      return [{ verb, object: s(a.name), detail: (a.primitive as { type: string }).type }];
    case "boolean_op":
      return [{ verb, object: s(a.name), detail: `${a.op} of ${a.target} and ${(a.tools as string[]).join(", ")}` }];
    case "fillet": case "chamfer": case "transform":
      return [{ verb, object: s(a.result ?? a.part) }];
    case "set_assembly":
      return [{ verb, detail: `${(a.instances as unknown[]).length} nodes` }];
    case "set_assembly_script":
      return [{ verb }];
    case "show": case "get_view_image":
      return [{ verb, object: s(a.part) ?? "assembly" }];
    case "export":
      // File names follow the model name in the browser; log what and how
      return [{ verb, object: s(a.part) ?? "assembly", detail: String(a.format ?? "stl").toUpperCase() }];
    case "set_params_form":
      return [{ verb, detail: `${(a.params as unknown[]).length} parameters` }];
    case "set_part_groups":
      return [{ verb, detail: `${(a.groups as unknown[]).length} groups` }];
    case "set_model_info": case "create_project":
      return [{ verb, object: s(a.name) }];
    case "load_share":
      return [{ verb, object: s(a.share) }];
    case "open_project":
      return [{ verb, object: s(a.id) }];
    case "guide":
      return [{ verb, object: s(a.topic) ?? "topics" }];
    case "inspect_part":
      return [{ verb, object: s(a.part) }];
    case "measure":
      return [{ verb, object: s(a.a), detail: a.b ? `and ${a.b}` : undefined }];
    default:
      return [{ verb, object: s(a.name) }];
  }
}

export interface McpContext {
  clientId: string;
  clientName: string;
  activity?: ActivityLog;
}

export function buildMcpServer(ws: string, hub: Hub, store: Store, shares: ShareStore, origin = "", ctx?: McpContext): McpServer {
  const server = new McpServer({ name: "not-a-cad", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  // Note for the agent when the user switched projects, prepended to the result
  let note: string | undefined;
  // Project the current call acted on (for the activity log)
  let acted: string | undefined;

  // Runs fn against the active project (opening one if the tab shows the library)
  const onProject = async (fn: (pid: string, model: Model) => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> => {
    const t = await hub.target(ws);
    if (!t.ok) return toResult({ ok: false, content: t.content });
    note = t.note;
    acted = t.project;
    const model = await store.getModel(ws, t.project);
    return model ? fn(t.project, model) : reject("Unknown project");
  };
  const relay = async (pid: string, op: OpName, args: unknown) => toResult(await hub.call(ws, pid, op, args));
  const relayOp = (op: OpName, args: unknown) => onProject((pid) => relay(pid, op, args));

  const missing = (model: Model, names: string[]) => {
    const m = names.filter((n) => !(n in model.parts));
    return m.length ? reject(`Unknown part(s): ${m.join(", ")}`) : undefined;
  };

  const setPart = async (pid: string, model: Model, name: string, source: string, group?: string) => {
    if (group !== undefined && !model.groups.groups.some((g) => g.id === group)) {
      return reject(`Unknown part group "${group}". Define it first with set_part_groups.`);
    }
    const err = await store.checkSize(ws, pid, { upsert: [{ name, source }] });
    return err ? reject(err) : relay(pid, "set_part", { name, source, ...(group !== undefined ? { group } : {}) });
  };

  const tool = <K extends keyof typeof ToolInputs>(
    name: K,
    description: string,
    handler: (args: ReturnType<(typeof ToolInputs)[K]["parse"]>) => Promise<CallToolResult> | CallToolResult,
  ) => {
    const run = async (args: never) => {
      const open = hub.openProject(ws) ?? undefined;
      const before = name === "set_param_values" && open ? await store.getModel(ws, open) : undefined;
      if (ctx) hub.busy(ws, ctx.clientId, name);
      let r: CallToolResult;
      try {
        r = await handler(args);
      } finally {
        if (ctx) hub.busy(ws, ctx.clientId, null);
      }
      await record(name, args as Record<string, unknown>, r, before);
      return note ? { ...r, content: [{ type: "text" as const, text: note }, ...r.content] } : r;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.registerTool(name, { description, inputSchema: ToolInputs[name] }, run as any);
  };

  const record = async (name: string, args: Record<string, unknown>, r: CallToolResult, before?: Model) => {
    if (!ctx?.activity) return;
    const pid = acted ?? hub.openProject(ws) ?? (await store.activeProject(ws));
    if (!pid) return;
    for (const e of describe(name, args, before)) {
      const detail = r.isError ? [e.detail, "failed"].filter(Boolean).join(", ") : e.detail;
      await ctx.activity.add(ws, pid, { who: ctx.clientName, ...e, detail });
    }
    hub.activityChanged(ws, pid);
  };

  tool("list_parts", "List all parts with status and short metrics.", () => relayOp("list_parts", {}));
  tool("get_part", "Get a part's source, status, error, bounding box, volume, face/edge counts and referenced parts.", (a) =>
    relayOp("get_part", a));
  tool("set_part_script", "Create or replace a part from a replicad script (see server instructions for the contract).", (a) =>
    onProject((pid, m) => setPart(pid, m, a.name, a.source, a.group)));
  tool("delete_part", "Delete a part. Refused if other parts reference it.", (a) => relayOp("delete_part", a));

  tool("create_primitive", "Create a part from a primitive: box (centred XY, base on Z=0), cylinder/cone (base on Z=0, axis Z), sphere, torus (axis Z).", (a) =>
    onProject((pid, m) => setPart(pid, m, a.name, primitiveSource(a.primitive))));

  tool("boolean_op", "Combine existing parts into a result part: union, cut (target minus tools) or intersect. The result stays linked to its inputs.", (a) => {
    if (a.name === a.target || a.tools.includes(a.name)) return reject("Result name must differ from the input parts");
    return onProject((pid, m) => missing(m, [a.target, ...a.tools]) ?? setPart(pid, m, a.name, booleanSource(a.op, a.target, a.tools)));
  });

  const derivedOp = (part: string, result: string | undefined, gen: (prev?: string) => string) =>
    onProject((pid, m) => {
      const miss = missing(m, [part]);
      if (miss) return miss;
      const inPlace = (result ?? part) === part;
      return setPart(pid, m, result ?? part, gen(inPlace ? m.parts[part] : undefined));
    });

  tool("fillet", "Round edges of a part. edges: \"all\", {parallelTo: axis} or {inPlane, offset}.", (a) =>
    derivedOp(a.part, a.result, (prev) => filletSource(a.part, a.radius, a.edges, prev)));
  tool("chamfer", "Chamfer edges of a part. edges: \"all\", {parallelTo: axis} or {inPlane, offset}.", (a) =>
    derivedOp(a.part, a.result, (prev) => chamferSource(a.part, a.distance, a.edges, prev)));
  tool("transform", "Rotate (XYZ Euler degrees about origin) then translate (mm) a part's geometry.", (a) =>
    derivedOp(a.part, a.result, (prev) => transformSource(a.part, a.rotate, a.translate, prev)));

  // Static assembly: flat instances, or a tree when groups are used; replaces any assembly script
  const partsIn = (nodes: AssemblyNode[]): string[] => nodes.flatMap((n) => ("group" in n ? partsIn(n.children) : [n.part]));
  tool("set_assembly", "Replace the assembly with a static list or tree: instances {part, position (mm), rotation (XYZ degrees), color?, label?} and groups {group, children, position?, rotation? (about pivot?), or a joint: axis + angle (degrees, about pivot), or slide {axis, distance}; limits? [min,max]; follow? {joint: \"Group/Path\", ratio, offset?}; color?}. Children move with their group. Replaces any assembly script.", (a) =>
    onProject(async (pid, m) => {
      const miss = missing(m, [...new Set(partsIn(a.instances))]);
      if (miss) return miss;
      const grouped = a.instances.some((n) => "group" in n);
      return relay(pid, "set_assembly", { assembly: grouped ? { instances: [], tree: a.instances } : { instances: a.instances } });
    }));
  tool("set_assembly_script", "Set the assembly as a script (see the server instructions): parameters can set counts, positions and joint angles, and re-pose it live without rebuilding parts. Returns the instance count, warnings, or the error. Replaces any static assembly.", (a) =>
    onProject(async (pid) => {
      const assembly = { instances: [], script: a.source };
      const err = await store.checkSize(ws, pid, { assembly });
      return err ? reject(err) : relay(pid, "set_assembly", { assembly });
    }));
  tool("get_assembly", "Get the assembly: its script or static tree, and the placed instances (world position and rotation, group path).", () => relayOp("get_assembly", {}));
  tool("inspect_part", "Measurable features of a part, exact from the B-rep: hole/boss diameters with counts, fillet radii, planes, face/edge types, and a list of features with references (part:F3, part:E12) for measure. References stay valid until the part rebuilds.", (a) =>
    relayOp("inspect_part", a));
  tool("measure", "Exact measurements of one or two entities by reference (part:F3, part:E12, part:V4, or <instance key>:F3 for an assembly instance): lengths, radii/diameters, fillet radii, areas; for two: distance with closest points, angle, centre-to-centre and axis offset. The user can copy references from the viewer's Measure tool.", (a) =>
    relayOp("measure", a));
  tool("show", "Switch the user's viewer to a part, or to the assembly when part is omitted.", (a) => relayOp("show", a));
  tool("get_view_image", "Render a PNG of a part (or the assembly) from iso/front/top/right to check your work.", (a) =>
    relayOp("get_view_image", a));
  tool("export", "Export a part, or the assembly, as STL, 3MF (parts and colours), STEP (exact geometry) or OBJ. For assemblies, include: parts (one file per unique part resting on Z = 0), assembled (instances in place) or both; several files come as a ZIP. The file is returned to you as an embedded resource (base64); nothing downloads for the user. Max 8 MB; prefer single parts for large models.", (a) =>
    relayOp("export", a));

  tool("set_params_form", "Define or replace the project's parameters form shown to the user (number with unit, slider, checkbox, radio, select, text; optional collapsible groups). Scripts read values with param(\"name\"). Values the user already set are kept when still valid. Empty params removes the form.", (form) =>
    onProject(async (pid, m) => {
      const err = await store.checkSize(ws, pid, { params: { form, values: mergeValues(m.params, form) } });
      return err ? reject(err) : relay(pid, "set_params", { form });
    }));
  tool("set_param_values", "Set one or more parameter values; affected parts rebuild. Returns their status.", (a) =>
    relayOp("set_param_values", a));
  tool("get_params", "Get the parameters form and current values, including values the user changed in the browser.", () =>
    relayOp("get_params", {}));

  tool("set_part_groups", "Organise parts into collapsible groups in the user's parts list (e.g. 'Stage 1', 'Housing'). Replaces all groups; assign maps part name -> group id; unassigned parts are ungrouped. Use for models with more than a few parts.", (a) => {
    const parsed = PartGroups.safeParse(a);
    if (!parsed.success) return reject(parsed.error.issues.map((i) => i.message).join("\n"));
    return onProject((pid, m) => {
      const unknown = Object.keys(parsed.data.assign).filter((p) => !(p in m.parts));
      if (unknown.length) return reject(`Unknown part(s): ${unknown.join(", ")}`);
      return relay(pid, "set_part_groups", { groups: parsed.data });
    });
  });

  tool("set_model_info", "Name and describe the model (shown to the user and used as the title/description when they share it). Set this early and keep it current.", (a) =>
    relayOp("set_model_info", { info: a }));

  // ---- projects

  const switchTo = async (pid: string, what: string): Promise<CallToolResult> => {
    const r = await hub.open(ws, pid, ctx?.clientName);
    if (!r.ok) return toResult(r);
    const p = await store.project(ws, pid);
    const tab = hub.isConnected(ws) ? "" : " No browser is connected; it opens when the user opens their workspace.";
    return text(`${what} "${p?.name ?? "Untitled"}" (${pid}); it is now the active project.${tab}`);
  };

  tool("list_projects", "List the workspace's projects: id, name, last edited, and which one is active (model tools act on the active project).", async () => {
    const list = await store.listProjects(ws);
    const active = hub.openProject(ws) ?? (await store.activeProject(ws));
    return text(JSON.stringify(list.map((p) => ({
      id: p.id, name: p.name, updated: new Date(p.updated).toISOString(), active: p.id === active,
    })), null, 1));
  });

  tool("open_project", "Make a project active (by id from list_projects); the user's tab follows.", async (a) => {
    if (!(await store.project(ws, a.id))) return reject(`Unknown project: ${a.id}`);
    return switchTo(a.id, "Opened");
  });

  tool("create_project", "Create a new empty project and make it active; the user's tab follows. Use for a new, unrelated model.", async (a) => {
    const c = await store.createProject(ws, { name: a.name });
    return c.ok ? switchTo(c.id, "Created") : reject(c.error);
  });

  tool("guide", "Design guidance: modeling (read requests, robust parts, fixing failures, checking results), assemblies, printing (3D-print review), dfm (sheet metal, CNC, moulding review), standard_parts (real screw/bearing/motor dimensions). Read the relevant topic before non-trivial work or a printability/manufacturing review.", (a) => {
    if (!a.topic) return text(Object.entries(GUIDES).map(([k, g]) => `${k}: ${g.title}`).join("\n"));
    return text(GUIDES[a.topic].text);
  });

  tool("get_workspace_link", "Get the user's workspace link (their library of projects). Give it to the user when they ask for their not-a-cad link.", () =>
    text(`${origin}/w/${ws}`));

  tool("load_share", "Fork a public share (by URL or id) into a new project to improve or change it: copies its parts, assembly, parameters, groups, name and description, and makes the new project active. The original share is never modified; the user can publish the result as their own share.", async (a) => {
    const id = shareIdOf(a.share);
    const s = id ? await shares.get(id) : undefined;
    if (!s) return reject(`Share not found: ${a.share}`);
    const c = await store.createProject(ws, { model: s.model, forkedFromShare: id });
    if (!c.ok) return reject(c.error);
    const opened = await switchTo(c.id, "Loaded the share as new project");
    if (opened.isError || !hub.isConnected(ws)) return opened;
    const parts = await relay(c.id, "list_parts", {});
    return { ...parts, content: [...opened.content, ...parts.content] };
  });

  return server;
}
