import { useEffect, useState } from "react";
import { openProject } from "../live";
import { dismissToast, toast, useStore } from "../state";
import { projectsApi, type ProjectCard } from "../workspace";
import { useDismiss, when } from "./shell/Shell";
import { newProject, refreshProjects } from "./Workspace";

const edited = (p: ProjectCard) =>
  p.forked && p.updated - p.created < 5000 ? `Forked ${new Date(p.created).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : `Edited ${when(p.updated)}`;

function Card({ ws, p }: { ws: string; p: ProjectCard }) {
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const [name, setName] = useState(p.name);
  useEffect(() => setName(p.name), [p.name]);
  const ref = useDismiss<HTMLLIElement>(menu, () => setMenu(false));
  const api = projectsApi(ws);
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e));

  const rename = async () => {
    setRenaming(false);
    const n = name.trim();
    if (!n || n === p.name) return setName(p.name);
    await api.rename(p.id, n).catch(fail);
    await refreshProjects(ws);
  };
  const duplicate = async () => {
    setMenu(false);
    await api.duplicate(p.id).catch(fail);
    await refreshProjects(ws);
  };
  // Removed at once; Undo restores within the purge window
  const remove = async () => {
    setMenu(false);
    useStore.setState((s) => ({ projects: s.projects.filter((x) => x.id !== p.id) }));
    try {
      await api.remove(p.id);
    } catch (e) {
      fail(e);
      return refreshProjects(ws);
    }
    const id = toast(`Deleted ${p.name}.`, {
      label: "Undo",
      run: async () => {
        dismissToast(id);
        await api.restore(p.id).catch(() => toast("Too late to undo"));
        await refreshProjects(ws);
      },
    });
  };

  const badges: [string, string][] = [];
  if (p.active) badges.push(["Open", "b-open"]);
  if (p.agentHere) badges.push(["Agent here", "b-agent"]);
  if (p.changedByAgent) badges.push(["Changed by agent", "b-changed"]);
  if (p.shared) badges.push(["Shared", ""]);
  if (p.forked) badges.push(["Forked from share", ""]);

  return (
    <li ref={ref} className={`card${p.active ? " open" : ""}`} data-project={p.id} data-name={p.name}>
      <button className="thumb" onClick={() => openProject(p.id)} aria-label={`Open ${p.name}`}>
        {p.thumbnail ? <img src={p.thumbnail} alt="" data-testid="thumb" /> : <span className="snap-label">viewport snapshot</span>}
      </button>
      <div className="card-body">
        <div className="card-title">
          {renaming ? (
            <input autoFocus value={name} maxLength={80} aria-label="Project name"
              onChange={(e) => setName(e.target.value)} onBlur={rename}
              onKeyDown={(e) => { if (e.key === "Enter") void rename(); if (e.key === "Escape") { setName(p.name); setRenaming(false); } }} />
          ) : (
            <span className="nm">{p.name}</span>
          )}
          <button className="btn btn-ghost btn-icon btn-sm more" aria-label="Project actions" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>
        </div>
        <span className="edited">{edited(p)}</span>
        <div className="badges">{badges.map(([b, c]) => <span key={b} className={`badge ${c}`}>{b}</span>)}</div>
      </div>
      {menu && (
        <div className="card-menu" role="menu">
          <button className="btn btn-ghost btn-block" role="menuitem" onClick={() => openProject(p.id)}>Open</button>
          <button className="btn btn-ghost btn-block" role="menuitem" onClick={() => { setMenu(false); setRenaming(true); }}>Rename</button>
          <button className="btn btn-ghost btn-block" role="menuitem" onClick={duplicate}>Duplicate</button>
          <button className="btn btn-ghost btn-block del" role="menuitem" onClick={remove}>Delete</button>
        </div>
      )}
    </li>
  );
}

export function Library({ ws }: { ws: string }) {
  const projects = useStore((s) => s.projects);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    document.title = "Projects · not-a-cad";
    const load = () => void refreshProjects(ws).then(() => setLoaded(true));
    load();
    // Agents can change projects while the library is open
    const t = setInterval(load, 10_000);
    addEventListener("focus", load);
    return () => {
      clearInterval(t);
      removeEventListener("focus", load);
    };
  }, [ws]);

  const shown = projects.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="library" data-testid="library">
      <div className="inner">
        <div className="lib-head">
          <div className="t">
            <h1>Projects</h1>
            <p>One model per project, each with its own parts, parameters and share link. Your agent works on the project that's open.</p>
          </div>
          <button className="btn btn-lg btn-primary" onClick={() => void newProject(ws)} data-testid="new-project">New project</button>
        </div>
        <div className="lib-tools">
          <input type="search" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
          <button className="plain" onClick={(e) => { e.stopPropagation(); useStore.setState({ linkOpen: true }); }}>
            No account needed. Your projects live behind your workspace link. <u>Bookmark it</u>
          </button>
        </div>
        {loaded && !projects.length && (
          <div className="lib-empty" data-testid="library-empty">
            <h2>No projects yet</h2>
            Each project is one model with its own parts, parameters and share link. Your agent works on the open project and can create new ones.
            <div><button className="btn btn-lg btn-primary" onClick={() => void newProject(ws)}>New project</button></div>
          </div>
        )}
        {projects.length > 0 && !shown.length && <div className="lib-empty">No projects match “{q}”.</div>}
        <ul className="cards">{shown.map((p) => <Card key={p.id} ws={ws} p={p} />)}</ul>
      </div>
    </div>
  );
}
