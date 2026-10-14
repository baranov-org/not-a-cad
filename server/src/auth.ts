import { createHash, randomBytes } from "node:crypto";
import { newId } from "shared";
import type { Db } from "./db";

export const DENIED = "DENIED: The user denied this connection in not-a-cad. Ask them to allow it, then reconnect.";
export const REVOKED = "REVOKED: Access was revoked in not-a-cad → Connected agents.";
export const EXPIRED_REQUEST = "EXPIRED: Nobody answered the approval request in not-a-cad within 2 minutes. Reconnect to ask again.";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export interface AuthOptions {
  requestTtlMs?: number;
  accessTtlMs?: number;
  refreshTtlMs?: number;
  codeTtlMs?: number;
  now?: () => number;
}

export interface Client {
  id: string;
  name: string | null;
  version: string | null;
  redirectUris: string[];
  country: string | null;
}

export type RequestStatus = "pending" | "allowed" | "denied" | "expired";

export interface AuthRequest {
  id: string;
  client: Client;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string | null;
  country: string | null;
  created: number;
  expires: number;
  status: RequestStatus;
  workspaceId: string | null;
}

export interface Tokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type Verified =
  | { ok: true; workspaceId: string; clientId: string }
  | { ok: false; error: "invalid" | "expired" | "revoked" };

export interface ApprovedAgent {
  clientId: string;
  name: string;
  version: string | null;
  approvedAt: number;
  lastUsed: number | null;
}

export type Err = { ok: false; status: number; error: string; description?: string };

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

// Known MCP clients; others get a warning on the consent screen
const KNOWN = [/claude/i, /cursor/i, /visual studio code|vs ?code/i, /windsurf/i, /zed/i, /chatgpt|openai/i, /mcp-inspector/i];
export const recognised = (name: string | null) => !!name && KNOWN.some((r) => r.test(name));

// OAuth clients, authorization requests, approvals and hashed tokens
export class AuthStore {
  readonly requestTtlMs: number;
  readonly accessTtlMs: number;
  readonly refreshTtlMs: number;
  readonly codeTtlMs: number;
  private now: () => number;

  constructor(private db: Db, opts: AuthOptions = {}) {
    this.requestTtlMs = opts.requestTtlMs ?? 2 * MIN;
    this.accessTtlMs = opts.accessTtlMs ?? 60 * MIN;
    this.refreshTtlMs = opts.refreshTtlMs ?? 90 * DAY;
    this.codeTtlMs = opts.codeTtlMs ?? MIN;
    this.now = opts.now ?? Date.now;
  }

  // ---- clients

  async registerClient(c: { name?: string; redirectUris: string[]; country?: string }): Promise<string> {
    const id = newId();
    await this.db.query(
      "INSERT INTO oauth_clients (id, name, redirect_uris, country, created) VALUES ($1, $2, $3, $4, $5)",
      [id, c.name?.slice(0, 100) ?? null, JSON.stringify(c.redirectUris), c.country ?? null, this.now()]);
    return id;
  }

  async client(id: string): Promise<Client | undefined> {
    const [r] = await this.db.query<{ id: string; name: string | null; version: string | null; redirect_uris: string[]; country: string | null }>(
      "SELECT id, name, version, redirect_uris, country FROM oauth_clients WHERE id = $1", [id]);
    return r && { id: r.id, name: r.name, version: r.version, redirectUris: r.redirect_uris, country: r.country };
  }

  // From the MCP initialize clientInfo
  async setClientInfo(id: string, name: string | undefined, version: string | undefined) {
    await this.db.query("UPDATE oauth_clients SET version = COALESCE($2, version), name = COALESCE(name, $3) WHERE id = $1",
      [id, version?.slice(0, 40) ?? null, name?.slice(0, 100) ?? null]);
  }

  // ---- authorization requests

  async createRequest(r: {
    clientId: string; redirectUri: string; codeChallenge: string; state?: string; resource?: string;
    country?: string;
  }): Promise<string> {
    const id = newId();
    await this.db.query(
      `INSERT INTO auth_requests (id, client_id, redirect_uri, code_challenge, state, resource, country, created)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, r.clientId, r.redirectUri, r.codeChallenge, r.state ?? null, r.resource ?? null, r.country ?? null, this.now()]);
    return id;
  }

  async request(id: string): Promise<AuthRequest | undefined> {
    const [r] = await this.db.query<{
      id: string; client_id: string; redirect_uri: string; code_challenge: string; state: string | null; resource: string | null;
      country: string | null; created: number; status: RequestStatus; workspace_id: string | null;
    }>("SELECT * FROM auth_requests WHERE id = $1", [id]);
    if (!r) return;
    const client = await this.client(r.client_id);
    if (!client) return;
    const expires = r.created + this.requestTtlMs;
    const status = r.status === "pending" && this.now() > expires ? "expired" : r.status;
    return {
      id: r.id, client, redirectUri: r.redirect_uri, codeChallenge: r.code_challenge, state: r.state, resource: r.resource,
      country: r.country, created: r.created, expires, status, workspaceId: r.workspace_id,
    };
  }

  // Pending requests a workspace tab should show: from a client name approved there before
  async pendingFor(ws: string): Promise<AuthRequest[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT r.id FROM auth_requests r JOIN oauth_clients c ON c.id = r.client_id
       WHERE r.status = 'pending' AND r.created > $2 AND c.name IS NOT NULL AND c.name IN (
         SELECT c2.name FROM approvals a JOIN oauth_clients c2 ON c2.id = a.client_id WHERE a.workspace_id = $1)
       ORDER BY r.created`, [ws, this.now() - this.requestTtlMs]);
    const out: AuthRequest[] = [];
    for (const r of rows) {
      const req = await this.request(r.id);
      if (req) out.push(req);
    }
    return out;
  }

  // Workspaces whose tab should see this request
  async workspacesFor(r: AuthRequest): Promise<string[]> {
    if (!r.client.name) return [];
    const rows = await this.db.query<{ workspace_id: string }>(
      "SELECT DISTINCT a.workspace_id FROM approvals a JOIN oauth_clients c ON c.id = a.client_id WHERE c.name = $1", [r.client.name]);
    return rows.map((x) => x.workspace_id);
  }

  // User's answer; allowing records a persistent approval
  async decide(id: string, ws: string, allow: boolean): Promise<{ ok: true } | Err> {
    const r = await this.request(id);
    if (!r) return { ok: false, status: 404, error: "Unknown request" };
    if (r.status === "expired") return { ok: false, status: 410, error: "This request expired" };
    if (r.status !== "pending") return { ok: false, status: 409, error: `Already ${r.status}` };
    const t = this.now();
    return this.db.tx(async (q) => {
      const done = await q.query(
        "UPDATE auth_requests SET status = $2, workspace_id = $3, decided_at = $4 WHERE id = $1 AND status = 'pending' RETURNING id",
        [id, allow ? "allowed" : "denied", ws, t]);
      if (!done.length) return { ok: false, status: 409, error: "Already answered" };
      if (allow) {
        await q.query(
          `INSERT INTO approvals (workspace_id, client_id, approved_at) VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, client_id) DO UPDATE SET approved_at = $3, revoked_at = NULL`,
          [ws, r.client.id, t]);
      }
      return { ok: true };
    });
  }

  // Redirect back to the client: a single-use code once allowed, or the error
  async complete(id: string): Promise<{ ok: true; redirect: string } | Err> {
    const r = await this.request(id);
    if (!r) return { ok: false, status: 404, error: "Unknown request" };
    const url = new URL(r.redirectUri);
    if (r.state) url.searchParams.set("state", r.state);
    if (r.status === "pending") return { ok: false, status: 409, error: "Not answered yet" };
    if (r.status === "denied" || r.status === "expired") {
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", r.status === "denied" ? DENIED : EXPIRED_REQUEST);
      return { ok: true, redirect: url.toString() };
    }
    const code = token();
    const set = await this.db.query(
      "UPDATE auth_requests SET code_hash = $2, code_expires = $3 WHERE id = $1 AND code_hash IS NULL RETURNING id",
      [id, hash(code), this.now() + this.codeTtlMs]);
    if (!set.length) return { ok: false, status: 409, error: "Already completed" };
    url.searchParams.set("code", code);
    return { ok: true, redirect: url.toString() };
  }

  // ---- tokens

  private async issue(q: Pick<Db, "query">, ws: string, clientId: string): Promise<Tokens> {
    const access = token();
    const refresh = token();
    const t = this.now();
    await q.query("INSERT INTO tokens (hash, kind, workspace_id, client_id, expires) VALUES ($1, 'access', $3, $4, $5), ($2, 'refresh', $3, $4, $6)",
      [hash(access), hash(refresh), ws, clientId, t + this.accessTtlMs, t + this.refreshTtlMs]);
    return { access_token: access, token_type: "Bearer", expires_in: Math.round(this.accessTtlMs / 1000), refresh_token: refresh, scope: "cad" };
  }

  async exchangeCode(p: { code: string; verifier: string; clientId: string; redirectUri?: string }): Promise<{ ok: true; tokens: Tokens } | Err> {
    const bad = (description: string): Err => ({ ok: false, status: 400, error: "invalid_grant", description });
    return this.db.tx(async (q) => {
      const [r] = await q.query<{ id: string; client_id: string; redirect_uri: string; code_challenge: string; code_expires: number; code_used: boolean; workspace_id: string }>(
        "SELECT * FROM auth_requests WHERE code_hash = $1 FOR UPDATE", [hash(p.code)]);
      if (!r || r.code_used) return bad("Unknown or used code");
      if (r.client_id !== p.clientId) return bad("Code was issued to another client");
      if (p.redirectUri !== undefined && p.redirectUri !== r.redirect_uri) return bad("redirect_uri mismatch");
      if (this.now() > r.code_expires) return bad("Code expired");
      if (pkceChallenge(p.verifier) !== r.code_challenge) return bad("PKCE verification failed");
      await q.query("UPDATE auth_requests SET code_used = true WHERE id = $1", [r.id]);
      return { ok: true, tokens: await this.issue(q, r.workspace_id, r.client_id) };
    });
  }

  // Rotating refresh: the old refresh token stops working
  async refresh(refreshToken: string, clientId: string): Promise<{ ok: true; tokens: Tokens } | Err> {
    return this.db.tx(async (q) => {
      const [r] = await q.query<{ workspace_id: string; client_id: string; expires: number; revoked: boolean }>(
        "DELETE FROM tokens WHERE hash = $1 AND kind = 'refresh' RETURNING workspace_id, client_id, expires, revoked", [hash(refreshToken)]);
      if (!r || r.client_id !== clientId || this.now() > r.expires) return { ok: false, status: 400, error: "invalid_grant", description: "Unknown or expired refresh token" };
      if (r.revoked || !(await this.approved(q, r.workspace_id, r.client_id))) {
        return { ok: false, status: 400, error: "invalid_grant", description: REVOKED };
      }
      return { ok: true, tokens: await this.issue(q, r.workspace_id, r.client_id) };
    });
  }

  private async approved(q: Pick<Db, "query">, ws: string, clientId: string) {
    const [a] = await q.query("SELECT 1 FROM approvals WHERE workspace_id = $1 AND client_id = $2 AND revoked_at IS NULL", [ws, clientId]);
    return !!a;
  }

  async verify(accessToken: string): Promise<Verified> {
    const [t] = await this.db.query<{ workspace_id: string; client_id: string; expires: number; revoked: boolean }>(
      "SELECT workspace_id, client_id, expires, revoked FROM tokens WHERE hash = $1 AND kind = 'access'", [hash(accessToken)]);
    if (!t) return { ok: false, error: "invalid" };
    if (t.revoked) return { ok: false, error: "revoked" };
    if (this.now() > t.expires) return { ok: false, error: "expired" };
    await this.db.query("UPDATE approvals SET last_used = $3 WHERE workspace_id = $1 AND client_id = $2", [t.workspace_id, t.client_id, this.now()]);
    return { ok: true, workspaceId: t.workspace_id, clientId: t.client_id };
  }

  // RFC 7009: unknown tokens are not an error
  async revokeToken(value: string): Promise<void> {
    await this.db.query("DELETE FROM tokens WHERE hash = $1", [hash(value)]);
  }

  // ---- approvals

  async revokeApproval(ws: string, clientId: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      const r = await q.query("UPDATE approvals SET revoked_at = $3 WHERE workspace_id = $1 AND client_id = $2 AND revoked_at IS NULL RETURNING client_id",
        [ws, clientId, this.now()]);
      // Kept (flagged) so the client is told why
      await q.query("UPDATE tokens SET revoked = true WHERE workspace_id = $1 AND client_id = $2", [ws, clientId]);
      return r.length > 0;
    });
  }

  async approvals(ws: string): Promise<ApprovedAgent[]> {
    const rows = await this.db.query<{ client_id: string; name: string | null; version: string | null; approved_at: number; last_used: number | null }>(
      `SELECT a.client_id, c.name, c.version, a.approved_at, a.last_used FROM approvals a JOIN oauth_clients c ON c.id = a.client_id
       WHERE a.workspace_id = $1 AND a.revoked_at IS NULL ORDER BY COALESCE(a.last_used, a.approved_at) DESC`, [ws]);
    return rows.map((r) => ({ clientId: r.client_id, name: r.name ?? "Unknown agent", version: r.version, approvedAt: r.approved_at, lastUsed: r.last_used }));
  }

  async deniedToday(ws: string): Promise<{ name: string; at: number }[]> {
    const rows = await this.db.query<{ name: string | null; decided_at: number }>(
      `SELECT c.name, r.decided_at FROM auth_requests r JOIN oauth_clients c ON c.id = r.client_id
       WHERE r.workspace_id = $1 AND r.status = 'denied' AND r.decided_at > $2 ORDER BY r.decided_at DESC`, [ws, this.now() - DAY]);
    return rows.map((r) => ({ name: r.name ?? "Unknown agent", at: r.decided_at }));
  }

  // Drops expired tokens and old requests
  async sweep(): Promise<void> {
    const now = this.now();
    await this.db.query("DELETE FROM tokens WHERE expires < $1", [now]);
    await this.db.query("DELETE FROM auth_requests WHERE created < $1", [now - DAY]);
  }
}
