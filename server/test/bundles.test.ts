import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { emptyModel } from "shared";
import { BundleStore } from "../src/bundles";
import { ShareStore } from "../src/shareStore";
import { testDb } from "./db";
import { seed, startServer } from "./helpers";

const tmp = () => mkdtempSync(join(tmpdir(), "cad-bundles-"));
const model = { ...emptyModel(), parts: { p: "x" }, info: { name: "N" } };

describe("BundleStore", () => {
  it("stores per version, evicts least recently seen, sweeps orphans", async () => {
    let now = 0;
    const db = await testDb();
    const shares = new ShareStore(db, { now: () => now });
    const bundles = new BundleStore(db, tmp(), { maxTotalBytes: 2000, now: () => now });
    const a = await shares.publish("a".repeat(22), model);
    const b = await shares.publish("b".repeat(22), model);
    if (!a.ok || !b.ok) throw new Error("publish");
    const rand = (n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256)));
    expect((await bundles.put(a.id, a.updated, rand(900))).ok).toBe(true);
    now = 10;
    expect((await bundles.put(b.id, b.updated, rand(900))).ok).toBe(true);
    now = 15;
    expect(gunzipSync((await bundles.get(a.id, a.updated))!).length).toBe(900); // a viewed now -> most recent
    expect(await bundles.get(a.id, a.updated + 1)).toBeUndefined(); // other version
    now = 20;
    const c = await shares.publish("c".repeat(22), model);
    if (!c.ok) throw new Error("publish");
    expect((await bundles.put(c.id, c.updated, rand(900))).ok).toBe(true);
    expect(await bundles.get(b.id, b.updated)).toBeUndefined(); // evicted (least recently seen)
    expect(await bundles.get(a.id, a.updated)).toBeDefined();
    // Republish makes the old bundle an orphan
    now = 30;
    await shares.publish("a".repeat(22), { ...model, parts: { p: "y" } });
    expect(await bundles.sweep()).toBe(1);
    expect(await bundles.get(c.id, c.updated)).toBeDefined();
    await db.close();
  });

  it("rejects bundles over the per-bundle limit", async () => {
    const db = await testDb();
    const bundles = new BundleStore(db, tmp(), { maxBytes: 100 });
    const r = await bundles.put("x".repeat(22), 1, Buffer.alloc(101));
    expect(r.ok).toBe(false);
    await db.close();
  });
});

describe("bundle routes", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  afterEach(async () => srv?.app.close());

  const put = (share: string, version: number | string, body: Buffer) =>
    fetch(`${share}/meshes?version=${version}`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(body),
    });

  it("upload for current version, serve gzip immutable, 409 on stale, delete on unpublish", async () => {
    srv = await startServer({ bundleDir: tmp() });
    const { ws, pid } = await seed(srv.store);
    const sid = `${srv.base}/api/w/${ws}/projects/${pid}/share`;
    expect((await put(sid, 1, Buffer.from("x"))).status).toBe(404); // not published
    const pub = await (await fetch(sid, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(model),
    })).json();
    const version = pub.updatedAt;
    expect((await put(sid, version - 1, Buffer.from("x"))).status).toBe(409);
    expect((await put(sid, version, Buffer.from("hello bundle"))).status).toBe(200);
    const r = await fetch(`${srv.base}/api/shares/${pub.id}/meshes?v=${version}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBe("gzip");
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("hello bundle"); // fetch decodes gzip
    expect((await fetch(`${srv.base}/api/shares/${pub.id}/meshes?v=${version + 1}`)).status).toBe(404);
    await fetch(sid, { method: "DELETE" });
    expect(await srv.bundles.get(pub.id, version)).toBeUndefined();
  });
});
