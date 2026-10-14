import * as Comlink from "comlink";
import { assemblyNodes, evaluate, jointWarnings, paramRefs, type Assembly, type AssemblyNode, type Params, type Placed } from "shared";
import { log } from "./console";
import type { AssemblyApi } from "./kernel/assemblyWorker";
import { engine } from "./runtime";
import { setView, useStore } from "./state";

// Evaluates the assembly source (flat list, static tree or script) into placed instances; scripts run in a worker

const TIMEOUT_MS = 5000;
let worker: Worker | undefined;
let api: Comlink.Remote<AssemblyApi> | undefined;

function remote() {
  if (!api) {
    worker = new Worker(new URL("./kernel/assemblyWorker.ts", import.meta.url), { type: "module" });
    api = Comlink.wrap<AssemblyApi>(worker);
  }
  return api;
}

async function runScript(source: string, params: Params): Promise<AssemblyNode[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), TIMEOUT_MS)));
  try {
    const r = await Promise.race([remote().run(source, params.values), timeout]);
    if (r === "timeout") {
      worker?.terminate();
      worker = api = undefined;
      throw new Error(`Assembly script timed out after ${TIMEOUT_MS / 1000} s`);
    }
    if (!r.ok) throw new Error(r.error);
    return r.nodes;
  } finally {
    clearTimeout(timer);
  }
}

export interface Evaluated {
  instances: Placed[];
  warnings: string[];
}

// known: parts that must exist (omitted while a model is still loading)
export async function evaluateSource(src: Assembly, params: Params, known?: Set<string>): Promise<Evaluated> {
  const nodes = src.script !== undefined ? await runScript(src.script, params) : assemblyNodes(src)!;
  const instances = evaluate(nodes);
  if (known) {
    const unknown = [...new Set(instances.map((i) => i.part).filter((p) => !known.has(p)))];
    if (unknown.length === 1) throw new Error(`Unknown part "${unknown[0]}"`);
    if (unknown.length) throw new Error(`Unknown parts: ${unknown.join(", ")}`);
  }
  return { instances, warnings: jointWarnings(nodes, params.form) };
}

// Newest source wins over evaluations still in flight
let token = 0;

function commit(t: number, r: Evaluated) {
  if (t === token) useStore.setState({ assembly: { instances: r.instances }, assemblyError: undefined });
}

function fail(t: number, e: unknown) {
  if (t !== token) return;
  const msg = e instanceof Error ? e.message : String(e);
  if (useStore.getState().assemblyError === msg) return;
  useStore.setState({ assemblyError: msg });
  log({
    kind: "build", level: "error", text: "Assembly failed", detail: msg.split("\n")[0],
    action: { label: "Details", run: () => setView({ kind: "assembly" }), until: () => !!useStore.getState().assemblyError },
  });
}

// New source from a loaded model (restore, share): keeps the last good evaluation on failure
export function setAssemblySource(src: Assembly, params: Params) {
  const t = ++token;
  useStore.setState({ assemblySource: src, assemblyError: undefined });
  if (src.script === undefined) {
    try {
      commit(t, { instances: evaluate(assemblyNodes(src)!), warnings: [] });
    } catch (e) {
      fail(t, e);
    }
    return;
  }
  evaluateSource(src, params).then((r) => commit(t, r), (e) => fail(t, e));
}

// Agent tools: evaluate and check first; only a good result replaces the assembly
export async function applyAssembly(src: Assembly): Promise<Evaluated> {
  const r = await evaluateSource(src, useStore.getState().params, new Set(engine.sources.keys()));
  const t = ++token;
  useStore.setState({ assemblySource: src });
  commit(t, r);
  return r;
}

// Parameters read by the assembly script and by no part: they re-pose without rebuilding (sliders apply live)
export function assemblyOnlyParams(): Set<string> {
  const script = useStore.getState().assemblySource.script;
  if (script === undefined) return new Set();
  const parts = new Set([...engine.sources.values()].flatMap(paramRefs));
  return new Set(paramRefs(script).filter((n) => !parts.has(n)));
}

// Re-evaluate when a parameter the script reads changes; one evaluation at a time, then the latest values
let running = false;
let again = false;

async function refresh() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      const s = useStore.getState();
      if (s.assemblySource.script === undefined) break;
      const t = token;
      await evaluateSource(s.assemblySource, s.params, new Set(engine.sources.keys())).then((r) => commit(t, r), (e) => fail(t, e));
    } while (again);
  } finally {
    running = false;
  }
}

useStore.subscribe((s, prev) => {
  const script = s.assemblySource.script;
  if (script === undefined || s.params === prev.params || s.assemblySource !== prev.assemblySource) return;
  const refs = paramRefs(script);
  if (refs.some((n) => s.params.values[n] !== prev.params.values[n])) void refresh();
});
