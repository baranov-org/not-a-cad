import type { MeshData, Metrics } from "./types";

// Prebuilt meshes for a share: [u32 headerLen][JSON header][pad to 4][buffers, each 4-byte aligned]
export interface BundlePart {
  name: string;
  key: string;
  metrics: Metrics;
  mesh: MeshData;
}

// Version 2: meshes with face/edge ranges (for measuring)
const VERSION = 2;
const FIELDS = ["positions", "normals", "indices", "edges"] as const;
const RANGES = ["faceRanges", "edgeRanges"] as const;

interface HeaderPart {
  name: string;
  key: string;
  metrics: Metrics;
  buf: Record<(typeof FIELDS)[number], [offset: number, length: number]> & Partial<Record<(typeof RANGES)[number], [number, number]>>;
}

const align = (n: number) => (n + 3) & ~3;

export function encodeBundle(parts: BundlePart[]): Uint8Array {
  let offset = 0;
  const header: HeaderPart[] = parts.map((p) => {
    const buf = {} as HeaderPart["buf"];
    for (const f of FIELDS) {
      buf[f] = [offset, p.mesh[f].length];
      offset += align(p.mesh[f].byteLength);
    }
    for (const f of RANGES) {
      const a = p.mesh[f];
      if (!a) continue;
      buf[f] = [offset, a.length];
      offset += align(a.byteLength);
    }
    return { name: p.name, key: p.key, metrics: p.metrics, buf };
  });
  const head = new TextEncoder().encode(JSON.stringify({ v: VERSION, parts: header }));
  const start = align(4 + head.length);
  const out = new Uint8Array(start + offset);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  parts.forEach((p, i) => {
    for (const f of [...FIELDS, ...RANGES]) {
      const a = p.mesh[f];
      const at = header[i].buf[f];
      if (a && at) out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), start + at[0]);
    }
  });
  return out;
}

export function decodeBundle(data: ArrayBuffer): BundlePart[] {
  const len = new DataView(data).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, len))) as { v: number; parts: HeaderPart[] };
  if (header.v !== VERSION) throw new Error(`Unsupported bundle version ${header.v}`);
  const start = align(4 + len);
  return header.parts.map((h) => {
    const view = <T extends Float32Array | Uint32Array>(C: new (b: ArrayBuffer, o: number, l: number) => T, [o, l]: [number, number]) =>
      new C(data, start + o, l).slice() as T;
    return {
      name: h.name,
      key: h.key,
      metrics: h.metrics,
      mesh: {
        positions: view(Float32Array, h.buf.positions),
        normals: view(Float32Array, h.buf.normals),
        indices: view(Uint32Array, h.buf.indices),
        edges: view(Float32Array, h.buf.edges),
        ...(h.buf.faceRanges ? { faceRanges: view(Uint32Array, h.buf.faceRanges) } : {}),
        ...(h.buf.edgeRanges ? { edgeRanges: view(Uint32Array, h.buf.edgeRanges) } : {}),
      },
    };
  });
}
