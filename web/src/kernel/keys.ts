import { paramRefs, type ParamValue } from "shared";

// Bump to invalidate every cached mesh
export const CACHE_EPOCH = 3;
// Preview meshing: linear mm, angular rad (exports re-mesh tighter, see export/run.ts)
export const MESH_TOL = { tolerance: 0.1, angularTolerance: 0.25 };
// Kernel package versions are injected by vite.config.ts
export const KERNEL_VERSION = `${typeof __KERNEL_VERSION__ === "string" ? __KERNEL_VERSION__ : "dev"}/${CACHE_EPOCH}`;

export type Hash = (s: string) => Promise<string>;

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// SHA-256 needs a secure context (https or localhost)
export const hashAvailable = () => typeof crypto !== "undefined" && !!crypto.subtle;

const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

// Content keys in topological order; a part without a key (or with a keyless dependency) gets none
export async function computeKeys(
  order: string[],
  sources: Map<string, string>,
  deps: Map<string, string[]>,
  values: Record<string, ParamValue>,
  hash: Hash,
  version = KERNEL_VERSION,
): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  for (const n of order) {
    const src = sources.get(n)!;
    const depKeys: Record<string, string> = {};
    let ok = true;
    for (const d of deps.get(n) ?? []) {
      const k = keys.get(d);
      if (!k) ok = false;
      else depKeys[d] = k;
    }
    if (!ok) continue;
    const read: Record<string, ParamValue | null> = {};
    for (const p of paramRefs(src)) read[p] = values[p] ?? null;
    keys.set(n, await hash(JSON.stringify([version, MESH_TOL, src, sorted(read), sorted(depKeys)])));
  }
  return keys;
}
