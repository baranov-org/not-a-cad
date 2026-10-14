import { describe, expect, it } from "vitest";
import { emptyModel, newSessionId } from "shared";
import { migrate } from "../src/db";
import { Store } from "../src/store";
import { ShareStore } from "../src/shareStore";
import { testDb } from "./db";

const WS = () => newSessionId();

describe("migrations", () => {
  it("are idempotent", async () => {
    const db = await testDb();
    await migrate(db);
    const rows = await db.query<{ version: number }>("SELECT version FROM schema_migrations");
    expect(rows.map((r) => r.version)).toEqual([1]);
  });
});

describe("Store: workspaces and projects", () => {
  it("creates, lists, renames, duplicates, gets models", async () => {
    const s = new Store(await testDb());
    const ws = WS();
    const a = await s.createProject(ws, { name: "Bracket" });
    if (!a.ok) throw new Error(a.error);
    const b = await s.createProject(ws);
    if (!b.ok) throw new Error(b.error);
    expect((await s.listProjects(ws)).map((p) => p.name).sort()).toEqual(["Bracket", "Untitled"]);
    expect((await s.rename(ws, a.id, "Wall bracket")).ok).toBe(true);
    expect((await s.project(ws, a.id))?.name).toBe("Wall bracket");
    const d = await s.duplicate(ws, a.id);
    expect(d.ok && (await s.project(ws, d.id))?.name).toBe("Wall bracket copy");
    expect(await s.getModel(ws, a.id)).toEqual({ ...emptyModel(), info: { name: "Wall bracket" } });
    // Another workspace can't see or touch it
    const other = WS();
    expect(await s.project(other, a.id)).toBeUndefined();
    expect((await s.rename(other, a.id, "x")).ok).toBe(false);
  });

  it("applies changes and enforces size limits", async () => {
    const s = new Store(await testDb(), { maxBytes: 600 });
    const ws = WS();
    const p = await s.createProject(ws);
    if (!p.ok) throw new Error();
    expect((await s.apply(ws, p.id, { upsert: [{ name: "a", source: "x" }] })).ok).toBe(true);
    const big = await s.apply(ws, p.id, { upsert: [{ name: "b", source: "x".repeat(700) }] });
    expect(big.ok).toBe(false);
    expect((await s.getModel(ws, p.id))?.parts).toEqual({ a: "x" });
    expect(await s.checkSize(ws, p.id, { upsert: [{ name: "b", source: "x".repeat(700) }] })).toMatch(/limit/);
  });

  it("caps projects per workspace, workspaces and total size", async () => {
    const s = new Store(await testDb(), { maxProjects: 2, maxWorkspaces: 1, maxTotalBytes: 1000 });
    const ws = WS();
    expect((await s.createProject(ws)).ok).toBe(true);
    expect((await s.createProject(ws)).ok).toBe(true);
    const third = await s.createProject(ws);
    expect(!third.ok && third.error).toMatch(/maximum of 2/);
    expect((await s.createProject(WS())).ok).toBe(false); // workspace cap
    const [p] = await s.listProjects(ws);
    const r = await s.apply(ws, p.id, { upsert: [{ name: "a", source: "x".repeat(900) }] });
    expect(!r.ok && r.error).toMatch(/storage is full/);
  });

  it("soft delete, restore, purge after the grace period", async () => {
    let now = 1000;
    const s = new Store(await testDb(), { now: () => now, purgeAfterMs: 60_000 });
    const ws = WS();
    const p = await s.createProject(ws);
    if (!p.ok) throw new Error();
    expect(await s.softDelete(ws, p.id)).toBe(true);
    expect(await s.listProjects(ws)).toHaveLength(0);
    expect(await s.restore(ws, p.id)).toBe(true);
    expect(await s.listProjects(ws)).toHaveLength(1);
    await s.softDelete(ws, p.id);
    now += 30_000;
    expect((await s.sweep()).projects).toEqual([]);
    now += 31_000;
    expect((await s.sweep()).projects).toEqual([p.id]);
    expect(await s.restore(ws, p.id)).toBe(false);
  });

  it("marks agent changes only when the user wasn't viewing", async () => {
    let now = 1000;
    const s = new Store(await testDb(), { now: () => now });
    const ws = WS();
    const p = await s.createProject(ws);
    if (!p.ok) throw new Error();
    now += 10;
    await s.apply(ws, p.id, { upsert: [{ name: "a", source: "x" }] }, { byAgent: true, userViewing: true });
    expect((await s.project(ws, p.id))?.changedByAgent).toBe(false);
    now += 10;
    await s.apply(ws, p.id, { upsert: [{ name: "a", source: "y" }] }, { byAgent: true, userViewing: false });
    expect((await s.project(ws, p.id))?.changedByAgent).toBe(true);
    now += 10;
    await s.markSeen(ws, p.id);
    expect((await s.project(ws, p.id))?.changedByAgent).toBe(false);
  });

  it("active project, thumbnails, workspace expiry", async () => {
    let now = 1000;
    const s = new Store(await testDb(), { now: () => now, retentionMs: 1000 });
    const ws = WS();
    const p = await s.createProject(ws);
    if (!p.ok) throw new Error();
    await s.setActive(ws, p.id);
    expect(await s.activeProject(ws)).toBe(p.id);
    expect((await s.setThumb(ws, p.id, Buffer.alloc(200 * 1024), "image/png")).ok).toBe(false);
    expect((await s.setThumb(ws, p.id, Buffer.from("png!"), "image/png")).ok).toBe(true);
    expect((await s.thumb(ws, p.id))?.data.toString()).toBe("png!");
    expect((await s.project(ws, p.id))?.thumbAt).toBeTruthy();
    now += 2000;
    expect((await s.sweep()).workspaces).toBe(1);
    expect(await s.listProjects(ws)).toHaveLength(0);
  });
});

describe("ShareStore per project", () => {
  it("publish, republish keeps id, unpublish, caps, expiry", async () => {
    let now = 0;
    const db = await testDb();
    const shares = new ShareStore(db, { now: () => now, maxShares: 1 });
    const m = { ...emptyModel(), parts: { p: "x" }, info: { name: "N" } };
    const a = await shares.publish("proj-a", m);
    if (!a.ok) throw new Error();
    const a2 = await shares.publish("proj-a", { ...m, parts: { p: "y" } });
    expect(a2.ok && a2.id).toBe(a.id);
    expect((await shares.get(a.id))?.model.parts).toEqual({ p: "y" });
    expect((await shares.byProject("proj-a"))?.id).toBe(a.id);
    expect([...(await shares.sharedProjects(["proj-a", "proj-b"]))]).toEqual(["proj-a"]);
    const b = await shares.publish("proj-b", m);
    expect(!b.ok && b.error).toMatch(/share limit/);
    expect(await shares.unpublish("proj-a")).toBe(a.id);
    expect(await shares.get(a.id)).toBeUndefined();
    const c = await shares.publish("proj-c", m);
    now = 91 * 86400_000;
    expect(await shares.sweep()).toBe(1);
    expect(c.ok && (await shares.get(c.id))).toBeUndefined();
  });
});
