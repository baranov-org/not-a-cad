import type { MeshData, Metrics } from "./types";

export interface CachedPart {
  mesh: MeshData;
  metrics: Metrics;
}

export interface MeshCache {
  get(key: string): Promise<CachedPart | undefined>;
  put(key: string, v: CachedPart): Promise<void>;
  // Exact shape (BREP text) of a part, so measuring and exports skip the rebuild
  getBrep?(key: string): Promise<string | undefined>;
  putBrep?(key: string, brep: string): Promise<void>;
}

const DB = "cad-cache";
const STORE = "parts";
const BREPS = "breps";
const BUDGET = 200 * 1024 * 1024;

// BREP text is large and repetitive: stored gzipped
const pipe = async (data: BufferSource, t: CompressionStream | DecompressionStream) =>
  new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(t)).arrayBuffer());
const gzip = (text: string) => pipe(new TextEncoder().encode(text), new CompressionStream("gzip"));
const gunzip = async (bytes: Uint8Array) => new TextDecoder().decode(await pipe(bytes as Uint8Array<ArrayBuffer>, new DecompressionStream("gzip")));

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

const sizeOf = (m: MeshData) => m.positions.byteLength + m.normals.byteLength + m.indices.byteLength + m.edges.byteLength;

// Mesh cache in IndexedDB keyed by content key; every failure is a miss
export function idbCache(): MeshCache | undefined {
  if (typeof indexedDB === "undefined") return;
  let db: Promise<IDBDatabase> | undefined;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(DB, 2);
      r.onupgradeneeded = (e) => {
        if (e.oldVersion < 1) r.result.createObjectStore(STORE, { keyPath: "key" }).createIndex("at", "at");
        if (e.oldVersion < 2) r.result.createObjectStore(BREPS, { keyPath: "key" }).createIndex("at", "at");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  let writes = 0;

  // Drop oldest entries until under budget
  const evict = async (name = STORE) => {
    const store = (await open()).transaction(name, "readwrite").objectStore(name);
    const all = (await req(store.index("at").getAll())) as { key: string; size: number }[];
    let total = all.reduce((s, e) => s + e.size, 0);
    for (const e of all) {
      if (total <= BUDGET) break;
      store.delete(e.key);
      total -= e.size;
    }
  };

  return {
    async get(key) {
      try {
        const store = (await open()).transaction(STORE, "readonly").objectStore(STORE);
        const e = (await req(store.get(key))) as ({ mesh: MeshData; metrics: Metrics } | undefined);
        return e && { mesh: e.mesh, metrics: e.metrics };
      } catch {
        return undefined;
      }
    },
    async put(key, v) {
      try {
        const store = (await open()).transaction(STORE, "readwrite").objectStore(STORE);
        await req(store.put({ key, at: Date.now(), size: sizeOf(v.mesh), mesh: v.mesh, metrics: v.metrics }));
        if (++writes % 20 === 0) await evict();
      } catch {
        // cache is best effort
      }
    },
    async getBrep(key) {
      try {
        const store = (await open()).transaction(BREPS, "readonly").objectStore(BREPS);
        const e = (await req(store.get(key))) as { gz: Uint8Array } | undefined;
        return e && (await gunzip(e.gz));
      } catch {
        return undefined;
      }
    },
    async putBrep(key, brep) {
      try {
        const gz = await gzip(brep);
        const store = (await open()).transaction(BREPS, "readwrite").objectStore(BREPS);
        await req(store.put({ key, at: Date.now(), size: gz.byteLength, gz }));
        if (++writes % 20 === 0) await evict(BREPS);
      } catch {
        // cache is best effort
      }
    },
  };
}
