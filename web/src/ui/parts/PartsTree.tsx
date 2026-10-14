import { useEffect, useMemo, useState } from "react";
import { hasAssembly, type Placed } from "shared";
import { DEFAULT_COLOR, geometries } from "../../scene";
import { setView, toggleHidden, useStore } from "../../state";
import type { PartInfo } from "../../kernel/engine";
import { Chevron, EyeIcon } from "../icons";
import { CopyButton, dur, useNow } from "../shell/Shell";

export function Eye({ shown, onClick, label }: { shown: boolean; onClick: () => void; label: string }) {
  return (
    <button className="btn btn-ghost btn-icon btn-sm eye" aria-pressed={!shown} title={`${shown ? "Hide" : "Show"} ${label}`} aria-label={`${shown ? "Hide" : "Show"} ${label}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <EyeIcon shown={shown} />
    </button>
  );
}

// Script location from an error message ("line 3", "<anonymous>:3:14")
const location = (msg: string) => {
  const m = msg.match(/\bline (\d+)/i) ?? msg.match(/<anonymous>:(\d+):\d+/);
  return m ? `line ${m[1]}` : undefined;
};

// One line under a failed part; opens to the full message
export function ErrorCard({ name, error }: { name: string; error: string }) {
  const open = useStore((s) => s.openError === name);
  const loc = location(error);
  return (
    <div className="errcard" data-testid="error-card">
      <button aria-expanded={open} onClick={() => useStore.setState({ openError: open ? undefined : name })}>
        <b>Build failed</b><span className="line">{error.split("\n")[0]}</span><Chevron open={open} />
      </button>
      {open && (
        <div className="full">
          <div className="err-msg">{error}</div>
          <div className="where">
            <span>{loc ? `${name}.js · ${loc}` : `${name}.js`}</span>
            <CopyButton text={`${name}: ${error}`} />
          </div>
        </div>
      )}
    </div>
  );
}

const statusText = (p: PartInfo, now: number) => {
  if (p.status === "building") return dur(p.startedAt ? now - p.startedAt : 0);
  if (p.status === "error") return "Failed";
  if (p.cached) return "cached";
  return p.ms !== undefined ? dur(p.ms) : "";
};

function PartRow({ n, nested }: { n: string; nested?: boolean }) {
  const p = useStore((s) => s.parts[n]);
  const sel = useStore((s) => s.view.kind === "part" && s.view.name === n);
  // All of the part's instances hidden (a boolean keeps the selector stable)
  const hidden = useStore((s) => {
    const keys = s.assembly.instances.flatMap((inst) => (inst.part === n ? [inst.key] : []));
    return keys.length > 0 && keys.every((k) => s.hidden.has(k));
  });
  const color = useStore((s) => s.assembly.instances.find((i) => i.part === n)?.color ?? DEFAULT_COLOR);
  const now = useNow(200, p?.status === "building");
  if (!p) return null;
  const el = p.startedAt ? now - p.startedAt : 0;
  const cls = p.status === "building" ? " building" : p.status === "error" ? " failed" : "";
  return (
    <li data-part={n} data-status={p.status}>
      <button className={`part-row${nested ? " nested" : ""}${sel ? " sel" : ""}${hidden ? " hid" : ""}`} onClick={() => setView({ kind: "part", name: n })} title={p.error}>
        <span className="sw" style={{ background: color }} />
        <span className="nm">{n}</span>
        <span className={`st${cls}`}>{statusText(p, now)}</span>
        {p.status === "building" && (
          <span className="pbar"><i style={{ width: `${p.lastMs ? Math.min(100, (el / p.lastMs) * 100) : 50}%` }} /></span>
        )}
      </button>
      {p.status === "error" && p.error && <ErrorCard name={n} error={p.error} />}
    </li>
  );
}

// Assembly groups (from instance paths) and instances, with eye toggles (view only)
interface AsmGroup { id: string; label: string; groups: AsmGroup[]; items: { inst: Placed; index: number }[]; keys: string[] }

function asmTree(instances: Placed[]): AsmGroup {
  const root: AsmGroup = { id: "", label: "", groups: [], items: [], keys: [] };
  const byId = new Map<string, AsmGroup>([["", root]]);
  instances.forEach((inst, index) => {
    const segs = inst.key.split("/").slice(0, -1);
    let g = root;
    g.keys.push(inst.key);
    segs.forEach((seg, d) => {
      const id = segs.slice(0, d + 1).join("/");
      let next = byId.get(id);
      if (!next) {
        next = { id, label: inst.path[d] ?? seg, groups: [], items: [], keys: [] };
        byId.set(id, next);
        g.groups.push(next);
      }
      next.keys.push(inst.key);
      g = next;
    });
    g.items.push({ inst, index });
  });
  return root;
}

const COLLAPSE_OVER = 20;

function AsmGroupRows({ g, open, toggle }: { g: AsmGroup; open: Record<string, boolean>; toggle: (id: string, now: boolean) => void }) {
  const hidden = useStore((s) => s.hidden);
  const names: Record<string, number> = {};
  for (const { inst } of g.items) names[inst.label ?? inst.part] = (names[inst.label ?? inst.part] ?? 0) + 1;
  const seen: Record<string, number> = {};
  return (
    <>
      {g.items.map(({ inst, index }) => {
        const base = inst.label ?? inst.part;
        seen[base] = (seen[base] ?? 0) + 1;
        const label = names[base] > 1 ? `${base} #${seen[base]}` : base;
        const off = hidden.has(inst.key);
        return (
          <li key={inst.key} data-instance={index} data-key={inst.key} className={`inst-row${off ? " off" : ""}`}>
            <span className="nm">{label}</span>
            <Eye shown={!off} label={label} onClick={() => toggleHidden([inst.key])} />
          </li>
        );
      })}
      {g.groups.map((c) => {
        const isOpen = open[c.id] ?? c.keys.length <= COLLAPSE_OVER;
        const shown = c.keys.some((k) => !hidden.has(k));
        return (
          <li key={c.id} className="asm-group" data-asm-group={c.id} data-open={isOpen}>
            <div className={`group-row${shown ? "" : " off"}`}>
              <button className="tog" aria-expanded={isOpen} onClick={() => toggle(c.id, !isOpen)}>
                <Chevron open={isOpen} />
                <span className="nm">{c.label}</span>
                <span className="count">{c.keys.length}</span>
              </button>
              <Eye shown={shown} label={c.label} onClick={() => toggleHidden(c.keys)} />
            </div>
            {isOpen && <ul><AsmGroupRows g={c} open={open} toggle={toggle} /></ul>}
          </li>
        );
      })}
    </>
  );
}

function InstanceList() {
  const instances = useStore((s) => s.assembly.instances);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const tree = useMemo(() => asmTree(instances), [instances]);
  return (
    <ul data-testid="instances">
      <AsmGroupRows g={tree} open={open} toggle={(id, now) => setOpen((o) => ({ ...o, [id]: now }))} />
    </ul>
  );
}

// Assembly entry, ungrouped parts, then the agent's collapsible groups
export function PartsTree() {
  const parts = useStore((s) => s.parts);
  const view = useStore((s) => s.view);
  const instances = useStore((s) => s.assembly.instances);
  const groups = useStore((s) => s.groups);
  const hidden = useStore((s) => s.hidden);
  const [showInstances, setShowInstances] = useState(true);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const names = Object.keys(parts).sort();
  const known = new Set(groups.groups.map((g) => g.id));
  const groupOf = (n: string) => groups.assign[n];
  const source = useStore((s) => s.assemblySource);
  const asmError = useStore((s) => s.assemblyError);
  const showAssembly = instances.length > 0 || hasAssembly(source);
  const noAssembly = !showAssembly && view.kind === "assembly" && names.length > 0;
  // Nothing to show as an assembly: show the first part
  useEffect(() => {
    if (noAssembly) setView({ kind: "part", name: names[0] });
  }, [noAssembly]);
  if (!names.length) {
    return <p className="empty-box" data-testid="no-parts">No parts yet. Parts appear here as your agent builds them.</p>;
  }
  const asmSel = view.kind === "assembly";
  return (
    <>
      <div className="parts-head"><h2>Parts</h2></div>
      <ul className="tree" data-testid="parts">
        {showAssembly && <li data-testid="assembly-entry" data-status={asmError ? "error" : "ok"}>
          <div className={`asm-row${asmSel ? " sel" : ""}`}>
            <button className="tog" aria-expanded={showInstances} aria-label="Expand assembly" data-testid="instances-toggle"
              onClick={() => setShowInstances(!showInstances)}><Chevron open={showInstances} /></button>
            <button className="pick" data-testid="assembly-row" onClick={() => setView({ kind: "assembly" })}>
              <span>Assembly</span>
              <span className="meta">{instances.length} instance{instances.length === 1 ? "" : "s"}{hidden.size ? ` · ${hidden.size} hidden` : ""}</span>
            </button>
          </div>
          {asmError && <ErrorCard name="assembly" error={asmError} />}
          {showInstances && <InstanceList />}
        </li>}
        {names.filter((n) => !groupOf(n) || !known.has(groupOf(n))).map((n) => <PartRow key={n} n={n} />)}
        {groups.groups.map((g) => {
          const members = names.filter((n) => groupOf(n) === g.id);
          if (!members.length) return null;
          const isClosed = closed[g.id] ?? g.collapsed;
          const failed = members.some((n) => parts[n].status === "error");
          const building = members.filter((n) => parts[n].status === "building").length;
          const idx = instances.flatMap((inst) => (members.includes(inst.part) ? [inst.key] : []));
          const shown = !idx.length || idx.some((k) => !hidden.has(k));
          return (
            <li key={g.id} className="group" data-group={g.id} data-open={!isClosed}>
              <div className={`group-row${shown ? "" : " off"}`}>
                <button className="tog" aria-expanded={!isClosed} onClick={() => setClosed({ ...closed, [g.id]: !isClosed })}>
                  <Chevron open={!isClosed} />
                  <span className="nm">{g.label}</span>
                  <span className="count">{members.length}</span>
                  {failed && <span className="reddot" title="A part in this group failed" data-testid="group-error" />}
                  {building > 0 && <span className="building" data-testid="group-building">{building} building</span>}
                </button>
                {idx.length > 0 && <Eye shown={shown} label={`${g.label} in assembly`} onClick={() => toggleHidden(idx)} />}
              </div>
              {!isClosed && <ul>{members.map((n) => <PartRow key={n} n={n} nested />)}</ul>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// Failed parts that still show their last good mesh
export const failedWithGeometry = (parts: Record<string, PartInfo>) =>
  Object.values(parts).filter((p) => p.status === "error" && geometries.has(p.name)).map((p) => p.name);
