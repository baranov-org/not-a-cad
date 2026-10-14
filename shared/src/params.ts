import { z } from "zod";

export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ParamName = z.string().regex(PARAM_NAME_RE, "Name must match [A-Za-z_][A-Za-z0-9_]{0,63}");

const base = {
  name: ParamName,
  label: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  group: z.string().optional().describe("Group id"),
};
const unit = z.string().max(12).optional().describe("Display label only, e.g. mm, deg");
const step = z.number().positive().optional();

export const ParamOption = z.object({
  value: z.union([z.string().max(100), z.number()]),
  label: z.string().min(1).max(80),
});

export const Param = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("number"), default: z.number(), min: z.number().optional(), max: z.number().optional(), step, unit }),
  z.object({ ...base, type: z.literal("slider"), default: z.number(), min: z.number(), max: z.number(), step, unit }),
  z.object({ ...base, type: z.literal("checkbox"), default: z.boolean() }),
  z.object({ ...base, type: z.literal("radio"), default: ParamOption.shape.value, options: z.array(ParamOption).min(1).max(50) }),
  z.object({ ...base, type: z.literal("select"), default: ParamOption.shape.value, options: z.array(ParamOption).min(1).max(50) }),
  z.object({
    ...base,
    type: z.literal("text"),
    default: z.string(),
    maxLength: z.number().int().min(1).max(1000).default(200),
    placeholder: z.string().max(100).optional(),
  }),
]);
export type Param = z.infer<typeof Param>;

export const ParamGroup = z.object({
  id: ParamName,
  label: z.string().min(1).max(80),
  collapsed: z.boolean().default(false),
});
export type ParamGroup = z.infer<typeof ParamGroup>;

export type ParamValue = number | boolean | string;
export const ParamValue = z.union([z.number(), z.boolean(), z.string().max(1000)]);

// Error message if v is not a valid value for p
export function validateValue(p: Param, v: unknown): string | undefined {
  switch (p.type) {
    case "number":
    case "slider":
      if (typeof v !== "number" || !Number.isFinite(v)) return "must be a number";
      if (p.min !== undefined && v < p.min) return `must be ≥ ${p.min}`;
      if (p.max !== undefined && v > p.max) return `must be ≤ ${p.max}`;
      return;
    case "checkbox":
      return typeof v === "boolean" ? undefined : "must be true or false";
    case "radio":
    case "select":
      return p.options.some((o) => o.value === v) ? undefined : `must be one of: ${p.options.map((o) => JSON.stringify(o.value)).join(", ")}`;
    case "text":
      if (typeof v !== "string") return "must be text";
      return v.length > p.maxLength ? `must be at most ${p.maxLength} characters` : undefined;
  }
}

export const ParamsForm = z
  .object({
    params: z.array(Param).max(100),
    groups: z.array(ParamGroup).max(20).default([]),
  })
  .superRefine((f, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const names = new Set<string>();
    for (const p of f.params) {
      if (names.has(p.name)) issue(`Duplicate parameter "${p.name}"`);
      names.add(p.name);
    }
    const groups = new Set<string>();
    for (const g of f.groups) {
      if (groups.has(g.id)) issue(`Duplicate group "${g.id}"`);
      groups.add(g.id);
    }
    for (const p of f.params) {
      if (p.group !== undefined && !groups.has(p.group)) issue(`Parameter "${p.name}" uses unknown group "${p.group}"`);
      if ((p.type === "number" || p.type === "slider") && p.min !== undefined && p.max !== undefined && p.min > p.max) {
        issue(`Parameter "${p.name}": min > max`);
      }
      if ((p.type === "radio" || p.type === "select") && new Set(p.options.map((o) => o.value)).size !== p.options.length) {
        issue(`Parameter "${p.name}": duplicate option values`);
      }
      const err = validateValue(p, p.default);
      if (err) issue(`Parameter "${p.name}": default ${err}`);
    }
  });
export type ParamsForm = z.infer<typeof ParamsForm>;

export const Params = z.object({
  form: ParamsForm,
  values: z.record(z.string(), ParamValue),
});
export type Params = z.infer<typeof Params>;

export const emptyParams = (): Params => ({ form: { params: [], groups: [] }, values: {} });

export const defaults = (form: ParamsForm): Record<string, ParamValue> =>
  Object.fromEntries(form.params.map((p) => [p.name, p.default]));

// Values for a new form: keep a value when name and type match and it's still valid, else default
export function mergeValues(prev: Params, form: ParamsForm): Record<string, ParamValue> {
  const old = new Map(prev.form.params.map((p) => [p.name, p]));
  return Object.fromEntries(
    form.params.map((p) => {
      const v = prev.values[p.name];
      const keep = old.get(p.name)?.type === p.type && v !== undefined && !validateValue(p, v);
      return [p.name, keep ? v : p.default];
    }),
  );
}

// Validates a partial update against the form; returns all problems
export function checkValues(form: ParamsForm, values: Record<string, unknown>): string[] {
  const byName = new Map(form.params.map((p) => [p.name, p]));
  const errs: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const p = byName.get(k);
    if (!p) errs.push(`Unknown parameter "${k}"`);
    else {
      const e = validateValue(p, v);
      if (e) errs.push(`"${k}" ${e}`);
    }
  }
  return errs;
}

// Names whose value differs between two value maps
export function changedNames(a: Record<string, ParamValue>, b: Record<string, ParamValue>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]);
}

// Names read via param("name") string literals
export function paramRefs(source: string): string[] {
  const refs = new Set<string>();
  for (const m of source.matchAll(/\bparam\(\s*["'`]([A-Za-z_][A-Za-z0-9_]{0,63})["'`]\s*\)/g)) refs.add(m[1]);
  return [...refs];
}
