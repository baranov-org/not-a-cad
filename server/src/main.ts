import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app";
import { migrate, openDb } from "./db";
import { limitsFromEnv } from "./limits";
import { Store } from "./store";
import { sweepAll } from "./sweep";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? resolve(here, "../../data");
mkdirSync(dataDir, { recursive: true });

// Postgres from DATABASE_URL; local dev falls back to PGlite on disk
const db = await openDb(process.env.DATABASE_URL, resolve(dataDir, "pglite"));
await migrate(db);

const limits = limitsFromEnv();
const store = new Store(db, {
  maxBytes: limits.maxSessionBytes,
  maxWorkspaces: limits.maxSessions,
  maxTotalBytes: limits.maxTotalBytes,
});
const { app, shares, bundles, auth, activity } = await buildApp({
  store,
  limits,
  bundleDir: process.env.BUNDLE_DIR ?? resolve(dataDir, "meshes"),
  webDist: process.env.WEB_DIST ?? resolve(here, "../../web/dist"),
  logger: true,
});

async function sweep() {
  const r = await sweepAll(store, shares, bundles, { auth, activity });
  if (r.projects || r.workspaces || r.shares || r.bundles) {
    app.log.info(`purged ${r.projects} projects, expired ${r.workspaces} workspaces, ${r.shares} shares, ${r.bundles} mesh bundles`);
  }
}
// Deleted projects are purged 60 s after delete (undo window), so sweep every minute
setInterval(() => void sweep().catch((e) => app.log.error(e)), 60_000).unref();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}

await app.listen({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? "0.0.0.0" });
