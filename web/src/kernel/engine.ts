import * as Comlink from "comlink";
import { changedNames, emptyParams, paramRefs, type Model, type Params, type ParamValue } from "shared";
import type { CachedPart, MeshCache } from "./cache";
import { depsOf, topoOrder, withDependents } from "./graph";
import { computeKeys, hashAvailable, sha256, type Hash } from "./keys";

import type { BuildResult, ExportMesh, InspectItem, InspectResult, KernelApi, MeshData, Metrics, StepItem } from "./types";
import type { Cut, EntityFacts } from "./inspect";

export type PartStatus = "building" | "ok" | "error";

export interface PartInfo {
  name: string;
  source: string;
  status: PartStatus;
  error?: string;
  metrics?: Metrics;
  refs: string[];
  params: string[];
  cached?: boolean;
  // Build timing (ms since epoch / durations in ms)
  startedAt?: number;
  lastMs?: number;
  ms?: number;
}

// One rebuild round, for the status line
export interface BuildRound {
  ms: number;
  built: number;
  cached: number;
  failed: number;
}

export interface EngineEvents {
  onPart(info: PartInfo, mesh?: MeshData): void;
  onRemove(name: string): void;
  onReady(): void;
  onRound?(r: BuildRound): void;
}

export interface EngineOptions {
  timeoutMs?: number;
  maxWorkers?: number;
  cache?: MeshCache;
  hash?: Hash;
}

// One kernel worker; calls fail fast once it is killed
interface Slot {
  worker: Worker;
  kernel: Comlink.Remote<KernelApi>;
  ready: Promise<void>;
  busy: boolean;
  lastUsed: number;
  dead: Promise<never>;
  kill: (reason: string) => void;
}

const IDLE_MS = 60_000;

// Builds parts on a pool of kernel workers in dependency order, with a mesh cache and a per-build watchdog
export class Engine {
  readonly sources = new Map<string, string>();
  readonly infos = new Map<string, PartInfo>();
  params: Params = emptyParams();
  readonly maxWorkers: number;
  readonly timeoutMs: number;
  // Builds started and shapes copied between workers (tests and diagnostics)
  builds = 0;
  transfers = 0;
  // Exact shapes loaded from the cache instead of rebuilt
  brepLoads = 0;
  transferMs = 0;
  // Workers whose cache holds each part's current shape
  private holders = new Map<string, Set<Slot>>();
  private keys = new Map<string, string>();
  // BREPs of built parts that others reference, so dependents never wait on a busy worker
  private breps = new Map<string, string>();
  private slots: Slot[] = [];
  private waiters: (() => void)[] = [];
  private chain: Promise<unknown>;
  private pendingNames = new Set<string>();
  private pendingRun?: Promise<PartInfo[]>;
  private cache?: MeshCache;
  private hash?: Hash;
  // Prebuilt meshes (share bundles), checked before the cache
  private seeded = new Map<string, CachedPart>();
  ready: Promise<void>;

  constructor(
    private events: EngineEvents,
    private makeWorker: () => Worker,
    private wasm: () => Promise<ArrayBuffer>,
    opts: EngineOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxWorkers = Math.max(1, opts.maxWorkers ?? 1);
    this.cache = opts.cache;
    this.hash = opts.hash ?? (hashAvailable() ? sha256 : undefined);
    // One worker up front; more start when there is parallel work
    this.ready = this.spawn().ready.then(() => events.onReady());
    this.chain = this.ready;
    setInterval(() => this.reapIdle(), IDLE_MS / 2);
  }

  get workerCount(): number {
    return this.slots.length;
  }

  private spawn(): Slot {
    const worker = this.makeWorker();
    const kernel = Comlink.wrap<KernelApi>(worker);
    let kill!: (reason: string) => void;
    const dead = new Promise<never>((_, rej) => (kill = (r) => rej(new Error(r))));
    dead.catch(() => undefined);
    const slot: Slot = {
      worker, kernel, busy: false, lastUsed: Date.now(), dead, kill,
      ready: this.wasm().then((w) => kernel.init(Comlink.transfer(w, [w]))),
    };
    this.slots.push(slot);
    return slot;
  }

  // Call into a worker, failing if it gets killed meanwhile
  private call<T>(slot: Slot, fn: () => Promise<T>): Promise<T> {
    return Promise.race([slot.ready.then(fn), slot.dead]);
  }

  private killSlot(slot: Slot, reason: string) {
    slot.kill(reason);
    slot.worker.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
    for (const set of this.holders.values()) set.delete(slot);
    this.wake();
  }

  private reapIdle() {
    const now = Date.now();
    for (const s of [...this.slots]) {
      if (this.slots.length > 1 && !s.busy && now - s.lastUsed > IDLE_MS) this.killSlot(s, "idle");
    }
  }

  private wake() {
    this.waiters.splice(0).forEach((f) => f());
  }

  // Take an idle worker, preferring one that already holds the given parts
  private async acquire(prefer: string[]): Promise<Slot> {
    for (;;) {
      const idle = this.slots.filter((s) => !s.busy);
      if (idle.length) {
        const score = (s: Slot) => prefer.filter((p) => this.holders.get(p)?.has(s)).length;
        const slot = idle.sort((a, b) => score(b) - score(a))[0];
        slot.busy = true;
        return slot;
      }
      if (this.slots.length < this.maxWorkers) {
        const slot = this.spawn();
        slot.busy = true;
        return slot;
      }
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  private release(slot: Slot) {
    slot.busy = false;
    slot.lastUsed = Date.now();
    this.wake();
  }

  // Serialise all engine operations
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  load(model: Model): Promise<void> {
    return this.run(async () => {
      for (const n of this.sources.keys()) this.events.onRemove(n);
      this.forget([...this.sources.keys()]);
      this.sources.clear();
      this.infos.clear();
      for (const [n, s] of Object.entries(model.parts)) this.sources.set(n, s);
      this.params = model.params;
      await this.rebuild(this.sources.keys());
    });
  }

  setPart(name: string, source: string): Promise<PartInfo> {
    return this.run(async () => {
      this.sources.set(name, source);
      await this.rebuild([name]);
      return this.infos.get(name)!;
    });
  }

  // Replace form and values; rebuild parts whose values changed. Returns affected parts.
  setParams(params: Params): Promise<PartInfo[]> {
    const changed = changedNames(this.params.values, params.values);
    this.params = params;
    return this.queueValueRebuild(changed);
  }

  // Merge values (already validated); rebuilds coalesce while a build is running
  setValues(values: Record<string, ParamValue>): Promise<PartInfo[]> {
    const changed = changedNames(this.params.values, { ...this.params.values, ...values });
    this.params = { ...this.params, values: { ...this.params.values, ...values } };
    return this.queueValueRebuild(changed);
  }

  private queueValueRebuild(names: string[]): Promise<PartInfo[]> {
    for (const n of names) this.pendingNames.add(n);
    this.pendingRun ??= this.run(async () => {
      this.pendingRun = undefined;
      const changed = new Set(this.pendingNames);
      this.pendingNames.clear();
      const roots = [...this.sources].filter(([, src]) => paramRefs(src).some((r) => changed.has(r))).map(([n]) => n);
      const affected = withDependents(depsOf(this.sources), roots);
      if (affected.size) await this.rebuild(roots);
      return [...affected].map((n) => this.infos.get(n)!).filter(Boolean);
    });
    return this.pendingRun;
  }

  // Resolves when queued work is done
  idle(): Promise<void> {
    return this.run(async () => {});
  }

  deletePart(name: string): Promise<void> {
    return this.run(async () => {
      this.sources.delete(name);
      this.infos.delete(name);
      this.keys.delete(name);
      this.forget([name]);
      this.events.onRemove(name);
    });
  }

  // Prebuilt meshes by content key; used only where keys match this engine's own
  seed(parts: { key: string; mesh: MeshData; metrics: Metrics }[]) {
    for (const p of parts) this.seeded.set(p.key, { mesh: p.mesh, metrics: p.metrics });
  }

  // Content key of a part as of the last rebuild
  partKey(name: string): string | undefined {
    return this.keys.get(name);
  }

  // Drop stale shapes from the workers holding them
  private forget(names: string[]) {
    for (const n of names) {
      for (const s of this.holders.get(n) ?? []) void this.call(s, () => s.kernel.drop(n)).catch(() => undefined);
      this.holders.delete(n);
      this.breps.delete(n);
    }
  }

  // Last build duration per part; persisted by the app per project
  private lastMs = new Map<string, number>();
  private saveTimings?: (t: Record<string, number>) => void;

  setTimings(t: Record<string, number>, save?: (t: Record<string, number>) => void) {
    this.lastMs = new Map(Object.entries(t));
    this.saveTimings = save;
  }

  private set(info: PartInfo, mesh?: MeshData) {
    const prev = this.infos.get(info.name);
    if (info.status === "building") {
      info.startedAt = Date.now();
      info.lastMs = this.lastMs.get(info.name);
    } else if (info.status === "ok" && !info.cached && prev?.startedAt) {
      info.ms = Date.now() - prev.startedAt;
      this.lastMs.set(info.name, info.ms);
      this.saveTimings?.(Object.fromEntries(this.lastMs));
    }
    this.infos.set(info.name, info);
    this.events.onPart(info, mesh);
  }

  private async rebuild(changed: Iterable<string>): Promise<void> {
    const t0 = Date.now();
    const deps = depsOf(this.sources);
    const affected = withDependents(deps, changed);
    const { order, cyclic } = topoOrder(deps);
    const base = (n: string) => ({ name: n, source: this.sources.get(n)!, refs: deps.get(n)!, params: paramRefs(this.sources.get(n)!) });

    this.forget([...affected]);
    for (const n of affected) this.set({ ...base(n), status: "building" });
    for (const n of cyclic) {
      if (affected.has(n)) this.set({ ...base(n), status: "error", error: `Reference cycle involving: ${cyclic.join(", ")}` });
    }

    const keys = this.hash
      ? await computeKeys(order, this.sources, deps, this.params.values, this.hash).catch(() => new Map<string, string>())
      : new Map<string, string>();
    this.keys = keys;

    // One job per affected part; jobs await their dependencies and the pool limits concurrency
    const jobs = new Map<string, Promise<boolean>>();
    const job = (n: string): Promise<boolean> => {
      let p = jobs.get(n);
      if (!p) jobs.set(n, (p = this.buildJob(n, deps, affected, job, base)));
      return p;
    };
    await Promise.all(order.filter((n) => affected.has(n)).map(job));
    const done = [...affected].map((n) => this.infos.get(n)).filter((i): i is PartInfo => !!i);
    if (done.length) {
      this.events.onRound?.({
        ms: Date.now() - t0,
        built: done.filter((i) => i.status === "ok" && !i.cached).length,
        cached: done.filter((i) => i.cached).length,
        failed: done.filter((i) => i.status === "error").length,
      });
    }
  }

  private async buildJob(
    n: string,
    deps: Map<string, string[]>,
    affected: Set<string>,
    job: (n: string) => Promise<boolean>,
    base: (n: string) => Omit<PartInfo, "status">,
  ): Promise<boolean> {
    const ds = deps.get(n)!;
    const missing = ds.find((d) => !this.sources.has(d));
    if (missing) {
      this.set({ ...base(n), status: "error", error: `Unknown part "${missing}"` });
      return false;
    }
    const oks = await Promise.all(ds.map((d) => (affected.has(d) ? job(d) : Promise.resolve(this.infos.get(d)?.status === "ok"))));
    const failed = ds.find((_, i) => !oks[i]);
    if (failed) {
      this.set({ ...base(n), status: "error", error: `Dependency "${failed}" failed` });
      return false;
    }

    const key = this.keys.get(n);
    const seeded = key ? this.seeded.get(key) : undefined;
    if (seeded && key) void this.cache?.put(key, seeded);
    const hit = seeded ?? (key && this.cache ? await this.cache.get(key) : undefined);
    if (hit) {
      this.set({ ...base(n), status: "ok", metrics: hit.metrics, cached: true }, hit.mesh);
      return true;
    }

    const slot = await this.acquire(ds);
    try {
      await this.ensureShapes(slot, ds, deps);
      const r = await this.buildOn(slot, n, true);
      if (!r.ok) {
        this.set({ ...base(n), status: "error", error: r.error });
        return false;
      }
      this.set({ ...base(n), status: "ok", metrics: r.metrics }, r.mesh);
      if (key && this.cache && r.mesh && r.metrics) void this.cache.put(key, { mesh: r.mesh, metrics: r.metrics });
      this.saveBrep(slot, n);
      // Export now while we hold this worker; dependents load it without waiting
      if ([...affected].some((m) => deps.get(m)?.includes(n))) {
        const brep = await this.call(slot, () => slot.kernel.serialize(n)).catch(() => undefined);
        if (brep !== undefined) this.breps.set(n, brep);
      }
      return true;
    } catch (e) {
      this.set({ ...base(n), status: "error", error: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      this.release(slot);
    }
  }

  // STEP needs B-rep shapes; parts shown from cache get them built on demand
  exportStep(items: StepItem[]): Promise<Uint8Array> {
    return this.run(async () => {
      const parts = [...new Set(items.map((i) => i.part))];
      const bad = parts.find((p) => this.infos.get(p)?.status !== "ok");
      if (bad) throw new Error(`Part "${bad}" has no valid geometry`);
      const slot = await this.acquire(parts);
      try {
        await this.ensureShapes(slot, parts, depsOf(this.sources));
        return await this.call(slot, () => slot.kernel.exportStep(items));
      } finally {
        this.release(slot);
      }
    });
  }

  // Mesh export: re-mesh each part from its exact shape (built on demand for parts shown from cache)
  exportMeshes(parts: string[], tol: (part: string) => { tolerance: number; angularTolerance: number }): Promise<Map<string, ExportMesh>> {
    return this.run(async () => {
      const bad = parts.find((p) => this.infos.get(p)?.status !== "ok");
      if (bad) throw new Error(`Part "${bad}" has no valid geometry`);
      const slot = await this.acquire(parts);
      try {
        await this.ensureShapes(slot, parts, depsOf(this.sources));
        const out = new Map<string, ExportMesh>();
        for (const p of parts) {
          const { tolerance, angularTolerance } = tol(p);
          out.set(p, await this.call(slot, () => slot.kernel.exportMesh(p, tolerance, angularTolerance)));
        }
        return out;
      } finally {
        this.release(slot);
      }
    });
  }

  // Exact measurements; parts shown from cache get their shapes built first
  inspect(items: InspectItem[], cuts?: Cut[]): Promise<InspectResult> {
    return this.withShapes([...new Set(items.map((i) => i.part))], (slot) => slot.kernel.inspect(items, cuts));
  }

  // Parts shown from cache have no shapes: build them ahead of measuring; resolves when all are ready
  warmShapes(parts: string[]): Promise<void> {
    const todo = parts.filter((p) => this.infos.get(p)?.status === "ok" && !this.holders.get(p)?.size);
    return Promise.all(todo.map((p) => this.withShapes([p], () => undefined).catch(() => undefined))).then(() => undefined);
  }

  inspectAll(part: string): Promise<{ faces: EntityFacts[]; edges: EntityFacts[] }> {
    return this.withShapes([part], (slot) => slot.kernel.inspectAll(part));
  }

  private withShapes<T>(parts: string[], fn: (slot: Slot) => Promise<T> | T): Promise<T> {
    return this.run(async () => {
      const bad = parts.find((p) => this.infos.get(p)?.status !== "ok");
      if (bad) throw new Error(this.infos.has(bad) ? `Part "${bad}" failed to build, so it can't be measured` : `Unknown part "${bad}"`);
      const slot = await this.acquire(parts);
      try {
        await this.ensureShapes(slot, parts, depsOf(this.sources));
        return await this.call(slot, async () => fn(slot));
      } finally {
        this.release(slot);
      }
    });
  }

  // Debug/test: volume of a STEP file re-imported into the kernel
  stepVolume(bytes: Uint8Array): Promise<number> {
    return this.run(async () => {
      const slot = await this.acquire([]);
      try {
        return await this.call(slot, () => slot.kernel.stepVolume(bytes));
      } finally {
        this.release(slot);
      }
    });
  }

  // Make parts' shapes available in this worker: copy from another worker, or build them here
  private async ensureShapes(slot: Slot, names: string[], deps: Map<string, string[]>): Promise<void> {
    for (const d of names) {
      const held = this.holders.get(d);
      if (held?.has(slot)) continue;
      const from = held && [...held][0];
      if (from || this.breps.has(d)) {
        const t = performance.now();
        const brep = this.breps.get(d) ?? (await this.call(from!, () => from!.kernel.serialize(d)).catch(() => undefined));
        if (brep !== undefined) {
          await this.call(slot, () => slot.kernel.load(d, brep));
          this.hold(d, slot);
          this.transfers++;
          this.transferMs += performance.now() - t;
          continue;
        }
      }
      // No holder (shown from cache, or its worker was killed): the cached exact shape, else build it here
      const key = this.keys.get(d);
      const cached = key && (await this.cache?.getBrep?.(key));
      if (cached) {
        await this.call(slot, () => slot.kernel.load(d, cached));
        this.hold(d, slot);
        this.brepLoads++;
        continue;
      }
      await this.ensureShapes(slot, deps.get(d) ?? [], deps);
      const r = await this.buildOn(slot, d, false);
      if (!r.ok) throw new Error(`Dependency "${d}" failed: ${r.error}`);
      this.saveBrep(slot, d);
    }
  }

  // Keeps a built part's exact shape in the cache once it has settled (not on every slider step); best effort
  private saveBrep(slot: Slot, name: string) {
    const key = this.keys.get(name);
    if (!key || !this.cache?.putBrep) return;
    setTimeout(() => {
      if (this.keys.get(name) !== key || !this.holders.get(name)?.has(slot)) return;
      void this.call(slot, () => slot.kernel.serialize(name))
        .then((brep) => {
          if (brep !== undefined && this.keys.get(name) === key) return this.cache!.putBrep!(key, brep);
        })
        .catch(() => undefined);
    }, 2000);
  }

  private hold(name: string, slot: Slot) {
    let set = this.holders.get(name);
    if (!set) this.holders.set(name, (set = new Set()));
    set.add(slot);
  }

  // Build on one worker; a timeout kills that worker only
  private async buildOn(slot: Slot, name: string, withMesh: boolean): Promise<BuildResult> {
    this.builds++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((res) => (timer = setTimeout(() => res("timeout"), this.timeoutMs)));
    try {
      const r = await Promise.race([
        this.call<BuildResult>(slot, () => slot.kernel.build(name, this.sources.get(name)!, this.params.values, withMesh)),
        timeout,
      ]);
      if (r === "timeout") {
        this.killSlot(slot, "timeout");
        return { ok: false, error: `Build timed out after ${this.timeoutMs / 1000}s` };
      }
      if (r.ok) this.hold(name, slot);
      return r;
    } finally {
      clearTimeout(timer);
    }
  }
}
