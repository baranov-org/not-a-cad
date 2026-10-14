import { z } from "zod";
import { emptyParams, ParamGroup, Params } from "./params";

export const PART_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const PartName = z.string().regex(PART_NAME_RE, "Part name must match [A-Za-z0-9_-]{1,64}");

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

export const Instance = z.object({
  part: PartName,
  position: Vec3.default([0, 0, 0]).describe("Position in mm"),
  rotation: Vec3.default([0, 0, 0]).describe("XYZ Euler rotation in degrees"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Hex colour, e.g. #ff8800"),
});
export type Instance = z.infer<typeof Instance>;

// Assembly trees: instances and groups that move their children (pivot rotation, revolute or sliding joints)
const Label = z.string().trim().min(1).max(80).regex(/^[^/]+$/, "Labels can't contain \"/\" (it separates group levels)");
export const InstanceNode = Instance.extend({ label: Label.optional() });
export type InstanceNode = z.infer<typeof InstanceNode>;

export interface GroupNode {
  group: string;
  position?: Vec3;
  rotation?: Vec3;
  pivot?: Vec3;
  axis?: Vec3;
  angle?: number;
  slide?: { axis: Vec3; distance: number };
  limits?: [number, number];
  follow?: { joint: string; ratio: number; offset?: number };
  color?: string;
  children: AssemblyNode[];
  // Set by the script runner: the parameter whose value drives this joint (range warnings)
  driver?: string;
}
export type AssemblyNode = InstanceNode | GroupNode;

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const GroupNode: z.ZodType<GroupNode> = z.lazy(() =>
  z.object({
    group: Label.describe("Group label"),
    position: Vec3.optional().describe("Position in mm, applied after the rotation"),
    rotation: Vec3.optional().describe("XYZ Euler degrees about the pivot"),
    pivot: Vec3.optional().describe("Point the rotation turns about (and the joint axis passes through)"),
    axis: Vec3.optional().describe("Revolute joint axis; turns children by angle about pivot"),
    angle: z.number().optional().describe("Revolute joint angle in degrees"),
    slide: z.object({ axis: Vec3, distance: z.number() }).optional().describe("Sliding joint: move children along axis by distance mm"),
    limits: z.tuple([z.number(), z.number()]).optional().describe("Joint limits: degrees (revolute) or mm (sliding); values are clamped"),
    follow: z.object({ joint: z.string(), ratio: z.number(), offset: z.number().optional() }).optional()
      .describe("Follow another joint (label path, e.g. \"Legs/Left hip\"): value = ratio × that joint + offset"),
    color: Color.optional().describe("Colour for children without their own"),
    children: z.array(AssemblyNode),
    driver: z.string().optional(),
  }));
export const AssemblyNode: z.ZodType<AssemblyNode> = z.lazy(() => z.union([GroupNode, InstanceNode]));

export const MAX_DEPTH = 8;
export const MAX_INSTANCES = 2000;

const depth = (nodes: AssemblyNode[]): number =>
  Math.max(0, ...nodes.map((n) => ("group" in n ? 1 + depth(n.children) : 0)));

// Stored source: a flat list (instances), a static tree, or a script; tree and script leave instances empty
export const Assembly = z
  .object({
    instances: z.array(Instance).default([]),
    tree: z.array(AssemblyNode).optional(),
    script: z.string().max(200_000).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.tree && depth(a.tree) > MAX_DEPTH) ctx.addIssue({ code: "custom", message: `Groups nest at most ${MAX_DEPTH} levels` });
  });
export type Assembly = z.infer<typeof Assembly>;

export const ModelInfo = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

// Collapsible part groups in the parts list; each part in at most one group
export const PartGroups = z
  .object({
    groups: z.array(ParamGroup).max(50).default([]),
    assign: z.record(PartName, ParamGroup.shape.id).default({}),
  })
  .superRefine((g, ctx) => {
    const ids = new Set<string>();
    for (const x of g.groups) {
      if (ids.has(x.id)) ctx.addIssue({ code: "custom", message: `Duplicate group "${x.id}"` });
      ids.add(x.id);
    }
    for (const [part, id] of Object.entries(g.assign)) {
      if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `Part "${part}" assigned to unknown group "${id}"` });
    }
  });
export type PartGroups = z.infer<typeof PartGroups>;
export const emptyGroups = (): PartGroups => ({ groups: [], assign: {} });

// Stored per session: part sources, assembly, part groups, params form with values, and name/description
export const Model = z.object({
  parts: z.record(z.string(), z.string()),
  assembly: Assembly,
  params: Params.default(emptyParams), // absent in sessions stored before params existed
  info: ModelInfo.default({}),
  groups: PartGroups.default(emptyGroups),
});
export type Model = z.infer<typeof Model>;

export const emptyModel = (): Model => ({ parts: {}, assembly: { instances: [] }, params: emptyParams(), info: {}, groups: emptyGroups() });

export const Changes = z.object({
  upsert: z.array(z.object({ name: PartName, source: z.string() })).optional(),
  delete: z.array(PartName).optional(),
  assembly: Assembly.optional(),
  params: Params.optional(),
  info: ModelInfo.optional(),
  groups: PartGroups.optional(),
});
export type Changes = z.infer<typeof Changes>;

export function applyChanges(model: Model, ch: Changes): Model {
  const parts = { ...model.parts };
  for (const name of ch.delete ?? []) delete parts[name];
  for (const p of ch.upsert ?? []) parts[p.name] = p.source;
  const groups = ch.groups ?? model.groups;
  // Deleted parts leave their group
  const assign = Object.fromEntries(Object.entries(groups.assign).filter(([p]) => p in parts));
  return { parts, assembly: ch.assembly ?? model.assembly, params: ch.params ?? model.params, info: ch.info ?? model.info, groups: { ...groups, assign } };
}

// Names referenced via part("name") string literals
export function partRefs(source: string): string[] {
  const refs = new Set<string>();
  for (const m of source.matchAll(/\bpart\(\s*["'`]([A-Za-z0-9_-]{1,64})["'`]\s*\)/g)) refs.add(m[1]);
  return [...refs];
}
