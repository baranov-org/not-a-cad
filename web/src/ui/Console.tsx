import { useEffect, useRef, useState } from "react";
import { FILTERS, matches, mergeLog, olderServer, refreshServer, setFilter, useConsole, type LogEvent } from "../console";
import { activePlanes } from "../section";
import { setView, useStore } from "../state";
import { projectsApi } from "../workspace";
import { CloseIcon } from "./icons";
import { anyModalOpen, dur, useLayout, useNow } from "./shell/Shell";

// "12:48" today, "Oct 7" before
const time = (t: number) => {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const who = (e: LogEvent) => e.who ?? (e.kind === "you" ? "You" : "not-a-cad");
const size = (s?: [number, number, number]) => (s ? `${s.map((x) => Math.round(x)).join(" × ")} mm` : "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const toggle = () => useLayout.setState((l) => ({ consoleOpen: !l.consoleOpen }));

// Event text with its part as a link (when the part exists)
function Text({ e }: { e: LogEvent }) {
  const known = useStore((s) => !!e.part && e.part in s.parts);
  const i = known ? e.text.lastIndexOf(e.part!) : -1;
  if (i < 0) return <span className="txt">{e.text}</span>;
  return (
    <span className="txt">
      {e.text.slice(0, i)}
      <button className="btn btn-link" onClick={() => setView({ kind: "part", name: e.part! })}>{e.part}</button>
      {e.text.slice(i + e.part!.length)}
    </span>
  );
}

function Action({ e }: { e: LogEvent }) {
  useStore((s) => s.parts);
  useStore((s) => s.authRequests);
  if (!e.action || (e.action.until && !e.action.until())) return null;
  return <button className="btn" onClick={e.action.run}>{e.action.label}</button>;
}

function useBuilding() {
  const parts = useStore((s) => s.parts);
  const building = Object.values(parts).filter((p) => p.status === "building");
  const now = useNow(200, building.length > 0);
  const el = (p: (typeof building)[number]) => (p.startedAt ? now - p.startedAt : 0);
  const known = building.filter((p) => p.lastMs);
  const progress = known.length ? known.reduce((t, p) => t + Math.min(el(p), p.lastMs!), 0) / known.reduce((t, p) => t + p.lastMs!, 0) : 0.5;
  return { building, el, longest: building.length ? Math.max(...building.map(el)) : 0, progress, rebuilding: known.length === building.length };
}

// What is shown: part or assembly, size, last build
function Status() {
  const view = useStore((s) => s.view);
  const instances = useStore((s) => s.assembly.instances.length);
  const viewSize = useStore((s) => s.viewSize);
  const parts = useStore((s) => s.parts);
  const round = useStore((s) => s.lastRound);
  const list = Object.values(parts);
  const what = view.kind === "part" ? view.name : `Assembly · ${plural(instances, "instance")}`;
  let build = "";
  if (!list.length) build = "Nothing built yet.";
  else if (round && !list.some((p) => p.status === "building")) build = `Built in ${dur(round.ms)}${round.cached ? `, ${round.cached} cached` : ""}.`;
  return (
    <span className="con-status" data-testid="statusline">
      <span className="what">{list.length ? `${what}${viewSize ? `, ${size(viewSize)}` : ""}. ` : ""}{build}</span>
    </span>
  );
}

// Build progress, failures, connection and section: shown while they last
function LiveState({ onProblems }: { onProblems: () => void }) {
  const { building, longest, progress, rebuilding } = useBuilding();
  const failed = useStore((s) => Object.values(s.parts).filter((p) => p.status === "error").length);
  const conn = useStore((s) => s.conn);
  const section = useStore((s) => s.section);
  const planes = section.open ? activePlanes(section).length : -1;
  return (
    <span className="con-state" data-testid="console-state">
      {building.length > 0 && (
        <span className="con-build" data-testid="console-build">
          <span className="dot pulse" style={{ background: "var(--accent)" }} />
          {rebuilding ? "Rebuilding" : "Building"} {plural(building.length, "part")}
          <span className="mono">{dur(longest)}</span>
          <span className="track"><i style={{ width: `${Math.min(100, progress * 100)}%` }} /></span>
        </span>
      )}
      {failed > 0 && <button className="btn btn-danger-soft" data-testid="console-failed" onClick={onProblems}>⚠ {failed} failed</button>}
      {conn === "disconnected" && <span className="con-conn" data-testid="reconnecting">Reconnecting…</span>}
      {planes >= 0 && <span className="mono">Section · {plural(planes, "plane")}</span>}
    </span>
  );
}

function Row({ e }: { e: LogEvent }) {
  return (
    <li className={`log-row lv-${e.level}`} data-testid="log-row" data-kind={e.kind} data-level={e.level}>
      <span className="when">{time(e.at)}</span>
      <span className={`who k-${e.kind}`}>{who(e)}</span>{" "}
      <span className="what"><Text e={e} />{e.detail && <>{" "}<span className="detail">{e.detail}</span></>}</span>
      <Action e={e} />
    </li>
  );
}

// Per-part rows while building (elapsed versus the last build)
function Building() {
  const { building, el } = useBuilding();
  if (!building.length) return null;
  const slow = building.some((p) => (p.lastMs ?? 0) > 5000 || el(p) > 5000);
  return (
    <div className="log-building" data-testid="log-building">
      {building.map((p) => (
        <div key={p.name} className="r" data-chip-part={p.name}>
          <b>{p.name}</b><span className="mono">{dur(el(p))}{p.lastMs ? ` / ~${dur(p.lastMs)}` : ""}</span>
          <span className="track"><i style={{ width: `${p.lastMs ? Math.min(100, (el(p) / p.lastMs) * 100) : 50}%` }} /></span>
        </div>
      ))}
      {slow && <span className="note">Some parts are slow to build. You can keep orbiting and editing; the old shape stays until the new one is ready.</span>}
    </div>
  );
}

// Bottom bar (latest event, live state, what is shown) that slides up into the universal log
export function Console({ ws, pid }: { ws?: string; pid?: string }) {
  const open = useLayout((l) => l.consoleOpen);
  const events = useConsole((s) => s.events);
  const server = useConsole((s) => s.server);
  const filter = useConsole((s) => s.filter);
  const project = useConsole((s) => s.project);
  const version = useStore((s) => s.activityVersion);
  const shared = !ws;
  const api = ws ? projectsApi(ws) : undefined;

  useEffect(() => {
    useConsole.setState((s) => ({ mounted: s.mounted + 1 }));
    return () => useConsole.setState((s) => ({ mounted: s.mounted - 1 }));
  }, []);
  useEffect(() => {
    if (api && pid) refreshServer(api, pid).catch(() => undefined);
  }, [ws, pid, version]);
  // Esc closes the log after modals and popovers
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || anyModalOpen() || document.querySelector(".popover, .menu")) return;
      useLayout.setState({ consoleOpen: false });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const all = mergeLog(events, server.pid === pid ? server.entries : [], shared ? undefined : project);
  const latest = all[0];
  const filters = shared ? FILTERS.filter((f) => f.id !== "agent" && f.id !== "you") : FILTERS;
  const active = filters.some((f) => f.id === filter) ? filter : "all";
  const rows = all.filter((e) => matches(e, active));

  // Highlight a new event (not the one shown on open)
  const [flash, setFlash] = useState(false);
  const seen = useRef<{ pid?: string; id?: string }>({});
  useEffect(() => {
    if (!latest) return;
    const first = seen.current.pid !== pid || seen.current.id === undefined;
    const changed = seen.current.id !== latest.id;
    seen.current = { pid, id: latest.id };
    if (first || !changed) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2000);
    return () => clearTimeout(t);
  }, [latest?.id, pid]);

  return (
    <div className={`console btn-sm${open ? " open" : ""}`}>
      <div className="con-drawer-wrap" aria-hidden={!open}>
        <section className="con-drawer" data-testid="console-log" aria-label="Log" hidden={!open}>
          <div className="con-head">
            <h2>Log</h2>
            <div className="seg" role="tablist" aria-label="Filter">
              {filters.map((f) => (
                <button key={f.id} className="btn" role="tab" aria-selected={active === f.id} data-testid={`log-filter-${f.id}`} onClick={() => setFilter(f.id)}>{f.label}</button>
              ))}
            </div>
            <span className="spacer" />
            <button className="btn btn-ghost btn-icon" aria-label="Close log" data-testid="console-close" onClick={() => useLayout.setState({ consoleOpen: false })}><CloseIcon /></button>
          </div>
          <div className="con-body">
            {(active === "all" || active === "build") && <Building />}
            {!rows.length && <p className="empty-box">{shared ? "Nothing yet. Builds and downloads show up here." : "Nothing yet. Agent tool calls, your changes and builds show up here."}</p>}
            <ul>{rows.map((e) => <Row key={e.id} e={e} />)}</ul>
            {!shared && server.pid === pid && server.more && active !== "build" && (
              <button className="btn older" onClick={() => api && pid && olderServer(api, pid).catch(() => undefined)}>Older</button>
            )}
          </div>
        </section>
      </div>
      <div className={`con-bar${flash ? " flash" : ""}${latest && latest.level === "error" ? " is-err" : ""}`} data-testid="console"
        onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) toggle(); }}>
        <span className="con-latest" data-testid="console-latest" aria-live="polite">
          {latest ? (
            <>
              <span className="when">{time(latest.at)}</span>
              {latest.level === "error" && <span className="lvl" aria-label="Problem">⚠</span>}
              <span className={`who k-${latest.kind}`}>{who(latest)}</span>{" "}
              <Text e={latest} />
              {latest.detail && <>{" "}<span className="detail">{latest.detail}</span></>}
              <Action e={latest} />
            </>
          ) : <span className="txt muted">No events yet</span>}
        </span>
        <LiveState onProblems={() => { setFilter("problems"); useLayout.setState({ consoleOpen: true }); }} />
        <Status />
        <button className="btn btn-ghost btn-icon con-toggle" aria-expanded={open} aria-label={open ? "Close log" : "Open log"} title="Log" data-testid="console-toggle" onClick={toggle}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden style={{ transform: `rotate(${open ? 90 : -90}deg)` }}>
            <path d="M4 2l4 4-4 4" stroke="currentColor" fill="none" strokeWidth="1.6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
