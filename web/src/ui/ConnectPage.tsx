import { useEffect, useState, type ReactNode } from "react";
import { LogoMark } from "./icons";
import { isId, type AuthRequestInfo } from "shared";
import { authApi, newWorkspace, remember, rememberedList } from "../workspace";
import { ApprovalCard } from "./Agents";

type Phase = "loading" | "missing" | "ready" | "redirecting" | "done";

// Workspace id from a pasted link or a bare id
const workspaceOf = (s: string) => s.trim().match(/(?:\/w\/)?([A-Za-z0-9_-]{22})(?:\/.*)?$/)?.[1];

// OAuth consent screen at /connect/<request>, opened by the agent's authorization flow
export function ConnectPage({ id }: { id: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [request, setRequest] = useState<AuthRequestInfo>();
  const [workspaces, setWorkspaces] = useState(rememberedList);
  const [ws, setWs] = useState<string | undefined>(() => rememberedList()[0]);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Hands the client its code (or error); also used when the workspace tab answered
  const finish = async () => {
    setPhase("redirecting");
    try {
      const { redirect } = await authApi.complete(id);
      location.assign(redirect);
    } catch {
      setPhase("done");
    }
  };

  useEffect(() => {
    document.title = "Connect agent · not-a-cad";
    let stop = false;
    const poll = async () => {
      try {
        const r = await authApi.request(id);
        if (stop) return;
        setRequest(r);
        if (r.status !== "pending") return void finish();
        setPhase((p) => (p === "loading" ? "ready" : p));
        setTimeout(poll, 2000);
      } catch {
        if (!stop) setPhase("missing");
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [id]);

  const answer = async (allow: boolean) => {
    if (!ws) return;
    setBusy(true);
    setError(undefined);
    try {
      await authApi.decide(id, ws, allow);
      remember(ws);
      await finish();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const usePasted = () => {
    const w = workspaceOf(paste);
    if (!w || !isId(w)) return setError("That doesn't look like a workspace link");
    setError(undefined);
    remember(w);
    setWorkspaces(rememberedList());
    setWs(w);
  };
  const create = async () => {
    const w = await newWorkspace();
    remember(w);
    setWorkspaces(rememberedList());
    setWs(w);
  };

  const page = (body: ReactNode) => (
    <div className="connect">
      <div className="box">
        <div className="brand"><LogoMark />not-a-cad</div>
        {body}
      </div>
    </div>
  );

  if (phase === "missing") {
    return page(
      <div data-testid="connect-missing">
        <h2 style={{ fontSize: 24, fontWeight: 800 }}>Request not found</h2>
        <p className="muted" style={{ marginTop: 8 }}>Reconnect the agent to start again.</p>
      </div>,
    );
  }
  if (phase === "done" || phase === "redirecting" || !request) {
    const title = phase === "loading" ? "Loading…" : request?.status === "denied" ? "Connection denied" : request?.status === "expired" ? "Request expired" : "All set";
    return page(
      <div data-testid="connect-done">
        <h2 style={{ fontSize: 24, fontWeight: 800 }}>{title}</h2>
        {phase !== "loading" && <p className="muted" style={{ marginTop: 8 }}>You can close this tab and return to your agent.</p>}
      </div>,
    );
  }

  return page(
    <div data-testid="connect">
      <ApprovalCard request={request}>
        {workspaces.length ? (
          <label className="ws-pick">
            Allow in workspace
            <select value={ws} onChange={(e) => setWs(e.target.value)} data-testid="workspace-picker">
              {workspaces.map((w, i) => <option key={w} value={w}>{i === 0 ? `This browser's workspace (${w.slice(0, 6)}…)` : `${w.slice(0, 6)}…`}</option>)}
            </select>
          </label>
        ) : (
          <div className="no-ws" data-testid="no-workspace">
            <span><b>This browser doesn't have a <span className="nobr">not-a-cad</span> workspace yet.</b> Open your workspace link here first, or start a new workspace.</span>
            <div className="url">
              <input placeholder="Paste your workspace link" value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Workspace link" />
              <button className="btn" onClick={usePasted}>Use</button>
            </div>
            <div><button className="btn" onClick={create}>New workspace</button></div>
          </div>
        )}
        {error && <p className="err" role="alert" style={{ marginBottom: 10 }}>{error}</p>}
        <div className="req-actions">
          <button className="btn btn-lg" onClick={() => answer(false)} disabled={busy || !ws}>Deny</button>
          <span className="spacer" />
          <button className="btn btn-lg btn-primary" onClick={() => answer(true)} disabled={busy || !ws}>Allow</button>
        </div>
      </ApprovalCard>
    </div>,
  );
}
