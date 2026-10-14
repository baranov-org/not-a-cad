import { describe, expect, it } from "vitest";
import { AuthStore, DENIED, hash, pkceChallenge, REVOKED } from "../src/auth";
import { ActivityLog } from "../src/activity";
import { Store } from "../src/store";
import { testDb } from "./db";

const VERIFIER = "v".repeat(50);

async function setup(now = { t: 1000 }) {
  const db = await testDb();
  const store = new Store(db);
  const auth = new AuthStore(db, { now: () => now.t });
  const ws = ((await store.createWorkspace()) as { id: string }).id;
  const clientId = await auth.registerClient({ name: "Claude Code", redirectUris: ["http://localhost:9/cb"] });
  const request = () => auth.createRequest({ clientId, redirectUri: "http://localhost:9/cb", codeChallenge: pkceChallenge(VERIFIER), state: "s1" });
  // Allowed request -> code
  const code = async () => {
    const id = await request();
    expect((await auth.decide(id, ws, true)).ok).toBe(true);
    const c = await auth.complete(id);
    if (!c.ok) throw new Error(c.error);
    return new URL(c.redirect).searchParams.get("code")!;
  };
  return { db, auth, ws, clientId, request, code, now };
}

describe("AuthStore", () => {
  it("stores only hashes and issues tokens for a PKCE-verified code once", async () => {
    const { db, auth, ws, clientId, code } = await setup();
    const c = await code();
    expect((await auth.exchangeCode({ code: c, verifier: "wrong".repeat(10), clientId })).ok).toBe(false);
    const r = await auth.exchangeCode({ code: c, verifier: VERIFIER, clientId, redirectUri: "http://localhost:9/cb" });
    if (!r.ok) throw new Error(r.error);
    // Single use
    expect((await auth.exchangeCode({ code: c, verifier: VERIFIER, clientId })).ok).toBe(false);
    const rows = await db.query<{ hash: string }>("SELECT hash FROM tokens");
    const stored = JSON.stringify(rows) + JSON.stringify(await db.query("SELECT * FROM auth_requests"));
    expect(stored).not.toContain(r.tokens.access_token);
    expect(stored).not.toContain(r.tokens.refresh_token);
    expect(stored).not.toContain(c);
    expect(rows.map((x) => x.hash)).toContain(hash(r.tokens.access_token));
    expect(await auth.verify(r.tokens.access_token)).toEqual({ ok: true, workspaceId: ws, clientId });
    expect(await auth.verify("nope")).toEqual({ ok: false, error: "invalid" });
  });

  it("expires access tokens and codes; rotates refresh tokens", async () => {
    const { auth, clientId, code, now } = await setup();
    const c = await code();
    now.t += 61_000;
    expect((await auth.exchangeCode({ code: c, verifier: VERIFIER, clientId })).ok).toBe(false);
    const r = await auth.exchangeCode({ code: await code(), verifier: VERIFIER, clientId });
    if (!r.ok) throw new Error();
    now.t += 3600_001;
    expect(await auth.verify(r.tokens.access_token)).toEqual({ ok: false, error: "expired" });
    const r2 = await auth.refresh(r.tokens.refresh_token, clientId);
    if (!r2.ok) throw new Error(r2.error);
    expect((await auth.verify(r2.tokens.access_token)).ok).toBe(true);
    // Old refresh token no longer works
    expect((await auth.refresh(r.tokens.refresh_token, clientId)).ok).toBe(false);
  });

  it("revoking an approval cuts tokens and refresh with the REVOKED reason", async () => {
    const { auth, ws, clientId, code } = await setup();
    const r = await auth.exchangeCode({ code: await code(), verifier: VERIFIER, clientId });
    if (!r.ok) throw new Error();
    expect((await auth.approvals(ws)).map((a) => a.name)).toEqual(["Claude Code"]);
    expect(await auth.revokeApproval(ws, clientId)).toBe(true);
    expect(await auth.verify(r.tokens.access_token)).toEqual({ ok: false, error: "revoked" });
    const ref = await auth.refresh(r.tokens.refresh_token, clientId);
    expect(!ref.ok && ref.description).toBe(REVOKED);
    expect(await auth.approvals(ws)).toEqual([]);
  });

  it("deny and expiry redirect with access_denied; requests can't be answered twice", async () => {
    const { auth, ws, request, now } = await setup();
    const id = await request();
    expect((await auth.complete(id)).ok).toBe(false); // not answered
    await auth.decide(id, ws, false);
    expect((await auth.decide(id, ws, true)).ok).toBe(false);
    const c = await auth.complete(id);
    const u = new URL(c.ok ? c.redirect : "");
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("error_description")).toBe(DENIED);
    expect(u.searchParams.get("state")).toBe("s1");
    expect((await auth.deniedToday(ws)).map((d) => d.name)).toEqual(["Claude Code"]);
    const late = await request();
    now.t += 121_000;
    expect((await auth.request(late))?.status).toBe("expired");
    expect((await auth.decide(late, ws, true)).ok).toBe(false);
  });
});

describe("ActivityLog", () => {
  it("lists newest first with paging and keeps the last N per project", async () => {
    const db = await testDb();
    const log = new ActivityLog(db, { keep: 5 });
    for (let i = 0; i < 8; i++) await log.add("w", "p", { who: "Claude", verb: "set part", object: `p${i}` });
    await log.add("w", "q", { who: "You", verb: "changed parameter", object: "w", detail: "3 → 5" });
    const page = await log.list("w", "p", undefined, 3);
    expect(page.map((e) => e.object)).toEqual(["p7", "p6", "p5"]);
    expect((await log.list("w", "p", page[2].id, 3)).map((e) => e.object)).toEqual(["p4", "p3", "p2"]);
    expect(await log.sweep()).toBe(3);
    expect(await log.list("w", "p")).toHaveLength(5);
    expect(await log.list("w", "q")).toHaveLength(1);
  });
});
