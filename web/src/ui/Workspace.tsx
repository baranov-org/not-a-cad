import { useEffect, useState } from "react";
import { openProject, relay } from "../live";
import { go, libraryPath, useRoute } from "../route";
import { notifyError } from "../logSources";
import { useStore, type ConnState } from "../state";
import { linkSaved, markLinkSaved, projectsApi, workspaceUrl } from "../workspace";
import { AgentPill, ApprovalModal, useApprovalAttention } from "./Agents";
import { ProjectView } from "./App";
import { BookmarkIcon, ChevronDown, LogoMark } from "./icons";
import { Library } from "./Library";
import { copyText, Modal, Toasts, useDismiss, useNarrow } from "./shell/Shell";

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "connecting…",
  connected: "connected",
  disconnected: "disconnected",
  superseded: "active in another tab",
};

export async function refreshProjects(ws: string) {
  const projects = await projectsApi(ws).list().catch(() => undefined);
  if (projects) useStore.setState({ projects });
  return projects;
}

export async function newProject(ws: string) {
  try {
    const { id } = await projectsApi(ws).create();
    openProject(id);
  } catch (e) {
    notifyError(e);
  }
}

export function Logo({ href, onClick, label = true }: { href: string; onClick?: (e: React.MouseEvent) => void; label?: boolean }) {
  return (
    <a className="logo" href={href} onClick={onClick} title="All projects">
      <LogoMark />{label && <b>not-a-cad</b>}
    </a>
  );
}

function Switcher({ ws, pid }: { ws: string; pid: string }) {
  const [open, setOpen] = useState(false);
  const name = useStore((s) => s.info.name) ?? "Untitled project";
  const projects = useStore((s) => s.projects);
  const ref = useDismiss(open, () => setOpen(false));
  const toggle = () => {
    if (!open) void refreshProjects(ws);
    setOpen(!open);
  };
  const recent = projects.slice(0, 4);
  return (
    <div className="switcher" ref={ref}>
      <button className="btn switcher-btn" aria-expanded={open} data-testid="switcher" onClick={toggle}>
        <span className="nm">{name}</span><ChevronDown />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="label">RECENT</div>
          {recent.map((p) => (
            <button key={p.id} role="menuitem" className={`btn btn-ghost btn-block${p.id === pid ? " cur" : ""}`} onClick={() => { setOpen(false); if (p.id !== pid) openProject(p.id); }}>
              <span className="t">{p.name}</span><span className="tag">{p.id === pid ? "open" : p.shared ? "shared" : ""}</span>
            </button>
          ))}
          <hr />
          <button role="menuitem" className="btn btn-ghost btn-block strong" onClick={() => { setOpen(false); go(libraryPath()); }}>All projects</button>
          <button role="menuitem" className="btn btn-ghost btn-block strong" onClick={() => { setOpen(false); void newProject(ws); }}>New project</button>
        </div>
      )}
    </div>
  );
}

// Workspace link button and "Bookmark your workspace link" popover
function SaveLink({ ws }: { ws: string }) {
  const open = useStore((s) => s.linkOpen);
  const setOpen = (v: boolean) => useStore.setState({ linkOpen: v });
  const [saved, setSaved] = useState(() => linkSaved(ws));
  const [copied, setCopied] = useState(false);
  const narrow = useNarrow();
  const ref = useDismiss(open, () => setOpen(false));
  const url = workspaceUrl(ws);
  const markSaved = () => {
    markLinkSaved(ws);
    setSaved(true);
  };
  const copy = async () => {
    await copyText(url);
    markSaved();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  // While open, the address bar shows the workspace link so the browser's bookmark saves it
  useEffect(() => {
    if (!open || location.pathname.startsWith(`/w/${ws}`)) return;
    const clean = location.pathname + location.search + location.hash;
    history.replaceState(history.state, "", `/w/${ws}${location.pathname === "/" ? "" : location.pathname}${location.search}${location.hash}`);
    return () => history.replaceState(history.state, "", clean);
  }, [open, ws]);
  const label = saved ? "Your link" : "Save your link";
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <div className="savelink" ref={ref}>
      <button className={`btn linkbtn${saved ? "" : " unsaved"}`} data-testid="save-link" data-saved={saved} aria-expanded={open}
        aria-label={label} title="Your workspace link" onClick={() => setOpen(!open)}>
        <BookmarkIcon />{!narrow && label}
      </button>
      {open && (
        <div className="popover" data-testid="save-link-popover">
          <h2>Bookmark your workspace link</h2>
          <p className="lead">There are no accounts. This link is your key: it opens your projects and keeps your approved agents. Anyone who has it can open them too, so keep it private.</p>
          <div className="url">
            <code className="codebox" data-testid="workspace-url">{url}</code>
            <button className="btn btn-primary" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="note">While this is open, the address bar shows your link: press <kbd>{mac ? "⌘ D" : "Ctrl D"}</kbd> to bookmark it, or paste the link somewhere safe.</p>
          <div className="tipbox"><b>Lost it?</b> <span className="muted">Ask your connected agent: “What's my <span className="nobr">not-a-cad</span> link?” It always knows the workspace it's connected to.</span></div>
          <button className="btn" style={{ marginTop: 14 }} onClick={markSaved}>{saved ? "Saved in this browser" : "I've saved it"}</button>
        </div>
      )}
    </div>
  );
}

function TopBar({ ws, pid }: { ws: string; pid?: string }) {
  const conn = useStore((s) => s.conn);
  const narrow = useNarrow();
  return (
    <header className="topbar">
      <Logo href={libraryPath()} label={!narrow} onClick={(e) => { e.preventDefault(); go(libraryPath()); }} />
      {!narrow && <span className="slash">/</span>}
      {pid ? <Switcher ws={ws} pid={pid} /> : <span className="crumb">Projects</span>}
      <span className="spacer" />
      {pid && <AgentPill ws={ws} inProject />}
      <SaveLink ws={ws} />
      {/* Connection state for assistive tech (and tests); the pill and the console show it visually */}
      <span className="sr-only" role="status" data-testid="conn">{CONN_LABEL[conn]}</span>
    </header>
  );
}

// Another tab took over this workspace
function PausedModal() {
  const conn = useStore((s) => s.conn);
  if (conn !== "superseded") return null;
  return (
    <Modal label="Paused" testid="paused" size="small">
      <div className="paused">
        <h2><span className="nobr">not-a-cad</span> is open in another tab</h2>
        <p>Only one tab talks to your agent at a time. The other tab is in control; this one is paused.</p>
        <button className="btn btn-lg btn-primary" onClick={() => relay.takeOver()}>Use this tab instead</button>
      </div>
    </Modal>
  );
}

export function WorkspaceApp({ ws }: { ws: string }) {
  const route = useRoute((s) => s.route);
  const narrow = useNarrow();
  useApprovalAttention();
  const pid = route.kind === "project" ? route.pid : undefined;
  return (
    <div className={`shell${narrow ? " narrow" : ""}`}>
      <TopBar ws={ws} pid={pid} />
      {pid ? <ProjectView ws={ws} pid={pid} /> : <Library ws={ws} />}
      {!pid && <Toasts />}
      <ApprovalModal ws={ws} />
      <PausedModal />
    </div>
  );
}
