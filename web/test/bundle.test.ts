import { describe, expect, it } from "vitest";
import { decodeBundle, encodeBundle, type BundlePart } from "../src/kernel/bundle";

const part = (name: string, n: number): BundlePart => ({
  name,
  key: `k-${name}`,
  metrics: { bbox: { min: [0, 0, 0], max: [n, n, n] }, volume: n * 10, faces: n, edges: n * 2 },
  mesh: {
    positions: Float32Array.from({ length: n * 3 }, (_, i) => i + 0.5),
    normals: Float32Array.from({ length: n * 3 }, (_, i) => -i),
    indices: Uint32Array.from({ length: n }, (_, i) => i),
    edges: Float32Array.from({ length: 6 }, (_, i) => i * 1.25),
  },
});

describe("mesh bundle", () => {
  it("round-trips parts with odd sizes and unicode names", () => {
    const parts = [part("a", 1), part("ширина", 7), part("c", 0)];
    const bytes = encodeBundle(parts);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const back = decodeBundle(copy);
    expect(back.map((p) => p.name)).toEqual(["a", "ширина", "c"]);
    for (let i = 0; i < parts.length; i++) {
      expect(back[i].key).toBe(parts[i].key);
      expect(back[i].metrics).toEqual(parts[i].metrics);
      expect([...back[i].mesh.positions]).toEqual([...parts[i].mesh.positions]);
      expect([...back[i].mesh.normals]).toEqual([...parts[i].mesh.normals]);
      expect([...back[i].mesh.indices]).toEqual([...parts[i].mesh.indices]);
      expect([...back[i].mesh.edges]).toEqual([...parts[i].mesh.edges]);
    }
  });

  it("v2 carries face/edge ranges; parts without them still encode", () => {
    const withRanges = { ...part("r", 4), mesh: { ...part("r", 4).mesh, faceRanges: Uint32Array.from([0, 3, 3, 1]), edgeRanges: Uint32Array.from([0, 2]) } };
    const bytes = encodeBundle([withRanges, part("plain", 2)]);
    const back = decodeBundle(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect([...back[0].mesh.faceRanges!]).toEqual([0, 3, 3, 1]);
    expect([...back[0].mesh.edgeRanges!]).toEqual([0, 2]);
    expect(back[1].mesh.faceRanges).toBeUndefined();
  });

  it("rejects other versions, including v1", () => {
    for (const v of [1, 99]) {
      const head = new TextEncoder().encode(JSON.stringify({ v, parts: [] }));
      const buf = new Uint8Array(4 + head.length);
      new DataView(buf.buffer).setUint32(0, head.length, true);
      buf.set(head, 4);
      expect(() => decodeBundle(buf.buffer)).toThrow(/version/);
    }
  });
});
