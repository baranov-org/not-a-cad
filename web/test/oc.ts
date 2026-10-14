// Real OpenCascade (replicad) for kernel unit tests
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as replicad from "replicad";
import opencascade from "replicad-opencascadejs";

let ready: Promise<void> | undefined;
export function loadKernel(): Promise<void> {
  ready ??= (async () => {
    const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    replicad.setOC(await (opencascade as any)({ wasmBinary: wasm }));
  })();
  return ready;
}

const names = Object.keys(replicad).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default");
// Runs a part script the way the worker does (no part()/param())
export function shapeOf(source: string): replicad.Shape3D {
  const api = replicad as unknown as Record<string, unknown>;
  const fn = new Function(...names, `${source}\n;return main;`);
  return fn(...names.map((k) => api[k]))() as replicad.Shape3D;
}
