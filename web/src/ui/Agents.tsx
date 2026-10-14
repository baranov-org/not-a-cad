import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentInfo, AuthRequestInfo } from "shared";
import { log } from "../console";
import { notify, notifyError } from "../logSources";
import { useStore } from "../state";
import { authApi, mcpUrl, projectsApi } from "../workspace";
import { copyText, Modal, openLog, useDismiss, useNarrow, useNow, when } from "./shell/Shell";

const countryName = (code: string | null) => {
  if (!code) return "Unknown location";
  try {
    return `${new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code} (approx.)`;
  } catch {
    return code;
  }
};

const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 5 ? "Just now" : s < 60 ? `${s} s ago` : when(t);
};

// What an approval means; shared by the consent page and the workspace modal
export function ApprovalCard({ request, queue, children }: { request: AuthRequestInfo; queue?: string; children?: ReactNode }) {
  const now = useNow(1000);
  const name = request.client.name ?? "An unnamed agent";
  const left = Math.max(0, Math.round((request.expires - now) / 1000));
  return (
    <div className="approval" data-testid="approval">
      <div className="req-top"><span>AGENT CONNECTION REQUEST</span><span>{queue}</span></div>
      <h2>Allow {name} to control this workspace?</h2>
      {!request.client.recognised && (
        <div className="warn" role="alert" data-testid="unrecognised">
          <b>Unrecognised client.</b> It didn't identify as a known agent. Only allow it if you connected it yourself just now.
        </div>
      )}
      <div className="req-facts">
        <span className="k">Client</span><span className="client">{name} {request.client.version ?? ""}</span>
        <span className="k">From</span><span>{countryName(request.country)}</span>
        <span className="k">Requested</span><span>{ago(request.created, now)}{request.status === "pending" ? ` · expires in ${left} s` : ""}</span>
      </div>
      <div className="req-can">
        <div><b>It will be able to</b><div className="muted">Create and change parts{"\n"}Change parameters{"\n"}Export files to itself{"\n"}List, open and create projects{"\n"}Tell you your workspace link</div></div>
        <div><b>It can't</b><div className="muted">Publish or unpublish shares{"\n"}See other browsers' projects</div></div>
      </div>
      {children}
      <p className="req-foot">Allowed agents stay allowed, including after reconnects, until you revoke them in Connected agents. Its tool calls wait and fail after 2 minutes without an answer.</p>
    </div>
  );
}

// Pending requests for this workspace, one at a time
export function ApprovalModal({ ws }: { ws: string }) {
  const requests = useStore((s) => s.authRequests);
  const open = useStore((s) => s.approvalOpen);
  const [busy, setBusy] = useState(false);
  const r = requests[0];
  if (!open || !r) return null;
  const answer = async (allow: boolean) => {
    setBusy(true);
    try {
      await authApi.decide(r.id, ws, allow);
      useStore.setState((s) => ({ authRequests: s.authRequests.filter((x) => x.id !== r.id) }));
      log({ kind: "you", who: "You", level: allow ? "ok" : "info", project: undefined,
        text: allow ? `allowed ${r.client.name ?? "an agent"}; it can now work in this workspace.` : `denied ${r.client.name ?? "an agent"}` });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal label="Approve agent" onClose={() => useStore.setState({ approvalOpen: false })}>
      <ApprovalCard request={r} queue={requests.length > 1 ? `1 of ${requests.length}` : undefined}>
        {requests.length > 1 && <span className="sr-only" data-testid="request-count">Request 1 of {requests.length}</span>}
        <div className="req-actions">
          <button className="btn btn-lg" onClick={() => answer(false)} disabled={busy}>Deny</button>
          <span className="spacer" />
          <button className="btn btn-lg btn-primary" onClick={() => answer(true)} disabled={busy}>Allow</button>
        </div>
      </ApprovalCard>
    </Modal>
  );
}

// Background tab: title says an approval waits (the tab icon's red dot is in favicon.ts)
export function useApprovalAttention() {
  const count = useStore((s) => s.authRequests.length);
  const base = useRef(document.title);
  useEffect(() => {
    const apply = () => {
      if (count && document.hidden) {
        if (!document.title.startsWith("(")) base.current = document.title;
        document.title = `(${count}) Approve agent · not-a-cad`;
      } else if (document.title.startsWith("(")) {
        document.title = base.current;
      }
    };
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => {
      document.removeEventListener("visibilitychange", apply);
      if (document.title.startsWith("(")) document.title = base.current;
    };
  }, [count]);
}

function pillState(agents: AgentInfo[], pending: number, conn: string, narrow: boolean): { text: string; cls: string; dot: string; pulse?: boolean } {
  if (conn === "superseded") return { text: "Paused · other tab", cls: "", dot: "var(--ink-3)" };
  if (conn === "disconnected") return { text: "Reconnecting…", cls: "", dot: "var(--err)" };
  if (pending) return { text: "Approval needed", cls: "attention", dot: "var(--warn)" };
  const active = agents.filter((a) => a.connected);
  if (!active.length) return { text: narrow ? "No agent" : "No agent connected", cls: "", dot: "var(--ink-3)" };
  const first = active.find((a) => a.busy) ?? active[0];
  const more = active.length > 1 ? ` +${active.length - 1}` : "";
  return first.busy
    ? { text: narrow ? "Working" : `${first.name} · ${first.busy}${more}`, cls: "busy", dot: "var(--accent)", pulse: true }
    : { text: `${first.name}${more}`, cls: "", dot: "var(--ok)" };
}

// Top-bar agent state; opens the pending request or Connected agents
export function AgentPill({ ws, inProject }: { ws: string; inProject: boolean }) {
  const agents = useStore((s) => s.agents);
  const pending = useStore((s) => s.authRequests.length);
  const conn = useStore((s) => s.conn);
  const [open, setOpen] = useState(false);
  const narrow = useNarrow();
  const ref = useDismiss(open, () => setOpen(false));
  const st = pillState(agents, pending, conn, narrow);
  const click = () => (pending ? useStore.setState({ approvalOpen: true }) : setOpen(!open));
  return (
    <div className="agentpill" ref={ref}>
      <button className={`btn pill ${st.cls}`} data-testid="agent-pill" data-state={st.cls || "plain"} onClick={click} aria-expanded={open}>
        <span className={`dot${st.pulse ? " pulse" : ""}`} style={{ background: st.dot }} /><span>{st.text}</span>
      </button>
      {open && <ConnectedAgents ws={ws} inProject={inProject} close={() => setOpen(false)} />}
    </div>
  );
}

function ConnectedAgents({ ws, inProject, close }: { ws: string; inProject: boolean; close: () => void }) {
  const agents = useStore((s) => s.agents);
  const [denied, setDenied] = useState<{ name: string; at: number }[]>([]);
  const [copied, setCopied] = useState(false);
  const api = projectsApi(ws);
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    api.agents().then((r) => setDenied(r.denied), () => undefined);
  });
  const url = mcpUrl();
  const copy = async () => {
    await copyText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const revoke = async (a: AgentInfo) => {
    await api.revoke(a.clientId).catch(() => notify("Could not revoke; try again", "error"));
    useStore.setState((s) => ({ agents: s.agents.filter((x) => x.clientId !== a.clientId) }));
  };
  return (
    <div className="popover" data-testid="agents-popover">
      <h2>Connected agents</h2>
      <p className="lead" style={{ marginTop: 4 }}>Agents can build and change parts and export files to themselves. They can't publish shares.</p>
      <div className="agent-list">
        {agents.map((a) => (
          <div key={a.clientId} className="agent-card" data-agent={a.name}>
            <span className={`dot${a.busy ? " pulse" : ""}`} style={{ background: a.busy ? "var(--accent)" : a.connected ? "var(--ok)" : "var(--ink-3)" }} />
            <div className="who">
              <b>{a.name}{a.version ? ` ${a.version}` : ""}</b>
              <span>Allowed {new Date(a.approvedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {a.busy ? `running ${a.busy}` : a.connected ? "active now" : a.lastUsed ? when(a.lastUsed) : "not used yet"}</span>
            </div>
            <button className="btn btn-sm" onClick={() => revoke(a)}>Revoke</button>
          </div>
        ))}
        {!agents.length && <div className="empty-dashed">No approved agents.</div>}
      </div>
      {denied.length > 0 && <p className="hint" style={{ marginTop: 12 }} data-testid="denied">Denied today: {denied.map((d) => d.name).join(", ")}</p>}
      <div className="divider" />
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Connect {agents.length ? "another" : "an"} agent</div>
      <div className="url">
        <code className="codebox" data-testid="mcp-url">{url}</code>
        <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <p className="hint" style={{ marginTop: 8, color: "var(--ink-2)" }}>
        Claude Code: <code>claude mcp add --transport http not-a-cad {url}</code>. New agents ask for your approval once.
      </p>
      {inProject && <button className="btn" style={{ marginTop: 14 }} onClick={() => { close(); openLog("all"); }}>See activity</button>}
    </div>
  );
}
