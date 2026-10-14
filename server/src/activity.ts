import type { Db } from "./db";

export interface ActivityEntry {
  id: number;
  at: number;
  who: string;
  verb: string;
  object: string | null;
  detail: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

// Per-project log of agent tool calls and notable user actions
export class ActivityLog {
  constructor(
    private db: Db,
    private opts: { keep?: number; retentionMs?: number; now?: () => number } = {},
  ) {}

  private get now() {
    return (this.opts.now ?? Date.now)();
  }

  async add(ws: string, pid: string, e: { who: string; verb: string; object?: string; detail?: string }): Promise<void> {
    await this.db.query(
      "INSERT INTO activity (workspace_id, project_id, at, who, verb, object, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [ws, pid, this.now, e.who.slice(0, 100), e.verb.slice(0, 60), e.object?.slice(0, 200) ?? null, e.detail?.slice(0, 500) ?? null]);
  }

  // Newest first; before = id of the last entry already shown
  async list(ws: string, pid: string, before?: number, limit = 50): Promise<ActivityEntry[]> {
    return this.db.query<ActivityEntry>(
      `SELECT id::float8 AS id, at, who, verb, object, detail FROM activity
       WHERE workspace_id = $1 AND project_id = $2 AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
      [ws, pid, before ?? null, Math.min(Math.max(limit, 1), 200)]);
  }

  // Keeps the newest `keep` entries per project and nothing older than the retention period
  async sweep(): Promise<number> {
    const old = await this.db.query("DELETE FROM activity WHERE at < $1 RETURNING id", [this.now - (this.opts.retentionMs ?? 90 * DAY)]);
    const extra = await this.db.query(
      `DELETE FROM activity WHERE id IN (
         SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY id DESC) AS n FROM activity) t WHERE n > $1)
       RETURNING id`, [this.opts.keep ?? 500]);
    return old.length + extra.length;
  }
}
