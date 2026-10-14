import { checkValues, mergeValues, withoutPart, type Content, type OpArgs, type OpName } from "shared";
import { dependentsOf, depsOf } from "./kernel/graph";
import type { Engine, PartInfo } from "./kernel/engine";
import type { OpHandler, OpResult } from "./relay";
import { runExport } from "./export/run";
import { viewer } from "./scene";
import { applyAssembly, type Evaluated } from "./assembly";
import { parseRef, summarizePart } from "./measure";
import { setView, useStore } from "./state";

// Max file size returned to the agent (raw bytes)
const AGENT_EXPORT_MAX = Number(new URLSearchParams(location.search).get("agentExportMax") ?? 8 * 1024 * 1024);

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const text = (v: unknown): Content => ({ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) });
const ok = (v: unknown, changes?: OpResult["changes"]): OpResult => ({ ok: true, content: [text(v)], changes });
const err = (msg: string, changes?: OpResult["changes"]): OpResult => ({ ok: false, content: [text(msg)], changes });
// One message-channel tick: not throttled in background tabs (timers are, and animation frames stop)
const tick = () => new Promise<void>((r) => {
  const c = new MessageChannel();
  c.port1.onmessage = () => r();
  c.port2.postMessage(0);
});
// One animation frame while visible; a tick while hidden (also when the tab hides mid-wait)
const frame = () => new Promise<void>((r) => {
  if (document.visibilityState === "hidden") return void tick().then(r);
  const off = () => document.removeEventListener("visibilitychange", onVis);
  const id = requestAnimationFrame(() => { off(); r(); });
  const onVis = () => {
    if (document.visibilityState !== "hidden") return;
    cancelAnimationFrame(id);
    off();
    void tick().then(r);
  };
  document.addEventListener("visibilitychange", onVis);
});
const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await frame();
};

function summary(p: PartInfo) {
  const m = p.metrics;
  const group = useStore.getState().groups.assign[p.name];
  return {
    name: p.name,
    ...(group ? { group } : {}),
    status: p.status,
    ...(p.error ? { error: p.error } : {}),
    ...(m
      ? {
          bbox: m.bbox,
          size: m.bbox.max.map((v, i) => Math.round((v - m.bbox.min[i]) * 1e4) / 1e4),
          volume: m.volume,
          faces: m.faces,
          edges: m.edges,
        }
      : {}),
  };
}

export function makeHandlers(engine: Engine): OpHandler {
  const exists = (name: string) => engine.sources.has(name);

  const ops: { [K in OpName]: (a: OpArgs<K>) => Promise<OpResult> | OpResult } = {
    list_parts: () => ok([...engine.infos.values()].map(summary)),

    get_part: ({ name }) => {
      const p = engine.infos.get(name);
      if (!p) return err(`Unknown part "${name}"`);
      return ok({ ...summary(p), refs: p.refs, params: p.params, usedBy: dependentsOf(depsOf(engine.sources), name), source: p.source });
    },

    set_part: async ({ name, source, group }) => {
      const p = await engine.setPart(name, source);
      setView({ kind: "part", name });
      const changes: OpResult["changes"] = { upsert: [{ name, source }] };
      const g = useStore.getState().groups;
      if (group !== undefined && g.assign[name] !== group) {
        if (!g.groups.some((x) => x.id === group)) return err(`Unknown part group "${group}"`, changes);
        changes.groups = { ...g, assign: { ...g.assign, [name]: group } };
        useStore.setState({ groups: changes.groups });
      }
      // Dependents that broke on this change
      const broken = dependentsOf(depsOf(engine.sources), name)
        .map((n) => engine.infos.get(n)!)
        .filter((d) => d.status === "error")
        .map((d) => ({ name: d.name, error: d.error }));
      const body = { ...summary(p), ...(broken.length ? { brokenDependents: broken } : {}) };
      return p.status === "ok" ? ok(body, changes) : err(`Build failed: ${p.error}\n${JSON.stringify(body, null, 2)}`, changes);
    },

    delete_part: async ({ name }) => {
      if (!exists(name)) return err(`Unknown part "${name}"`);
      const script = useStore.getState().assemblySource.script;
      if (script !== undefined && new RegExp(`["'\`]${name}["'\`]`).test(script)) {
        return err(`Part "${name}" is used by the assembly script. Change the script first.`);
      }
      const users = dependentsOf(depsOf(engine.sources), name);
      if (users.length) return err(`Part "${name}" is referenced by: ${users.join(", ")}. Delete or change those first.`);
      await engine.deletePart(name);
      const g = useStore.getState().groups;
      const groupChanges = name in g.assign
        ? { groups: { ...g, assign: Object.fromEntries(Object.entries(g.assign).filter(([p]) => p !== name)) } }
        : {};
      if (groupChanges.groups) useStore.setState({ groups: groupChanges.groups });
      const { assemblySource, view } = useStore.getState();
      const changes: OpResult["changes"] = { delete: [name], ...groupChanges };
      const pruned = withoutPart(assemblySource, name);
      if (pruned) {
        changes.assembly = pruned;
        await applyAssembly(pruned).catch(() => undefined);
      }
      if (view.kind === "part" && view.name === name) setView({ kind: "assembly" });
      return ok(`Deleted "${name}"`, changes);
    },

    // Static list or tree, or a script (evaluated with the current parameters); saved only when it evaluates
    set_assembly: async ({ assembly }) => {
      let r: Evaluated;
      try {
        r = await applyAssembly(assembly);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      setView({ kind: "assembly" });
      const kind = assembly.script !== undefined ? "Assembly script set" : "Assembly set";
      const warn = r.warnings.length ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
      return ok(`${kind}: ${r.instances.length} instance(s)${warn}`, { assembly });
    },

    get_assembly: () => {
      const { assembly, assemblySource: src, assemblyError } = useStore.getState();
      const MAX = 200;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const placed = assembly.instances.map(({ key: _k, ...i }) => i);
      return ok({
        ...(src.script !== undefined ? { script: src.script } : src.tree ? { tree: src.tree } : {}),
        ...(assemblyError ? { error: assemblyError } : {}),
        count: placed.length,
        instances: placed.slice(0, MAX),
        ...(placed.length > MAX ? { note: `First ${MAX} of ${placed.length} instances shown` } : {}),
      });
    },

    inspect_part: async ({ part, type, minRadius, maxRadius, limit }) => {
      if (!exists(part)) return err(`Unknown part "${part}"`);
      try {
        return ok(summarizePart(part, await engine.inspectAll(part), { type, minRadius, maxRadius, limit }));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    // References: a part name, or an assembly instance key (measured where it is placed)
    measure: async ({ a, b }) => {
      try {
        const items = [a, ...(b ? [b] : [])].map((s) => {
          const { target, ref } = parseRef(s);
          if (exists(target)) return { part: target, ref };
          const inst = useStore.getState().assembly.instances.find((i) => i.key === target);
          if (!inst) throw new Error(`"${target}" is neither a part nor an assembly instance (get_assembly lists instance keys)`);
          return { part: inst.part, ref, placement: { position: inst.position, rotation: inst.rotation } };
        });
        const r = await engine.inspect(items);
        return ok({ ...(b ? { a: r.facts[0], b: r.facts[1], ...r.pair } : r.facts[0]), units: "mm, degrees" });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    show: ({ part }) => {
      if (part && !exists(part)) return err(`Unknown part "${part}"`);
      setView(part ? { kind: "part", name: part } : { kind: "assembly" });
      return ok(`Showing ${part ?? "assembly"}`);
    },

    get_view_image: async ({ part, direction }) => {
      if (part && !exists(part)) return err(`Unknown part "${part}"`);
      setView(part ? { kind: "part", name: part } : { kind: "assembly" });
      await frames(3);
      if (!viewer.fit || !viewer.capture) return err("Viewer is not ready");
      // Agent sees the whole model: no hidden instances, no section
      useStore.setState({ capturing: true });
      let url: string;
      try {
        await frames(2);
        viewer.fit(direction);
        await frames(2);
        url = viewer.capture();
      } finally {
        useStore.setState({ capturing: false });
      }
      return { ok: true, content: [{ type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: "image/png" }] };
    },

    // Returns the file to the agent; nothing downloads in the user's browser
    // Same files as the export dialog; returned to the agent, nothing downloads for the user
    export: async ({ part, format, include, quality }) => {
      if (part && !exists(part)) return err(`Unknown part "${part}"`);
      const f = await runExport({
        part, format, quality,
        include: { parts: include !== "assembled", assembled: include !== "parts" },
      });
      const meta = {
        file: f.file, contents: f.contents, bytes: f.bytes.byteLength,
        ...(f.triangles !== undefined ? { triangles: f.triangles } : {}),
        ...(f.skipped.length ? { skippedFailedParts: f.skipped } : {}),
      };
      if (f.bytes.byteLength > AGENT_EXPORT_MAX) {
        const tip = format === "step" ? "" : (quality !== "draft" ? ' Try quality "draft" (the viewer\'s mesh).' : "") + (format !== "3mf" ? " 3MF is smaller than STL/OBJ." : "");
        return err(`${f.file} is ${f.bytes.byteLength} bytes, over the ${AGENT_EXPORT_MAX} byte export limit.${tip} Export a single part, or ask the user to export from the toolbar.`);
      }
      return {
        ok: true,
        content: [
          text(meta),
          { type: "resource", resource: { uri: `file:///${f.file}`, mimeType: f.mime, blob: toBase64(f.bytes) } },
        ],
      };
    },

    set_params: async ({ form }) => {
      const params = { form, values: mergeValues(engine.params, form) };
      const affected = await engine.setParams(params);
      useStore.setState({ params });
      return ok({ params: form.params.length, values: params.values, rebuilt: affected.map(summary) }, { params });
    },

    set_param_values: async ({ values }) => {
      const errs = checkValues(engine.params.form, values);
      if (errs.length) return err(`Invalid values:\n${errs.join("\n")}`);
      const affected = await engine.setValues(values);
      useStore.setState({ params: engine.params });
      const failed = affected.filter((p) => p.status === "error");
      const body = { values: engine.params.values, rebuilt: affected.map(summary) };
      return failed.length
        ? err(`Values set, but ${failed.length} part(s) failed to rebuild:\n${JSON.stringify(body, null, 2)}`, { params: engine.params })
        : ok(body, { params: engine.params });
    },

    get_params: () => ok(engine.params),

    set_part_groups: ({ groups }) => {
      const unknown = Object.keys(groups.assign).filter((p) => !exists(p));
      if (unknown.length) return err(`Unknown part(s): ${unknown.join(", ")}`);
      useStore.setState({ groups });
      return ok({ groups: groups.groups.map((g) => ({ ...g, parts: Object.keys(groups.assign).filter((p) => groups.assign[p] === g.id) })) }, { groups });
    },

    set_model_info: ({ info }) => {
      useStore.setState({ info });
      return ok({ info }, { info });
    },
  };

  return async (op, args) => {
    await engine.idle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (ops[op] as any)(args);
  };
}
