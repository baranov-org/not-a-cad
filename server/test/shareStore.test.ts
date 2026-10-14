import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyModel, type Model } from "shared";
import { BundleStore } from "../src/bundles";
import { ShareStore } from "../src/shareStore";
import { Store } from "../src/store";
import { sweepAll } from "../src/sweep";
import { testDb } from "./db";
import { seed } from "./helpers";

const S1 = "a".repeat(22);
const S2 = "b".repeat(22);
const model = (src: string, name = "Thing"): Model => ({ ...emptyModel(), parts: { p: src }, info: { name } });
const DAY = 86400_000;

describe("ShareStore", () => {
  it("publishes, republishes in place, unpublishes", async () => {
    const shares = new ShareStore(await testDb());
    const a = await shares.publish(S1, model("v1"));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.id).not.toBe(S1);
    expect((await shares.get(a.id))?.model.parts).toEqual({ p: "v1" });
    const b = await shares.publish(S1, model("v2"));
    expect(b.ok && b.id).toBe(a.id);
    expect((await shares.get(a.id))?.model.parts).toEqual({ p: "v2" });
    expect((await shares.byProject(S1))?.id).toBe(a.id);
    // Share id is not a project key
    expect(await shares.unpublish(a.id)).toBeUndefined();
    expect(await shares.unpublish(S1)).toBe(a.id);
    expect(await shares.get(a.id)).toBeUndefined();
  });

  it("enforces size, count and total caps without touching the previous share", async () => {
    const shares = new ShareStore(await testDb(), { maxBytes: 600, maxShares: 1, maxTotalBytes: 1000 });
    const a = await shares.publish(S1, model("x"));
    expect(a.ok).toBe(true);
    const big = await shares.publish(S1, model("x".repeat(700)));
    expect(big.ok).toBe(false);
    expect(a.ok && (await shares.get(a.id))?.model.parts).toEqual({ p: "x" });
    const second = await shares.publish(S2, model("y"));
    expect(!second.ok && second.error).toMatch(/share limit/);
  });

  it("expires after 90 days without views or republish; views keep it alive", async () => {
    let now = 0;
    const shares = new ShareStore(await testDb(), { now: () => now });
    const a = await shares.publish(S1, model("x"));
    const b = await shares.publish(S2, model("y"));
    if (!a.ok || !b.ok) throw new Error("publish failed");
    now = 80 * DAY;
    await shares.get(b.id); // viewed
    now = 91 * DAY;
    expect(await shares.sweep()).toBe(1);
    expect(await shares.get(a.id)).toBeUndefined();
    expect(await shares.get(b.id)).toBeDefined();
  });
});

describe("sweepAll", () => {
  it("purging a deleted project unpublishes its share; workspace expiry keeps shares", async () => {
    let now = 1;
    const db = await testDb();
    const store = new Store(db, { now: () => now, retentionMs: 30 * DAY });
    const shares = new ShareStore(db, { now: () => now });
    const bundles = new BundleStore(db, mkdtempSync(join(tmpdir(), "cad-sweep-")), { now: () => now });
    const a = await seed(store);
    const b = await seed(store);
    const sa = await shares.publish(a.pid, model("x"));
    const sb = await shares.publish(b.pid, model("y"));
    if (!sa.ok || !sb.ok) throw new Error("publish");
    await bundles.put(sa.id, sa.updated, Buffer.from("mesh"));

    await store.softDelete(a.ws, a.pid);
    now += 10_000;
    // Within the undo window nothing is purged
    expect((await sweepAll(store, shares, bundles)).projects).toBe(0);
    expect(await shares.get(sa.id)).toBeDefined();
    now += 60_000;
    await store.touch(a.ws);
    expect((await sweepAll(store, shares, bundles)).projects).toBe(1);
    expect(await shares.get(sa.id)).toBeUndefined();
    expect(await bundles.get(sa.id, sa.updated)).toBeUndefined();

    // b's workspace expires; its share stays
    now += 31 * DAY;
    await shares.get(sb.id);
    const r = await sweepAll(store, shares, bundles);
    expect(r.workspaces).toBe(2);
    expect(await shares.get(sb.id)).toBeDefined();
    await db.close();
  });
});
