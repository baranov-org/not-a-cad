import wasmUrl from "replicad-opencascadejs/wasm?url";
import type { Params, ParamValue } from "shared";
import { idbCache } from "./kernel/cache";
import { Engine } from "./kernel/engine";
import { setGeometry, viewer } from "./scene";
import { useStore } from "./state";

const query = new URLSearchParams(location.search);

// Kernel WASM (22 MB) comes from the CDN when VITE_ASSETS_BASE is set, else from the origin
const fetchWasm = async (): Promise<ArrayBuffer> => {
  const base = import.meta.env.VITE_ASSETS_BASE;
  if (base) {
    try {
      const r = await fetch(new URL(wasmUrl.split("/").pop()!, base));
      if (r.ok) return await r.arrayBuffer();
    } catch {
      // fall back to origin
    }
  }
  return (await fetch(wasmUrl)).arrayBuffer();
};

let wasm: Promise<ArrayBuffer> | undefined;
const loadWasm = async () => {
  wasm ??= fetchWasm();
  return (await wasm).slice(0);
};

export const engine = new Engine(
  {
    // A failed build keeps the last good mesh (shown tinted); export skips it
    onPart(info, mesh) {
      useStore.setState((s) => ({ parts: { ...s.parts, [info.name]: info } }));
      if (mesh) setGeometry(info.name, mesh);
    },
    onRound: (r) => useStore.setState({ lastRound: r }),
    onRemove(name) {
      useStore.setState((s) => {
        const parts = { ...s.parts };
        delete parts[name];
        return { parts };
      });
      setGeometry(name, undefined);
    },
    onReady: () => useStore.setState({ kernelReady: true }),
  },
  () => new Worker(new URL("./kernel/worker.ts", import.meta.url), { type: "module" }),
  loadWasm,
  {
    timeoutMs: Number(query.get("buildTimeout") ?? 120_000),
    // Leave a core for the page; more workers mostly cost memory
    maxWorkers: Number(query.get("workers") ?? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))),
    cache: query.has("nocache") ? undefined : idbCache(),
  },
);

// Test/debug hook: ?debug exposes build counters
if (query.has("debug")) Object.assign(globalThis, { cadEngine: engine, cadStore: useStore, cadViewer: viewer });

// Saves user-edited params; set only in session mode (share viewers keep edits local)
let saveParams: ((p: Params) => void) | undefined;
export const setParamsSaver = (fn: (p: Params) => void) => (saveParams = fn);

// User edits from the parameters panel: rebuild live, then save if in a session
export function applyUserValues(values: Record<string, ParamValue>) {
  const p = engine.setValues(values);
  useStore.setState({ params: engine.params });
  saveParams?.(engine.params);
  return p;
}
