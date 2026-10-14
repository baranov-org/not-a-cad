import { z } from "zod";
import { Assembly, Changes, Model, ModelInfo, PartGroups, PartName } from "./model";
import { ParamsForm, ParamValue } from "./params";

export const Direction = z.enum(["iso", "front", "top", "right"]);
export type Direction = z.infer<typeof Direction>;

// Ops relayed to the browser
export const BrowserOps = {
  list_parts: z.object({}),
  get_part: z.object({ name: PartName }),
  set_part: z.object({ name: PartName, source: z.string(), group: z.string().optional() }),
  delete_part: z.object({ name: PartName }),
  set_assembly: z.object({ assembly: Assembly }),
  get_assembly: z.object({}),
  inspect_part: z.object({
    part: PartName,
    type: z.string().optional(),
    minRadius: z.number().optional(),
    maxRadius: z.number().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  measure: z.object({ a: z.string(), b: z.string().optional() }),
  show: z.object({ part: PartName.optional() }),
  get_view_image: z.object({ part: PartName.optional(), direction: Direction.default("iso") }),
  export: z.object({
    part: PartName.optional(),
    format: z.enum(["stl", "3mf", "step", "obj"]).default("stl"),
    include: z.enum(["parts", "assembled", "both"]).default("both"),
    quality: z.enum(["draft", "normal", "fine"]).default("normal"),
  }),
  set_params: z.object({ form: ParamsForm }),
  set_param_values: z.object({ values: z.record(z.string(), ParamValue) }),
  get_params: z.object({}),
  set_model_info: z.object({ info: ModelInfo }),
  set_part_groups: z.object({ groups: PartGroups }),
} as const;
export type OpName = keyof typeof BrowserOps;
export type OpArgs<K extends OpName> = z.infer<(typeof BrowserOps)[K]>;

export const Content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
  // File returned to the agent (base64 blob)
  z.object({
    type: z.literal("resource"),
    resource: z.object({ uri: z.string(), mimeType: z.string(), blob: z.string() }),
  }),
]);
export type Content = z.infer<typeof Content>;

// Pending agent connection, as shown on the consent screen and in the workspace modal
export const AuthRequestInfo = z.object({
  id: z.string(),
  client: z.object({ name: z.string().nullable(), version: z.string().nullable(), recognised: z.boolean() }),
  country: z.string().nullable(),
  created: z.number(),
  expires: z.number(),
  status: z.enum(["pending", "allowed", "denied", "expired"]),
});
export type AuthRequestInfo = z.infer<typeof AuthRequestInfo>;

// Approved agent of a workspace
export const AgentInfo = z.object({
  clientId: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  approvedAt: z.number(),
  lastUsed: z.number().nullable(),
  connected: z.boolean(),
  busy: z.string().nullable(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const ServerMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("restore"), project: z.string(), model: Model }),
  // Agent asks the tab to open a project (tab answers with "open")
  z.object({ type: z.literal("navigate"), project: z.string(), by: z.string().optional() }),
  z.object({
    type: z.literal("call"),
    id: z.string(),
    op: z.enum(Object.keys(BrowserOps) as [OpName, ...OpName[]]),
    args: z.unknown(),
    project: z.string(),
  }),
  z.object({ type: z.literal("superseded") }),
  // Pending approval requests for this workspace (full list)
  z.object({ type: z.literal("auth_requests"), requests: z.array(AuthRequestInfo) }),
  // Approved agents with live state (full list)
  z.object({ type: z.literal("agents"), agents: z.array(AgentInfo) }),
  // A tool call started (tool) or finished (null)
  z.object({ type: z.literal("agent_busy"), client: z.string(), tool: z.string().nullable() }),
  // Activity log of the open project changed
  z.object({ type: z.literal("activity") }),
  // Keepalive: Cloudflare drops WebSockets idle for 100 s
  z.object({ type: z.literal("ping") }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;

export const ClientMsg = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("result"),
    id: z.string(),
    ok: z.boolean(),
    content: z.array(Content),
    changes: Changes.optional(),
  }),
  // Unsolicited state from the browser (user edits); the server accepts only params and info
  z.object({ type: z.literal("changes"), project: z.string(), changes: Changes }),
  // The tab shows this project (null = library)
  z.object({ type: z.literal("open"), project: z.string().nullable() }),
  // Tab visibility, for the "changed by agent" marker
  z.object({ type: z.literal("visibility"), visible: z.boolean() }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

export const WS_CLOSE_SUPERSEDED = 4001;
