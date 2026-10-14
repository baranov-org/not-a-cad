import { encodeBundle, type BundlePart } from "./kernel/bundle";
import { engine } from "./runtime";
import { edgeGeometries, geometries } from "./scene";

// Bundle of the meshes currently shown, keyed by content key
export function currentBundle(): Uint8Array | undefined {
  const parts: BundlePart[] = [];
  for (const [name, info] of engine.infos) {
    const key = engine.partKey(name);
    const g = geometries.get(name);
    if (info.status !== "ok" || !key || !g?.index || !info.metrics) continue;
    parts.push({
      name,
      key,
      metrics: info.metrics,
      mesh: {
        positions: g.getAttribute("position").array as Float32Array,
        normals: g.getAttribute("normal").array as Float32Array,
        indices: g.index.array as Uint32Array,
        edges: (edgeGeometries.get(name)?.getAttribute("position")?.array as Float32Array) ?? new Float32Array(),
        faceRanges: g.userData.faceRanges as Uint32Array | undefined,
        edgeRanges: edgeGeometries.get(name)?.userData.edgeRanges as Uint32Array | undefined,
      },
    });
  }
  return parts.length ? encodeBundle(parts) : undefined;
}
