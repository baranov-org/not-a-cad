import { applyChanges, emptyModel, Model, newSessionId, type Changes } from "shared";
import type { Db } from "./db";

export interface StoreOptions {
  maxBytes?: number; // per project
  maxProjects?: number; // per workspace
  maxWorkspaces?: number;
  maxTotalBytes?: number;
  retentionMs?: number; // workspace inactivity
  purgeAfterMs?: number; // soft-deleted projects
  now?: () => number;
}

export interface ProjectRow {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  created: number;
  updated: number;
  thumbAt: number | null;
  forkedFromShare: string | null;
  changedByAgent: boolean;
  deleted: boolean;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };

const DAY = 24 * 60 * 60 * 1000;
export const THUMB_MAX = 100 * 1024;

interface Raw {
  id: string;
  workspace_id: string;
  model: Model;
  created: number;
  updated: number;
  seen_at: number;
  agent_changed_at: number;
  forked_from_share: string | null;
  deleted_at: number | null;
  thumb_at: number | null;
}

const COLS = `id, workspace_id, model, created, updated, seen_at, agent_changed_at, forked_from_share, deleted_at, thumb_at`;

const row = (r: Raw): ProjectRow => {
  const m = Model.parse(r.model);
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: m.info.name ?? "Untitled",
    description: m.info.description,
    created: r.created,
    updated: r.updated,
    thumbAt: r.thumb_at,
    forkedFromShare: r.forked_from_share,
    changedByAgent: r.agent_changed_at > r.seen_at,
    deleted: r.deleted_at !== null,
  };
};

// Workspaces and their projects (model sources only, no geometry)
export class Store {
  readonly maxBytes: number;
  readonly maxProjects: number;
  readonly maxWorkspaces: number;
  readonly maxTotalBytes: number;
  readonly retentionMs: number;
  readonly purgeAfterMs: number;
  private now: () => number;

  constructor(readonly db: Db, opts: StoreOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 1_000_000;
    this.maxProjects = opts.maxProjects ?? 200;
    this.maxWorkspaces = opts.maxWorkspaces ?? 2000;
    this.maxTotalBytes = opts.maxTotalBytes ?? 200_000_000;
    this.retentionMs = opts.retentionMs ?? 180 * DAY;
    this.purgeAfterMs = opts.purgeAfterMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  static sizeOf(m: Model): number {
    return Buffer.byteLength(JSON.stringify(m));
  }

  // ---- workspaces

  // Existing workspace, or a new one with this id (well-formed ids only reach here)
  async ensureWorkspace(id: string): Promise<Result> {
    const [w] = await this.db.query("SELECT id FROM workspaces WHERE id = $1", [id]);
    if (w) return { ok: true };
    const [{ n }] = await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM workspaces");
    if (n >= this.maxWorkspaces) return { ok: false, status: 503, error: "Server is at its workspace limit; try again later" };
    const t = this.now();
    await this.db.query("INSERT INTO workspaces (id, created, last_seen) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING", [id, t]);
    return { ok: true };
  }

  async createWorkspace(): Promise<Result<{ id: string }>> {
    const id = newSessionId();
    const r = await this.ensureWorkspace(id);
    return r.ok ? { ok: true, id } : r;
  }

  async workspaceExists(id: string): Promise<boolean> {
    return (await this.db.query("SELECT 1 FROM workspaces WHERE id = $1", [id])).length > 0;
  }

  async touch(ws: string): Promise<void> {
    await this.db.query("UPDATE workspaces SET last_seen = $2 WHERE id = $1", [ws, this.now()]);
  }

  async activeProject(ws: string): Promise<string | undefined> {
    const [r] = await this.db.query<{ active_project: string | null }>(
      `SELECT w.active_project FROM workspaces w JOIN projects p ON p.id = w.active_project AND p.deleted_at IS NULL
       WHERE w.id = $1`, [ws]);
    return r?.active_project ?? undefined;
  }

  async setActive(ws: string, pid: string): Promise<void> {
    await this.db.query("UPDATE workspaces SET active_project = $2, last_seen = $3 WHERE id = $1", [ws, pid, this.now()]);
  }

  // ---- projects

  async listProjects(ws: string): Promise<ProjectRow[]> {
    const rows = await this.db.query<Raw>(
      `SELECT ${COLS} FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY updated DESC`, [ws]);
    return rows.map(row);
  }

  async project(ws: string, pid: string): Promise<ProjectRow | undefined> {
    const [r] = await this.db.query<Raw>(`SELECT ${COLS} FROM projects WHERE id = $1 AND workspace_id = $2`, [pid, ws]);
    return r && !r.deleted_at ? row(r) : undefined;
  }

  async createProject(ws: string, init: { name?: string; model?: Model; forkedFromShare?: string } = {}): Promise<Result<{ id: string }>> {
    const ensured = await this.ensureWorkspace(ws);
    if (!ensured.ok) return ensured;
    const model = init.model ?? emptyModel();
    if (init.name) model.info = { ...model.info, name: init.name };
    const size = Store.sizeOf(model);
    const limit = await this.checkNew(ws, size);
    if (limit) return limit;
    const id = newSessionId();
    const t = this.now();
    await this.db.query(
      `INSERT INTO projects (id, workspace_id, model, size, created, updated, seen_at, forked_from_share)
       VALUES ($1, $2, $3, $4, $5, $5, $5, $6)`,
      [id, ws, JSON.stringify(model), size, t, init.forkedFromShare ?? null]);
    return { ok: true, id };
  }

  private async checkNew(ws: string, size: number): Promise<Extract<Result, { ok: false }> | undefined> {
    if (size > this.maxBytes) return { ok: false, status: 413, error: `Project would exceed the ${this.maxBytes} byte limit (${size} bytes)` };
    const [{ n }] = await this.db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL", [ws]);
    if (n >= this.maxProjects) return { ok: false, status: 409, error: `This workspace has the maximum of ${this.maxProjects} projects` };
    const [{ total }] = await this.db.query<{ total: number }>("SELECT COALESCE(SUM(size), 0)::float8 AS total FROM projects");
    if (total + size > this.maxTotalBytes) return { ok: false, status: 503, error: "Server storage is full; try again later" };
  }

  async getModel(ws: string, pid: string): Promise<Model | undefined> {
    const [r] = await this.db.query<{ model: Model }>(
      "SELECT model FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL", [pid, ws]);
    return r ? Model.parse(r.model) : undefined;
  }

  // Error message if the changes would exceed a size limit
  async checkSize(ws: string, pid: string, ch: Changes, q: Pick<Db, "query"> = this.db): Promise<string | undefined> {
    const [r] = await q.query<{ model: Model; size: number }>(
      "SELECT model, size FROM projects WHERE id = $1 AND workspace_id = $2", [pid, ws]);
    if (!r) return "Unknown project";
    const size = Store.sizeOf(applyChanges(Model.parse(r.model), ch));
    if (size > this.maxBytes) return `Project model would exceed the ${this.maxBytes} byte limit (${size} bytes)`;
    const [{ total }] = await q.query<{ total: number }>("SELECT COALESCE(SUM(size), 0)::float8 AS total FROM projects");
    if (total - r.size + size > this.maxTotalBytes) return "Server storage is full; try again later";
  }

  // byAgent marks the project as changed by an agent unless the user is looking at it
  async apply(ws: string, pid: string, ch: Changes, opts: { byAgent?: boolean; userViewing?: boolean } = {}): Promise<Result<{ model: Model }>> {
    return this.db.tx(async (q) => {
      const [r] = await q.query<{ model: Model }>(
        "SELECT model FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE", [pid, ws]);
      if (!r) return { ok: false, status: 404, error: "Unknown project" };
      const err = await this.checkSize(ws, pid, ch, q);
      if (err) return { ok: false, status: 413, error: err };
      const model = applyChanges(Model.parse(r.model), ch);
      const json = JSON.stringify(model);
      const t = this.now();
      await q.query(
        `UPDATE projects SET model = $3, size = $4, updated = $5,
           agent_changed_at = CASE WHEN $6 THEN $5 ELSE agent_changed_at END,
           seen_at = CASE WHEN $7 THEN $5 ELSE seen_at END
         WHERE id = $1 AND workspace_id = $2`,
        [pid, ws, json, Buffer.byteLength(json), t, !!opts.byAgent, !!opts.userViewing]);
      await q.query("UPDATE workspaces SET last_seen = $2 WHERE id = $1", [ws, t]);
      return { ok: true, model };
    });
  }

  async markSeen(ws: string, pid: string): Promise<void> {
    await this.db.query("UPDATE projects SET seen_at = $3 WHERE id = $1 AND workspace_id = $2", [pid, ws, this.now()]);
  }

  async rename(ws: string, pid: string, name: string): Promise<Result> {
    const m = await this.getModel(ws, pid);
    if (!m) return { ok: false, status: 404, error: "Unknown project" };
    const r = await this.apply(ws, pid, { info: { ...m.info, name } });
    return r.ok ? { ok: true } : r;
  }

  async duplicate(ws: string, pid: string): Promise<Result<{ id: string }>> {
    const m = await this.getModel(ws, pid);
    if (!m) return { ok: false, status: 404, error: "Unknown project" };
    const name = `${m.info.name ?? "Untitled"} copy`.slice(0, 80);
    return this.createProject(ws, { model: { ...m, info: { ...m.info, name } } });
  }

  async softDelete(ws: string, pid: string): Promise<boolean> {
    const rows = await this.db.query(
      "UPDATE projects SET deleted_at = $3 WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL RETURNING id",
      [pid, ws, this.now()]);
    return rows.length > 0;
  }

  async restore(ws: string, pid: string): Promise<boolean> {
    const rows = await this.db.query(
      "UPDATE projects SET deleted_at = NULL WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NOT NULL RETURNING id",
      [pid, ws]);
    return rows.length > 0;
  }

  async setThumb(ws: string, pid: string, data: Buffer, type: string): Promise<Result> {
    if (data.length > THUMB_MAX) return { ok: false, status: 413, error: `Thumbnail exceeds ${THUMB_MAX} bytes` };
    const rows = await this.db.query(
      "UPDATE projects SET thumb = $3, thumb_type = $4, thumb_at = $5 WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL RETURNING id",
      [pid, ws, data, type, this.now()]);
    return rows.length ? { ok: true } : { ok: false, status: 404, error: "Unknown project" };
  }

  async thumb(ws: string, pid: string): Promise<{ data: Buffer; type: string } | undefined> {
    const [r] = await this.db.query<{ thumb: Uint8Array | null; thumb_type: string }>(
      "SELECT thumb, thumb_type FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL", [pid, ws]);
    return r?.thumb ? { data: Buffer.from(r.thumb), type: r.thumb_type } : undefined;
  }

  // Purges soft-deleted projects and expired workspaces; returns purged project ids (for unpublishing)
  async sweep(): Promise<{ projects: string[]; workspaces: number }> {
    const now = this.now();
    const purged = await this.db.query<{ id: string }>(
      "DELETE FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < $1 RETURNING id", [now - this.purgeAfterMs]);
    // Expired workspaces cascade to their projects but keep their shares; only deleted projects unpublish
    const ws = await this.db.query("DELETE FROM workspaces WHERE last_seen < $1 RETURNING id", [now - this.retentionMs]);
    return { projects: purged.map((r) => r.id), workspaces: ws.length };
  }
}
