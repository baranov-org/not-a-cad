import type { Instance } from "shared";

export type Format = "stl" | "3mf" | "step" | "obj";
export const FORMATS: { id: Format; label: string; note: string }[] = [
  { id: "stl", label: "STL", note: "Mesh, any slicer" },
  { id: "3mf", label: "3MF", note: "Parts and colours" },
  { id: "step", label: "STEP", note: "Exact geometry" },
  { id: "obj", label: "OBJ", note: "Mesh with objects" },
];

export interface Include {
  parts: boolean; // one file per unique part, resting on Z = 0
  assembled: boolean; // instances in place, one file
}

export interface PlannedFile {
  name: string;
  kind: "part" | "assembly";
  // part files: the part; assembly: every instance
  part?: string;
  rest?: boolean;
}

export interface ExportPlan {
  files: PlannedFile[];
  // What downloads: the single file, or a ZIP of all files
  download: string;
  zip: boolean;
  // Failed parts left out
  skipped: string[];
}

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n",
  о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};
export const SLUG_MAX = 60;

// File-name slug: lowercase ASCII letters, digits and hyphens, at most `max` characters, cut at a word boundary
export function slugify(name: string | undefined, max = SLUG_MAX): string {
  const s = (name ?? "")
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => CYRILLIC[c] ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf("-");
  return (at > max / 2 ? cut.slice(0, at) : s.slice(0, max)).replace(/-+$/, "");
}

// Files an export produces; shared by the dialog preview, the download and the agent tool.
// Names come from the model name (slug), falling back to "assembly" and the part name.
export function planExport(
  req: { part?: string; format: Format; include: Include },
  model: { instances: Instance[]; ok: (part: string) => boolean; title?: string },
): ExportPlan {
  const ext = req.format;
  const base = slugify(model.title);
  if (req.part) {
    const ok = model.ok(req.part);
    const files = ok ? [{ name: `${base ? `${base}-` : ""}${req.part}.${ext}`, kind: "part" as const, part: req.part }] : [];
    return { files, download: files[0]?.name ?? "", zip: false, skipped: ok ? [] : [req.part] };
  }
  const unique = [...new Set(model.instances.map((i) => i.part))];
  const good = unique.filter(model.ok);
  const skipped = unique.filter((p) => !model.ok(p));
  const files: PlannedFile[] = [];
  const asm = base || "assembly";
  if (good.length && req.include.assembled) files.push({ name: `${asm}.${ext}`, kind: "assembly" });
  if (req.include.parts) for (const p of good) files.push({ name: `parts/${p}.${ext}`, kind: "part", part: p, rest: true });
  const zip = files.length > 1;
  return { files, download: zip ? `${asm}.zip` : (files[0]?.name.replace(/^parts\//, "") ?? ""), zip, skipped };
}

export type Bounds = { min: [number, number, number]; max: [number, number, number] };

// "Ready to print": rest on Z = 0, centred on the origin in X and Y
export const restOffset = (b: Bounds): [number, number, number] => [
  -(b.min[0] + b.max[0]) / 2,
  -(b.min[1] + b.max[1]) / 2,
  -b.min[2],
];

// Object names in exported files: "gear", "gear #2" when placed more than once in the same group,
// prefixed by the group path ("Left leg / Knee / shin")
export function instanceNames(instances: { part: string; label?: string; path?: string[] }[]): string[] {
  const where = (i: (typeof instances)[number]) => `${(i.path ?? []).join("/")}|${i.label ?? i.part}`;
  const counts: Record<string, number> = {};
  for (const i of instances) counts[where(i)] = (counts[where(i)] ?? 0) + 1;
  const seen: Record<string, number> = {};
  return instances.map((i) => {
    const w = where(i);
    seen[w] = (seen[w] ?? 0) + 1;
    const base = i.label ?? i.part;
    return [...(i.path ?? []), counts[w] > 1 ? `${base} #${seen[w]}` : base].join(" / ");
  });
}

export type Quality = "draft" | "normal" | "fine";

// Export tolerances scale with the part's size (bounding-box diagonal): normal ≈ 1/10,000 of it, fine twice as tight
export function exportTolerance(diag: number, quality: Exclude<Quality, "draft">) {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return quality === "fine"
    ? { tolerance: clamp(diag * 5e-5, 0.001, 0.025), angularTolerance: 0.07 }
    : { tolerance: clamp(diag * 1e-4, 0.002, 0.05), angularTolerance: 0.1 };
}
