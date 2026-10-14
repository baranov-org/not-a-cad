import WebSocket from "ws";
import { ServerMsg, type ClientMsg } from "shared";
import { buildApp } from "../src/app";
import { Hub } from "../src/hub";
import { limitsFromEnv, type Limits } from "../src/limits";
import { pkceChallenge } from "../src/auth";
import { Store } from "../src/store";
import { testDb } from "./db";

export async function startServer(
  opts: { timeoutMs?: number; maxBytes?: number; limits?: Partial<Limits>; keepaliveMs?: number; webDist?: string; bundleDir?: string } = {},
) {
  const limits = { ...limitsFromEnv(), ...opts.limits };
  const db = await testDb();
  const store = new Store(db, { maxBytes: opts.maxBytes });
  const hub = new Hub(store, opts.timeoutMs ?? 2000, limits, opts.keepaliveMs);
  const { app, shares, bundles, auth, activity } = await buildApp({ store, hub, limits, webDist: opts.webDist, bundleDir: opts.bundleDir });
  app.addHook("onClose", () => db.close());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { app, hub, store, shares, bundles, auth, activity, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

// Workspace with one project; returns both ids
export async function seed(store: Store, parts: Record<string, string> = {}) {
  const ws = (await store.createWorkspace()) as { id: string };
  const p = (await store.createProject(ws.id)) as { id: string };
  if (Object.keys(parts).length) {
    await store.apply(ws.id, p.id, { upsert: Object.entries(parts).map(([name, source]) => ({ name, source })) });
  }
  return { ws: ws.id, pid: p.id };
}

// Test browser: records server messages, replies via handler, follows navigate
export class FakeBrowser {
  msgs: ServerMsg[] = [];
  closeCode?: number;
  followNavigate = true;
  handler?: (op: string, args: unknown, project: string) => Omit<Extract<ClientMsg, { type: "result" }>, "type" | "id"> | undefined;
  ws: WebSocket;
  opened: Promise<void>;

  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, { headers });
    this.opened = new Promise((res, rej) => {
      this.ws.on("open", () => res());
      this.ws.on("error", rej);
    });
    this.ws.on("message", (d) => {
      const msg = ServerMsg.parse(JSON.parse(String(d)));
      this.msgs.push(msg);
      if (msg.type === "navigate" && this.followNavigate) this.send({ type: "open", project: msg.project });
      if (msg.type === "call" && this.handler) {
        const r = this.handler(msg.op, msg.args, msg.project);
        if (r) this.ws.send(JSON.stringify({ type: "result", id: msg.id, ...r }));
      }
    });
    this.ws.on("close", (code) => (this.closeCode = code));
  }

  send(msg: ClientMsg) {
    this.ws.send(JSON.stringify(msg));
  }

  // Opens a project and waits for its restore
  async open(project: string | null) {
    await this.opened;
    const n = this.msgs.length;
    this.send({ type: "open", project });
    if (!project) return sleep(30);
    for (let i = 0; i < 200; i++) {
      if (this.msgs.slice(n).some((m) => m.type === "restore" && m.project === project)) return;
      await sleep(10);
    }
    throw new Error("no restore");
  }

  async waitFor<T extends ServerMsg["type"]>(type: T, from = 0): Promise<Extract<ServerMsg, { type: T }>> {
    for (let i = 0; i < 200; i++) {
      const m = this.msgs.slice(from).find((x) => x.type === type);
      if (m) return m as Extract<ServerMsg, { type: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type}`);
  }

  close() {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const VERIFIER = "test-verifier-".repeat(4);
export const REDIRECT = "http://localhost:9/cb";

// OAuth steps up to the consent page; returns the request id
export async function authorizeRequest(base: string, opts: { name?: string; resource?: string; challenge?: string } = {}) {
  const reg = await (await fetch(`${base}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: opts.name ?? "Test agent", redirect_uris: [REDIRECT] }),
  })).json();
  const q = new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, state: "st",
    code_challenge: opts.challenge ?? pkceChallenge(VERIFIER), code_challenge_method: "S256", resource: opts.resource ?? `${base}/mcp`,
  });
  const r = await fetch(`${base}/oauth/authorize?${q}`, { redirect: "manual" });
  const loc = r.headers.get("location") ?? "";
  return { clientId: reg.client_id as string, requestId: loc.split("/connect/")[1], status: r.status, location: loc };
}

export const decide = (base: string, requestId: string, workspaceId: string, allow = true) =>
  fetch(`${base}/oauth/decision`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, workspaceId, allow }),
  });

export async function complete(base: string, requestId: string) {
  const r = await fetch(`${base}/oauth/requests/${requestId}/complete`, { method: "POST" });
  return new URL((await r.json()).redirect);
}

export const tokenRequest = (base: string, body: Record<string, string>) =>
  fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

// Full flow: an approved client's tokens for the workspace
export async function grant(base: string, ws: string, name?: string) {
  const { clientId, requestId } = await authorizeRequest(base, { name });
  await decide(base, requestId, ws);
  const code = (await complete(base, requestId)).searchParams.get("code")!;
  const t = await (await tokenRequest(base, { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT })).json();
  return { clientId, token: t.access_token as string, refresh: t.refresh_token as string };
}
