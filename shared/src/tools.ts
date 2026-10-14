import { z } from "zod";
import { AssemblyNode, PartName, Vec3 } from "./model";
import { Direction } from "./protocol";
import { ParamsForm, ParamValue } from "./params";

const pos = z.number().positive();

export const Primitive = z.discriminatedUnion("type", [
  z.object({ type: z.literal("box"), width: pos.describe("X"), depth: pos.describe("Y"), height: pos.describe("Z") }),
  z.object({ type: z.literal("cylinder"), radius: pos, height: pos }),
  z.object({ type: z.literal("sphere"), radius: pos }),
  z
    .object({ type: z.literal("cone"), radius1: z.number().nonnegative(), radius2: z.number().nonnegative(), height: pos })
    .refine((c) => c.radius1 > 0 || c.radius2 > 0, "At least one cone radius must be > 0"),
  z.object({ type: z.literal("torus"), majorRadius: pos, minorRadius: pos }),
]);
export type Primitive = z.infer<typeof Primitive>;

export const EdgeFilter = z
  .union([
    z.literal("all"),
    z.object({ parallelTo: z.enum(["X", "Y", "Z"]).describe("Edges along this axis") }),
    z.object({ inPlane: z.enum(["XY", "XZ", "YZ"]), offset: z.number().default(0).describe("Plane offset in mm") }),
  ])
  .default("all");
export type EdgeFilter = z.infer<typeof EdgeFilter>;

const result = PartName.optional().describe("Result part name; defaults to the input part (modified in place)");

// MCP tool input shapes (top-level objects)
export const ToolInputs = {
  list_parts: z.object({}),
  get_part: z.object({ name: PartName }),
  set_part_script: z.object({
    name: PartName,
    source: z.string().max(200_000).describe("Script defining `const main = () => <Shape3D>`"),
    group: z.string().optional().describe("Existing part group id to put this part in (see set_part_groups)"),
  }),
  delete_part: z.object({ name: PartName }),
  create_primitive: z.object({ name: PartName, primitive: Primitive }),
  boolean_op: z.object({
    name: PartName.describe("Result part name"),
    op: z.enum(["union", "cut", "intersect"]),
    target: PartName,
    tools: z.array(PartName).min(1),
  }),
  fillet: z.object({ part: PartName, radius: pos, edges: EdgeFilter, result }),
  chamfer: z.object({ part: PartName, distance: pos, edges: EdgeFilter, result }),
  transform: z.object({
    part: PartName,
    rotate: Vec3.optional().describe("XYZ Euler degrees about origin, applied before translate"),
    translate: Vec3.optional().describe("mm"),
    result,
  }),
  set_assembly: z.object({
    instances: z.array(AssemblyNode).describe("Instances and groups: {part, position?, rotation?, color?, label?} or {group, position?, rotation?, pivot?, axis?, angle?, slide?, limits?, follow?, color?, children}"),
  }),
  set_assembly_script: z.object({ source: z.string().describe("Assembly script: const main = () => [instance(...), group(...)]") }),
  get_assembly: z.object({}),
  inspect_part: z.object({
    part: PartName,
    type: z.string().optional().describe("Only features of this type: hole, boss, fillet, plane, cylinder, sphere, torus, cone, line, circle, arc…"),
    minRadius: z.number().optional().describe("Only features with a radius ≥ this (mm)"),
    maxRadius: z.number().optional().describe("Only features with a radius ≤ this (mm)"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max features listed (the summary always covers all)"),
  }),
  measure: z.object({
    a: z.string().regex(/^.+:[FEV]\d+$/, "Reference like part:F3, part:E12, part:V4 or <instance key>:F3"),
    b: z.string().regex(/^.+:[FEV]\d+$/, "Reference like part:F3, part:E12, part:V4 or <instance key>:F3").optional().describe("Second entity: distance, angle, centre-to-centre"),
  }),
  show: z.object({ part: PartName.optional().describe("Part to show; omit for assembly") }),
  get_view_image: z.object({
    part: PartName.optional().describe("Part to render; omit for assembly"),
    direction: Direction.default("iso"),
  }),
  export: z.object({
    part: PartName.optional().describe("Part to export; omit for the assembly"),
    format: z.enum(["stl", "3mf", "step", "obj"]).default("stl").describe("stl/obj: mesh; 3mf: parts and colours; step: exact B-rep"),
    include: z.enum(["parts", "assembled", "both"]).default("both")
      .describe("Assembly only: parts = one file per unique part resting on Z = 0; assembled = instances in place; both"),
    quality: z.enum(["draft", "normal", "fine"]).default("normal")
      .describe("Mesh formats: draft = the viewer's mesh (fast, coarse); normal = re-meshed to ~1/10,000 of the part's size, 0.1 rad; fine = twice as tight"),
  }),
  set_params_form: ParamsForm,
  set_param_values: z.object({ values: z.record(z.string(), ParamValue).describe("Parameter name -> value") }),
  get_params: z.object({}),
  set_model_info: z.object({
    name: z.string().trim().min(1).max(80).describe("Short model name, e.g. 'Wall bracket'"),
    description: z.string().trim().max(500).optional().describe("What it is, what it's for, key parameters"),
  }),
  set_part_groups: z.object({
    groups: z.array(z.object({
      id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      label: z.string().min(1).max(80),
      collapsed: z.boolean().default(false).describe("Start collapsed in the parts list"),
    })).max(50),
    assign: z.record(z.string(), z.string()).default({}).describe("Part name -> group id; omitted parts are ungrouped"),
  }),
  load_share: z.object({
    share: z.string().describe("Share URL (https://…/s/<id>) or share id"),
  }),
  list_projects: z.object({}),
  open_project: z.object({ id: z.string().describe("Project id from list_projects") }),
  create_project: z.object({ name: z.string().trim().min(1).max(80).optional().describe("Project name") }),
  get_workspace_link: z.object({}),
  guide: z.object({
    topic: z.enum(["modeling", "assemblies", "printing", "dfm", "standard_parts"]).optional()
      .describe("Omit to list the topics"),
  }),
} as const;
export type ToolName = keyof typeof ToolInputs;
