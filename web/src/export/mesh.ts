import { zipSync, strToU8 } from "fflate";

export interface MeshData {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

// Column-major 4×4 (three.js Matrix4.elements); undefined = identity
export type Mat4 = ArrayLike<number> | undefined;

export interface MeshObject {
  name: string;
  mesh: MeshData;
  matrix?: Mat4;
  color?: string;
}

const apply = (m: Mat4, x: number, y: number, z: number): [number, number, number] =>
  m ? [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]] : [x, y, z];

export const triangles = (objs: MeshObject[]) => objs.reduce((t, o) => t + o.mesh.indices.length / 3, 0);

// Binary STL of all objects merged into one mesh
export function writeStl(objs: MeshObject[]): Uint8Array {
  const n = triangles(objs);
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let off = 84;
  for (const o of objs) {
    const p = o.mesh.positions;
    const idx = o.mesh.indices;
    const v = (i: number) => apply(o.matrix, p[3 * i], p[3 * i + 1], p[3 * i + 2]);
    for (let t = 0; t < idx.length; t += 3) {
      const a = v(idx[t]), b = v(idx[t + 1]), c = v(idx[t + 2]);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const [k, val] of [nx, ny, nz, ...a, ...b, ...c].entries()) dv.setFloat32(off + k * 4, val, true);
      off += 50;
    }
  }
  return new Uint8Array(buf);
}

const fmt = (x: number) => String(Math.round(x * 1e6) / 1e6);

// Wavefront OBJ: one `o` per object, vertices transformed
export function writeObj(objs: MeshObject[]): Uint8Array {
  const out: string[] = ["# not-a-cad export (mm)"];
  let base = 1;
  for (const o of objs) {
    out.push(`o ${o.name.replace(/\s+/g, "_")}`);
    const p = o.mesh.positions;
    const count = p.length / 3;
    for (let i = 0; i < count; i++) out.push(`v ${apply(o.matrix, p[3 * i], p[3 * i + 1], p[3 * i + 2]).map(fmt).join(" ")}`);
    const idx = o.mesh.indices;
    for (let t = 0; t < idx.length; t += 3) out.push(`f ${idx[t] + base} ${idx[t + 1] + base} ${idx[t + 2] + base}`);
    base += count;
  }
  return strToU8(out.join("\n") + "\n");
}

// Merges vertices at the same position, so faces share edges (closed, manifold meshes for slicers)
export function weld(mesh: MeshData): MeshData {
  const p = mesh.positions;
  const map = new Map<string, number>();
  const remap = new Uint32Array(p.length / 3);
  const out: number[] = [];
  for (let i = 0; i < p.length / 3; i++) {
    const key = `${Math.round(p[3 * i] * 1e5)},${Math.round(p[3 * i + 1] * 1e5)},${Math.round(p[3 * i + 2] * 1e5)}`;
    let j = map.get(key);
    if (j === undefined) {
      j = out.length / 3;
      map.set(key, j);
      out.push(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
    }
    remap[i] = j;
  }
  const idx: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = remap[mesh.indices[t]], b = remap[mesh.indices[t + 1]], c = remap[mesh.indices[t + 2]];
    // Drop triangles that collapse when welded
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(idx) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
// 3MF transforms are row-major 3×4: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32
const transform3mf = (m: Mat4) =>
  m ? [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]].map(fmt).join(" ") : undefined;
const hex = (c?: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? `${c.toUpperCase()}FF` : "#8FA8C8FF");

export interface Item3mf {
  object: number; // index into objects
  matrix?: Mat4;
  // Instance name (group path), as the item's part number
  name?: string;
}

// 3MF package: one <object> per unique mesh, one <item> per placement, colours via basematerials
export function write3mf(objects: MeshObject[], items: Item3mf[]): Uint8Array {
  const colors = [...new Set(objects.map((o) => hex(o.color)))];
  const xml: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
    `<metadata name="Application">not-a-cad</metadata>`,
    `<resources>`,
    `<basematerials id="1">${colors.map((c) => `<base name="${c}" displaycolor="${c}"/>`).join("")}</basematerials>`,
  ];
  objects.forEach((o, i) => {
    const { positions: p, indices: idx } = weld(o.mesh);
    const v: string[] = [];
    for (let k = 0; k < p.length; k += 3) {
      const [x, y, z] = apply(o.matrix, p[k], p[k + 1], p[k + 2]);
      v.push(`<vertex x="${fmt(x)}" y="${fmt(y)}" z="${fmt(z)}"/>`);
    }
    const t: string[] = [];
    for (let k = 0; k < idx.length; k += 3) t.push(`<triangle v1="${idx[k]}" v2="${idx[k + 1]}" v3="${idx[k + 2]}"/>`);
    xml.push(`<object id="${i + 2}" name="${esc(o.name)}" type="model" pid="1" pindex="${colors.indexOf(hex(o.color))}"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>`);
  });
  xml.push(`</resources>`, `<build>`);
  for (const it of items) {
    const tr = transform3mf(it.matrix);
    xml.push(`<item objectid="${it.object + 2}"${tr ? ` transform="${tr}"` : ""}${it.name ? ` partnumber="${esc(it.name)}"` : ""}/>`);
  }
  xml.push(`</build>`, `</model>`);
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`),
    "3D/3dmodel.model": strToU8(xml.join("\n")),
  }, { level: 6 });
}
