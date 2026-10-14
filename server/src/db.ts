import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

// Minimal async SQL interface over node-postgres (production) or PGlite (tests, local dev)
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  // Runs fn in one transaction on a single connection
  tx<T>(fn: (q: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// int8/numeric come back as strings from node-postgres; we only store values that fit in a double
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

// Handle for an open transaction; nested tx() reuses it
function inTx(query: Db["query"]): Db {
  const h: Db = { query, tx: (f) => f(h), close: async () => {} };
  return h;
}

export function pgDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const wrap = (c: pg.Pool | pg.PoolClient): Db["query"] =>
    async (sql, params) => (await c.query(sql, params as unknown[])).rows;
  return {
    query: wrap(pool),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const r = await fn(inTx(wrap(c)));
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

// In-process Postgres; dataDir undefined = in memory; loadDataDir clones a dump (tests)
export async function pgliteDb(dataDir?: string, loadDataDir?: Blob): Promise<Db & { dump(): Promise<Blob> }> {
  const db = await PGlite.create(dataDir, loadDataDir ? { loadDataDir } : undefined);
  const query: Db["query"] = async (sql, params) =>
    (await db.query(sql, params as unknown[])).rows as never;
  let chain = Promise.resolve();
  return {
    query,
    // PGlite is single-connection: serialise transactions
    tx(fn) {
      const run = chain.then(() =>
        db.transaction(async (t) =>
          fn(inTx(async (sql, params) => (await t.query(sql, params as unknown[])).rows as never)),
        ),
      );
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
    close: () => db.close(),
    dump: async () => (await db.dumpDataDir("none")) as Blob,
  };
}

export async function openDb(url: string | undefined, pgliteDir?: string): Promise<Db> {
  return url ? pgDb(url) : pgliteDb(pgliteDir);
}

// Numbered migrations, applied once each under an advisory lock; 1 is the initial schema
const MIGRATIONS: string[] = [
  `CREATE TABLE workspaces (
     id text PRIMARY KEY,
     created double precision NOT NULL,
     last_seen double precision NOT NULL,
     active_project text,
     settings jsonb NOT NULL DEFAULT '{}'
   );
   CREATE TABLE projects (
     id text PRIMARY KEY,
     workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     model jsonb NOT NULL,
     size integer NOT NULL,
     created double precision NOT NULL,
     updated double precision NOT NULL,
     seen_at double precision NOT NULL DEFAULT 0,
     agent_changed_at double precision NOT NULL DEFAULT 0,
     forked_from_share text,
     deleted_at double precision,
     thumb bytea,
     thumb_type text,
     thumb_at double precision
   );
   CREATE INDEX projects_workspace ON projects(workspace_id);
   CREATE TABLE shares (
     id text PRIMARY KEY,
     project_id text NOT NULL UNIQUE,
     model jsonb NOT NULL,
     size integer NOT NULL,
     updated double precision NOT NULL,
     last_seen double precision NOT NULL,
     preview bytea,
     preview_type text,
     preview_at double precision
   );
   CREATE TABLE bundles (
     share_id text PRIMARY KEY,
     version double precision NOT NULL,
     size integer NOT NULL,
     last_seen double precision NOT NULL
   );
   CREATE TABLE oauth_clients (
     id text PRIMARY KEY,
     name text,
     version text,
     redirect_uris jsonb NOT NULL,
     country text,
     created double precision NOT NULL
   );
   CREATE TABLE auth_requests (
     id text PRIMARY KEY,
     client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
     redirect_uri text NOT NULL,
     code_challenge text NOT NULL,
     state text,
     resource text,
     country text,
     created double precision NOT NULL,
     status text NOT NULL DEFAULT 'pending',
     workspace_id text,
     decided_at double precision,
     code_hash text,
     code_expires double precision,
     code_used boolean NOT NULL DEFAULT false
   );
   CREATE UNIQUE INDEX auth_requests_code ON auth_requests(code_hash);
   CREATE TABLE approvals (
     workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
     approved_at double precision NOT NULL,
     last_used double precision,
     revoked_at double precision,
     PRIMARY KEY (workspace_id, client_id)
   );
   CREATE TABLE tokens (
     hash text PRIMARY KEY,
     kind text NOT NULL,
     workspace_id text NOT NULL,
     client_id text NOT NULL,
     expires double precision NOT NULL,
     revoked boolean NOT NULL DEFAULT false
   );
   CREATE INDEX tokens_grant ON tokens(workspace_id, client_id);
   CREATE TABLE activity (
     id bigserial PRIMARY KEY,
     workspace_id text NOT NULL,
     project_id text NOT NULL,
     at double precision NOT NULL,
     who text NOT NULL,
     verb text NOT NULL,
     object text,
     detail text
   );
   CREATE INDEX activity_project ON activity(project_id, id DESC);`,
];

export async function migrate(db: Db): Promise<void> {
  await db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(4242001)");
    await q.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied double precision NOT NULL)");
    const done = new Set((await q.query<{ version: number }>("SELECT version FROM schema_migrations")).map((r) => r.version));
    for (let i = 0; i < MIGRATIONS.length; i++) {
      if (done.has(i + 1)) continue;
      for (const stmt of MIGRATIONS[i].split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await q.query(stmt);
      await q.query("INSERT INTO schema_migrations (version, applied) VALUES ($1, $2)", [i + 1, Date.now()]);
    }
  });
}
