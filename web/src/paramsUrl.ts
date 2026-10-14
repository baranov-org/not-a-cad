import { validateValue, type Param, type ParamsForm, type ParamValue } from "shared";

// Share links carry the visitor's edits in the hash: only values that differ from the published ones,
// "name=value" joined by "&"; checkboxes as 1/0

const enc = (p: Param, v: ParamValue) => (p.type === "checkbox" ? (v ? "1" : "0") : String(v));

export function encodeParams(form: ParamsForm, published: Record<string, ParamValue>, values: Record<string, ParamValue>): string {
  return form.params
    .filter((p) => p.name in values && values[p.name] !== (published[p.name] ?? p.default))
    .map((p) => `${p.name}=${encodeURIComponent(enc(p, values[p.name]))}`)
    .join("&");
}

function dec(p: Param, raw: string): ParamValue | undefined {
  switch (p.type) {
    case "number":
    case "slider":
      return raw.trim() === "" ? undefined : Number(raw);
    case "checkbox":
      return raw === "1" || raw === "true" ? true : raw === "0" || raw === "false" ? false : undefined;
    case "radio":
    case "select":
      return p.options.find((o) => String(o.value) === raw)?.value;
    case "text":
      return raw;
  }
}

// Valid values from a hash ("#a=1&b=0"); unknown names and invalid values are ignored
export function decodeParams(form: ParamsForm, hash: string): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  const byName = new Map(form.params.map((p) => [p.name, p]));
  for (const part of hash.replace(/^#/, "").split("&")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const p = byName.get(part.slice(0, i));
    if (!p) continue;
    let raw: string;
    try {
      raw = decodeURIComponent(part.slice(i + 1));
    } catch {
      continue;
    }
    const v = dec(p, raw);
    if (v !== undefined && !validateValue(p, v)) out[p.name] = v;
  }
  return out;
}
