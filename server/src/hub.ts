import { randomUUID } from "node:crypto";
import { ClientMsg, WS_CLOSE_SUPERSEDED, type Changes, type Content, type Model, type OpName, type ServerMsg } from "shared";
import type { ActivityLog } from "./activity";
import type { AuthStore } from "./auth";
import { summary } from "./oauth";
import type { Store } from "./store";

// Minimal socket surface (ws WebSocket)
export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(ev: "message", fn: (data: unknown) => void): void;
  on(ev: "close", fn: () => void): void;
}

export interface CallResult {
  ok: boolean;
  content: Content[];
}

interface Pending {
  resolve: (r: CallResult) => void;
  timer: NodeJS.Timeout;
  project: string;
}

interface Waiter {
  project: string;
  resolve: (ok: boolean) => void;
}

interface Conn {
  socket: Socket;
  ip: string;
  pending: Map<string, Pending>;
  openProject: string | null;
  visible: boolean;
  waiters: Waiter[];
  queue: Promise<void>;
  dropped?: boolean;
}

export interface HubLimits {
  maxConnections: number;
  maxConnectionsPerIp: number;
}

export type Target = { ok: true; project: string; note?: string } | { ok: false; content: Content[] };

export const WS_CLOSE_TRY_LATER = 1013;

const fail = (text: string): { ok: false; content: Content[] } => ({ ok: false, content: [{ type: "text", text }] });

export const NOT_CONNECTED =
  "No browser is connected for this workspace. Ask the user to open their not-a-cad workspace link and keep the tab open.";

// Relays tool calls to the single active browser tab per workspace
export class Hub {
  private conns = new Map<string, Conn>();
  private perIp = new Map<string, number>();
  // Project the agent last worked on, per workspace
  private agentProjects = new Map<string, string>();
  // Running tool per workspace and client
  private busyTools = new Map<string, Map<string, string>>();
  private auth?: AuthStore;
  private activity?: ActivityLog;
  // An agent counts as connected this long after its last call
  connectedMs = 10 * 60_000;

  constructor(
    private store: Store,
    private timeoutMs = 300_000,
    private limits: HubLimits = { maxConnections: 300, maxConnectionsPerIp: 10 },
    keepaliveMs = 30_000,
    private navigateMs = 30_000,
  ) {
    // Proxies (Cloudflare: 100 s) close idle sockets; each reconnect would rebuild the model
    setInterval(() => {
      for (const c of this.conns.values()) send(c.socket, { type: "ping" });
    }, keepaliveMs).unref();
  }

  attach(deps: { auth?: AuthStore; activity?: ActivityLog }) {
    this.auth = deps.auth;
    this.activity = deps.activity;
  }

  // Pending approval requests changed for these workspaces; refresh again once they expire
  authChanged(workspaces: string[], expiresInMs?: number) {
    for (const ws of workspaces) void this.pushRequests(ws);
    if (expiresInMs !== undefined) {
      setTimeout(() => this.authChanged(workspaces), Math.max(0, expiresInMs) + 100).unref();
    }
  }

  private async pushRequests(ws: string) {
    const conn = this.conns.get(ws);
    if (!conn || !this.auth) return;
    const requests = (await this.auth.pendingFor(ws)).filter((r) => r.status === "pending").map(summary);
    send(conn.socket, { type: "auth_requests", requests });
  }

  async pushAgents(ws: string) {
    const conn = this.conns.get(ws);
    if (!conn || !this.auth) return;
    const busy = this.busyTools.get(ws);
    const now = Date.now();
    const agents = (await this.auth.approvals(ws)).map((a) => ({
      ...a,
      busy: busy?.get(a.clientId) ?? null,
      connected: !!busy?.has(a.clientId) || (a.lastUsed !== null && now - a.lastUsed < this.connectedMs),
    }));
    send(conn.socket, { type: "agents", agents });
  }

  // Tool call started (tool) or finished (null)
  busy(ws: string, clientId: string, tool: string | null) {
    let m = this.busyTools.get(ws);
    if (!m) this.busyTools.set(ws, (m = new Map()));
    const fresh = !m.has(clientId) && tool !== null;
    if (tool) m.set(clientId, tool);
    else m.delete(clientId);
    if (!m.size) this.busyTools.delete(ws);
    const conn = this.conns.get(ws);
    if (conn) send(conn.socket, { type: "agent_busy", client: clientId, tool });
    if (fresh) void this.pushAgents(ws);
  }

  // Activity of the open project changed
  activityChanged(ws: string, pid: string) {
    const conn = this.conns.get(ws);
    if (conn?.openProject === pid) send(conn.socket, { type: "activity" });
  }

  isConnected(ws: string): boolean {
    return this.conns.has(ws);
  }

  // Project open in the active tab (null: library)
  openProject(ws: string): string | null | undefined {
    return this.conns.get(ws)?.openProject;
  }

  agentProject(ws: string): string | undefined {
    return this.agentProjects.get(ws);
  }

  connect(ws: string, socket: Socket, ip = "unknown"): void {
    const old = this.conns.get(ws);
    // Replacing a tab doesn't add a connection
    const extra = old ? 0 : 1;
    if (this.conns.size + extra > this.limits.maxConnections ||
        (this.perIp.get(ip) ?? 0) + (old?.ip === ip ? 0 : 1) > this.limits.maxConnectionsPerIp) {
      socket.close(WS_CLOSE_TRY_LATER, "too many connections");
      return;
    }
    if (old) {
      this.drop(ws, old, "Browser disconnected (workspace opened in another tab)");
      send(old.socket, { type: "superseded" });
      old.socket.close(WS_CLOSE_SUPERSEDED, "superseded");
    }
    const conn: Conn = { socket, ip, pending: new Map(), openProject: null, visible: true, waiters: [], queue: Promise.resolve() };
    this.conns.set(ws, conn);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);

    // Messages are handled in order (open before changes)
    socket.on("message", (data) => {
      conn.queue = conn.queue.then(() => this.onMessage(ws, conn, data)).catch(() => undefined);
    });
    socket.on("close", () => this.drop(ws, conn, "Browser disconnected"));
    conn.queue = conn.queue.then(async () => {
      const r = await this.store.ensureWorkspace(ws);
      if (!r.ok) {
        this.drop(ws, conn, r.error);
        socket.close(WS_CLOSE_TRY_LATER, "workspace limit");
        return;
      }
      await this.pushRequests(ws);
      await this.pushAgents(ws);
    });
  }

  // Project for the next model tool call; opens one if the tab shows the library
  async target(ws: string): Promise<Target> {
    const conn = this.conns.get(ws);
    if (!conn) return fail(NOT_CONNECTED);
    await conn.queue;
    let pid = conn.openProject;
    if (!pid) {
      pid = (await this.store.activeProject(ws)) ?? (await this.store.listProjects(ws))[0]?.id;
      if (!pid) {
        const c = await this.store.createProject(ws);
        if (!c.ok) return fail(c.error);
        pid = c.id;
      }
      if (!(await this.navigate(ws, conn, pid))) return fail("The browser did not open the project");
    }
    const prev = this.agentProjects.get(ws);
    this.agentProjects.set(ws, pid);
    if (prev && prev !== pid) {
      const p = await this.store.project(ws, pid);
      return { ok: true, project: pid, note: `Note: the user changed the active project to "${p?.name ?? "Untitled"}" (${pid}); your previous project was ${prev}.` };
    }
    return { ok: true, project: pid };
  }

  // Agent switches project: the tab follows (or it opens next time when no tab is connected)
  async open(ws: string, pid: string, by?: string): Promise<CallResult> {
    this.agentProjects.set(ws, pid);
    const conn = this.conns.get(ws);
    if (!conn) {
      await this.store.setActive(ws, pid);
      return { ok: true, content: [] };
    }
    await conn.queue;
    return (await this.navigate(ws, conn, pid, by)) ? { ok: true, content: [] } : fail("The browser did not open the project");
  }

  call(ws: string, project: string, op: OpName, args: unknown): Promise<CallResult> {
    const conn = this.conns.get(ws);
    if (!conn) return Promise.resolve(fail(NOT_CONNECTED));
    if (conn.openProject !== project) return Promise.resolve(fail("The active project changed; call the tool again"));
    void this.store.touch(ws);
    const callId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(callId);
        resolve(fail(`Browser did not respond within ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);
      conn.pending.set(callId, { resolve, timer, project });
      send(conn.socket, { type: "call", id: callId, op, args, project });
    });
  }

  private navigate(ws: string, conn: Conn, pid: string, by?: string): Promise<boolean> {
    if (conn.openProject === pid) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w: Waiter = { project: pid, resolve };
      const timer = setTimeout(() => done(false), this.navigateMs);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        conn.waiters = conn.waiters.filter((x) => x !== w);
        resolve(ok);
      };
      w.resolve = done;
      conn.waiters.push(w);
      send(conn.socket, { type: "navigate", project: pid, ...(by ? { by } : {}) });
      if (this.conns.get(ws) !== conn) done(false);
    });
  }

  private async onMessage(ws: string, conn: Conn, data: unknown): Promise<void> {
    let msg: ClientMsg;
    try {
      msg = ClientMsg.parse(JSON.parse(String(data)));
    } catch {
      return; // ignore malformed
    }
    if (this.conns.get(ws) !== conn) return;
    if (msg.type === "open") {
      const pid = msg.project;
      const model = pid ? await this.store.getModel(ws, pid) : undefined;
      conn.openProject = model ? pid : null;
      if (pid && model) {
        await this.store.setActive(ws, pid);
        await this.store.markSeen(ws, pid);
        send(conn.socket, { type: "restore", project: pid, model });
      }
      for (const w of [...conn.waiters]) if (w.project === conn.openProject) w.resolve(true);
      return;
    }
    if (msg.type === "visibility") {
      conn.visible = msg.visible;
      if (msg.visible && conn.openProject) await this.store.markSeen(ws, conn.openProject);
      return;
    }
    if (msg.type === "changes") {
      // User edits: only params and info may change outside a tool call
      const { params, info } = msg.changes;
      if ((params || info) && msg.project === conn.openProject) {
        const before = await this.store.getModel(ws, msg.project);
        const r = await this.store.apply(ws, msg.project, { params, info }, { userViewing: true });
        if (r.ok && before) await this.logUserChanges(ws, msg.project, before, { params, info });
      }
      return;
    }
    const p = conn.pending.get(msg.id);
    if (!p) return; // late or unknown reply
    conn.pending.delete(msg.id);
    clearTimeout(p.timer);
    let content = msg.content;
    if (msg.changes) {
      const viewing = conn.openProject === p.project && conn.visible;
      const r = await this.store.apply(ws, p.project, msg.changes, { byAgent: true, userViewing: viewing });
      if (!r.ok) content = [...content, { type: "text", text: `Warning: not saved: ${r.error}` }];
    }
    p.resolve({ ok: msg.ok, content });
  }

  private async logUserChanges(ws: string, pid: string, before: Model, ch: Pick<Changes, "params" | "info">) {
    if (!this.activity) return;
    const log = (verb: string, object?: string, detail?: string) => this.activity!.add(ws, pid, { who: "You", verb, object, detail });
    if (ch.params) {
      const old = before.params.values;
      for (const [k, v] of Object.entries(ch.params.values)) {
        if (old[k] !== v) await log("changed parameter", k, `${old[k] ?? "—"} → ${v}`);
      }
    }
    if (ch.info) {
      if (ch.info.name !== before.info.name) await log("renamed model", ch.info.name ?? "Untitled");
      if (ch.info.description !== before.info.description) await log("edited description");
    }
    this.activityChanged(ws, pid);
  }

  private drop(ws: string, conn: Conn, reason: string): void {
    if (this.conns.get(ws) === conn) this.conns.delete(ws);
    if (!conn.dropped) {
      conn.dropped = true;
      const n = (this.perIp.get(conn.ip) ?? 1) - 1;
      if (n > 0) this.perIp.set(conn.ip, n);
      else this.perIp.delete(conn.ip);
    }
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(fail(reason));
    }
    conn.pending.clear();
    for (const w of [...conn.waiters]) w.resolve(false);
  }
}

function send(s: Socket, msg: ServerMsg): void {
  try {
    s.send(JSON.stringify(msg));
  } catch {
    // socket already closed
  }
}
