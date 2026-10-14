import { BrowserOps, ServerMsg, WS_CLOSE_SUPERSEDED, type Changes, type ClientMsg, type Model, type OpName } from "shared";
import { useStore } from "./state";

export type OpResult = Omit<Extract<ClientMsg, { type: "result" }>, "type" | "id">;
export type OpHandler = (op: OpName, args: unknown) => Promise<OpResult>;

export interface RelayEvents {
  restore: (project: string, m: Model) => void;
  // Agent asks the tab to open a project
  navigate: (project: string, by?: string) => void;
}

// WebSocket to the server for one workspace; reconnects with backoff
export class RelayClient {
  private ws?: WebSocket;
  private workspace?: string;
  private delay = 500;
  private chain = Promise.resolve();
  // Project open in this tab (null: library)
  project: string | null = null;

  constructor(private handle: OpHandler, private events: RelayEvents) {}

  connect(workspace = this.workspace) {
    if (!workspace) return;
    this.workspace = workspace;
    useStore.setState({ conn: "connecting" });
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${workspace}`);
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 500;
      useStore.setState({ conn: "connected" });
      this.send({ type: "open", project: this.project });
      if (document.visibilityState === "hidden") this.send({ type: "visibility", visible: false });
    };
    ws.onmessage = (e) => this.onMessage(ws, e.data);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      if (e.code === WS_CLOSE_SUPERSEDED) {
        useStore.setState({ conn: "superseded" });
        return;
      }
      useStore.setState({ conn: "disconnected" });
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 10_000);
    };
  }

  private send(msg: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  // Tell the server which project this tab shows; it replies with restore
  open(project: string | null) {
    this.flushChanges();
    this.pending = {};
    this.project = project;
    this.send({ type: "open", project });
  }

  setVisible(visible: boolean) {
    this.send({ type: "visibility", visible });
  }

  private pending: Pick<Changes, "params" | "info"> = {};
  private pendingTimer?: ReturnType<typeof setTimeout>;

  // Save user edits (params, info), debounced so slider drags don't flood the server
  sendChanges(ch: Pick<Changes, "params" | "info">) {
    this.pending = { ...this.pending, ...ch };
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.flushChanges(), 300);
  }

  // Sends pending edits now; true when nothing is left unsent
  flushChanges(): boolean {
    clearTimeout(this.pendingTimer);
    if (!this.pending.params && !this.pending.info) return true;
    if (!this.project) return true;
    if (!this.send({ type: "changes", project: this.project, changes: this.pending })) return false;
    this.pending = {};
    return true;
  }

  // Reclaim the workspace from another tab
  takeOver() {
    this.connect();
  }

  private onMessage(ws: WebSocket, data: unknown) {
    let msg: ServerMsg;
    try {
      msg = ServerMsg.parse(JSON.parse(String(data)));
    } catch {
      return;
    }
    if (msg.type === "ping") return;
    if (msg.type === "superseded") return useStore.setState({ conn: "superseded" });
    if (msg.type === "restore") {
      if (msg.project === this.project) this.events.restore(msg.project, msg.model);
      return;
    }
    if (msg.type === "navigate") return this.events.navigate(msg.project, msg.by);
    if (msg.type === "auth_requests") {
      // A new request opens the approval modal
      const known = new Set(useStore.getState().authRequests.map((r) => r.id));
      const fresh = msg.requests.some((r) => !known.has(r.id));
      return useStore.setState((s) => ({ authRequests: msg.requests, approvalOpen: msg.requests.length > 0 && (fresh || s.approvalOpen) }));
    }
    if (msg.type === "agents") return useStore.setState({ agents: msg.agents });
    if (msg.type === "agent_busy") {
      return useStore.setState((s) => ({
        agents: s.agents.map((a) => (a.clientId === msg.client ? { ...a, busy: msg.tool, connected: true, lastUsed: Date.now() } : a)),
      }));
    }
    if (msg.type === "activity") return useStore.setState((s) => ({ activityVersion: s.activityVersion + 1 }));
    const { id, op, project } = msg;
    // Handle calls one at a time, in order
    this.chain = this.chain.then(async () => {
      let r: OpResult;
      const parsed = BrowserOps[op].safeParse(msg.args);
      if (project !== this.project) r = { ok: false, content: [{ type: "text", text: "The active project changed; call the tool again" }] };
      else if (!parsed.success) r = { ok: false, content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }] };
      else {
        try {
          r = await this.handle(op, parsed.data);
        } catch (e) {
          r = { ok: false, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
        }
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "result", id, ...r }));
    });
  }
}
