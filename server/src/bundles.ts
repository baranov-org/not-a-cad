import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Db } from "./db";

export interface BundleStoreOptions {
  maxBytes?: number; // per bundle, uncompressed upload
  maxTotalBytes?: number; // all stored (compressed) bundles
  now?: () => number;
}

// Prebuilt share meshes on disk (gzip), a cache: evicted by least recent view
export class BundleStore {
  readonly maxBytes: number;
  readonly maxTotalBytes: number;
  private now: () => number;

  constructor(private db: Db, private dir: string | undefined, opts: BundleStoreOptions = {}) {
    if (dir) mkdirSync(dir, { recursive: true });
    this.maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
    this.maxTotalBytes = opts.maxTotalBytes ?? 500 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
  }

  private file(shareId: string) {
    return join(this.dir!, `${shareId}.bin.gz`);
  }

  async put(shareId: string, version: number, raw: Buffer): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (!this.dir) return { ok: false, status: 503, error: "Bundle storage is not configured" };
    if (raw.length > this.maxBytes) return { ok: false, status: 413, error: `Bundle exceeds ${this.maxBytes} bytes` };
    const gz = gzipSync(raw, { level: 6 });
    if (gz.length > this.maxTotalBytes) return { ok: false, status: 413, error: "Bundle too large to store" };
    await this.delete(shareId);
    // Evict least recently seen bundles until it fits
    const rows = await this.db.query<{ share_id: string; size: number }>("SELECT share_id, size FROM bundles ORDER BY last_seen ASC");
    let total = rows.reduce((s, r) => s + r.size, 0);
    for (const r of rows) {
      if (total + gz.length <= this.maxTotalBytes) break;
      await this.delete(r.share_id);
      total -= r.size;
    }
    writeFileSync(this.file(shareId), gz);
    await this.db.query("INSERT INTO bundles (share_id, version, size, last_seen) VALUES ($1, $2, $3, $4)", [shareId, version, gz.length, this.now()]);
    return { ok: true };
  }

  // Compressed bundle when it exists for this version
  async get(shareId: string, version: number): Promise<Buffer | undefined> {
    const [row] = await this.db.query<{ version: number }>("SELECT version FROM bundles WHERE share_id = $1", [shareId]);
    if (!this.dir || !row || row.version !== version) return;
    try {
      const data = readFileSync(this.file(shareId));
      await this.db.query("UPDATE bundles SET last_seen = $2 WHERE share_id = $1", [shareId, this.now()]);
      return data;
    } catch {
      await this.delete(shareId);
    }
  }

  async delete(shareId: string): Promise<void> {
    await this.db.query("DELETE FROM bundles WHERE share_id = $1", [shareId]);
    if (this.dir) rmSync(this.file(shareId), { force: true });
  }

  // Remove bundles whose share is gone or was republished without a new bundle
  async sweep(): Promise<number> {
    const orphans = await this.db.query<{ id: string }>(
      `SELECT b.share_id AS id FROM bundles b LEFT JOIN shares s ON s.id = b.share_id
       WHERE s.id IS NULL OR s.updated <> b.version`);
    for (const o of orphans) await this.delete(o.id);
    return orphans.length;
  }
}
