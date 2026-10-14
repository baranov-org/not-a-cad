/// <reference lib="webworker" />
import * as Comlink from "comlink";
import type { AssemblyNode, ParamValue } from "shared";
import { runAssemblyScript } from "./assemblyScript";

// Sandbox for assembly scripts: no DOM, no socket; the page kills it on timeout
export type AssemblyResult = { ok: true; nodes: AssemblyNode[] } | { ok: false; error: string };

const api = {
  run(source: string, params: Record<string, ParamValue>): AssemblyResult {
    try {
      return { ok: true, nodes: runAssemblyScript(source, params) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
export type AssemblyApi = typeof api;

Comlink.expose(api);
