import { Model, newSessionId } from "shared";
import type { Db } from "./db";

export interface ShareStoreOptions {
  maxBytes?: number;
  maxShares?: number;
  maxTotalBytes?: number;
  retentionMs?: number;
  now?: () => number;
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Published snapshots; one per project, independent of the project row
export class ShareStore {
  readonly maxBytes: number;
  readonly maxShares: number;
  readonly maxTotalBytes: number;
  readonly retentionMs: number;
  private now: () => number;

  constructor(private db: Db, opts: ShareStoreOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 1_000_000;
    this.maxShares = opts.maxShares ?? 2000;
    this.maxTotalBytes = opts.maxTotalBytes ?? 200_000_000;
    this.retentionMs = opts.retentionMs ?? 90 * DAY;
    this.now = opts.now ?? Date.now;
  }

  async byProject(projectId: string): Promise<{ id: string; updated: number } | undefined> {
    const [r] = await this.db.query<{ id: string; updated: number }>("SELECT id, updated FROM shares WHERE project_id = $1", [projectId]);
    return r;
  }

  // Shared project ids among the given ones (library badges)
  async sharedProjects(projectIds: string[]): Promise<Set<string>> {
    if (!projectIds.length) return new Set();
    const rows = await this.db.query<{ project_id: string }>("SELECT project_id FROM shares WHERE project_id = ANY($1)", [projectIds]);
    return new Set(rows.map((r) => r.project_id));
  }

  // Snapshot by share id; bumps last_seen at most hourly
  async get(id: string): Promise<{ model: Model; updated: number; previewAt: number | null } | undefined> {
    const [r] = await this.db.query<{ model: Model; updated: number; last_seen: number; preview_at: number | null }>(
      "SELECT model, updated, last_seen, preview_at FROM shares WHERE id = $1", [id]);
    if (!r) return;
    const now = this.now();
    if (now - r.last_seen > HOUR) await this.db.query("UPDATE shares SET last_seen = $2 WHERE id = $1", [id, now]);
    return { model: Model.parse(r.model), updated: r.updated, previewAt: r.preview_at };
  }

  // Social preview for a share version; refused when the share was republished since
  async setPreview(id: string, version: number, data: Buffer, type: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      "UPDATE shares SET preview = $3, preview_type = $4, preview_at = $2 WHERE id = $1 AND updated = $2 RETURNING id",
      [id, version, data, type]);
    return rows.length > 0;
  }

  async preview(id: string): Promise<{ data: Buffer; type: string; at: number } | undefined> {
    const [r] = await this.db.query<{ preview: Uint8Array | null; preview_type: string; preview_at: number }>(
      "SELECT preview, preview_type, preview_at FROM shares WHERE id = $1", [id]);
    return r?.preview ? { data: Buffer.from(r.preview), type: r.preview_type, at: r.preview_at } : undefined;
  }

  // Create or update the project's share, keeping its id
  async publish(projectId: string, model: Model): Promise<{ ok: true; id: string; updated: number } | { ok: false; error: string }> {
    const json = JSON.stringify(model);
    const size = Buffer.byteLength(json);
    if (size > this.maxBytes) return { ok: false, error: `Share would exceed the ${this.maxBytes} byte limit (${size} bytes)` };
    return this.db.tx(async (q) => {
      const [existing] = await q.query<{ id: string; size: number }>("SELECT id, size FROM shares WHERE project_id = $1 FOR UPDATE", [projectId]);
      const [{ n, total }] = await q.query<{ n: number; total: number }>(
        "SELECT COUNT(*)::int AS n, COALESCE(SUM(size), 0)::float8 AS total FROM shares");
      if (!existing && n >= this.maxShares) return { ok: false, error: "Server is at its share limit; try again later" };
      if (total - (existing?.size ?? 0) + size > this.maxTotalBytes) return { ok: false, error: "Server storage is full; try again later" };
      const id = existing?.id ?? newSessionId();
      const now = this.now();
      await q.query(
        `INSERT INTO shares (id, project_id, model, size, updated, last_seen) VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (project_id) DO UPDATE SET model = excluded.model, size = excluded.size, updated = excluded.updated`,
        [id, projectId, json, size, now]);
      return { ok: true as const, id, updated: now };
    });
  }

  // Returns the removed share id
  async unpublish(projectId: string): Promise<string | undefined> {
    const [r] = await this.db.query<{ id: string }>("DELETE FROM shares WHERE project_id = $1 RETURNING id", [projectId]);
    return r?.id;
  }

  // Deletes shares neither viewed nor republished within retention
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.retentionMs;
    return (await this.db.query("DELETE FROM shares WHERE GREATEST(updated, last_seen) < $1 RETURNING id", [cutoff])).length;
  }
}
