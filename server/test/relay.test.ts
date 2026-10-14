import { afterEach, describe, expect, it } from "vitest";
import { newSessionId, WS_CLOSE_SUPERSEDED } from "shared";
import { NOT_CONNECTED } from "../src/hub";
import { FakeBrowser, seed, sleep, startServer } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
afterEach(async () => srv?.app.close());

const ok = (text: string) => ({ ok: true, content: [{ type: "text" as const, text }] });

describe("ws + relay", () => {
  it("sends restore with the stored model when a project opens", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store, { a: "x" });
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    const m = await b.waitFor("restore");
    expect(m).toMatchObject({ project: pid, model: { parts: { a: "x" } } });
    expect(await srv.store.activeProject(ws)).toBe(pid);
    b.close();
  });

  it("creates the workspace on connect and ignores unknown projects", async () => {
    srv = await startServer();
    const ws = newSessionId();
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(null);
    expect(await srv.store.listProjects(ws)).toEqual([]);
    b.send({ type: "open", project: newSessionId() });
    await sleep(50);
    expect(b.msgs.some((m) => m.type === "restore")).toBe(false);
    expect(srv.hub.openProject(ws)).toBeNull();
    b.close();
  });

  it("sends keepalive pings to connected browsers", async () => {
    srv = await startServer({ keepaliveMs: 50 });
    const b = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`);
    await b.opened;
    await sleep(180);
    expect(b.msgs.filter((m) => m.type === "ping").length).toBeGreaterThanOrEqual(2);
    b.close();
  });

  it("rejects malformed workspace id", async () => {
    srv = await startServer();
    const b = new FakeBrowser(`${srv.ws}/ws/bad`);
    await b.opened;
    await sleep(100);
    expect(b.closeCode).toBe(1008);
  });

  it("second tab supersedes the first", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    const a = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await a.open(pid);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    await a.waitFor("superseded");
    await sleep(50);
    expect(a.closeCode).toBe(WS_CLOSE_SUPERSEDED);
    b.handler = () => ok("from b");
    const r = await srv.hub.call(ws, pid, "list_parts", {});
    expect(r.content[0]).toEqual({ type: "text", text: "from b" });
    b.close();
  });

  it("relays calls with the project and stores changes there", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    let got = "";
    b.handler = (op, args, project) => {
      got = project;
      return { ...ok(op), changes: { upsert: [args as { name: string; source: string }] } };
    };
    const r = await srv.hub.call(ws, pid, "set_part", { name: "p", source: "s" });
    expect(r).toEqual(ok("set_part"));
    expect(got).toBe(pid);
    expect((await srv.store.getModel(ws, pid))?.parts).toEqual({ p: "s" });
    b.close();
  });

  it("refuses a call for a project that is not open", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(null);
    const r = await srv.hub.call(ws, pid, "list_parts", {});
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.content)).toMatch(/active project changed/);
    b.close();
  });

  it("errors when no browser is connected", async () => {
    srv = await startServer();
    const r = await srv.hub.target(newSessionId());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.content[0]).toEqual({ type: "text", text: NOT_CONNECTED });
  });

  it("times out and discards late reply", async () => {
    srv = await startServer({ timeoutMs: 100 });
    const { ws, pid } = await seed(srv.store);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    const r = await srv.hub.call(ws, pid, "set_part", { name: "p", source: "s" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.content)).toMatch(/did not respond/);
    const call = await b.waitFor("call");
    b.send({ type: "result", id: call.id, ok: true, content: [], changes: { upsert: [{ name: "p", source: "s" }] } });
    await sleep(50);
    expect((await srv.store.getModel(ws, pid))?.parts).toEqual({});
    b.close();
  });

  it("fails pending call when browser disconnects", async () => {
    srv = await startServer({ timeoutMs: 5000 });
    const { ws, pid } = await seed(srv.store);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    const p = srv.hub.call(ws, pid, "list_parts", {});
    await b.waitFor("call");
    const t = Date.now();
    b.close();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.content)).toMatch(/disconnected/);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("active project", () => {
  it("opens the active project when the tab shows the library", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    await srv.store.createProject(ws, { name: "Other" });
    await srv.store.setActive(ws, pid);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(null);
    const t = await srv.hub.target(ws);
    expect(t).toEqual({ ok: true, project: pid });
    expect(await b.waitFor("navigate")).toMatchObject({ project: pid });
    expect(srv.hub.openProject(ws)).toBe(pid);
    b.close();
  });

  it("creates a project when the workspace has none", async () => {
    srv = await startServer();
    const ws = newSessionId();
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(null);
    const t = await srv.hub.target(ws);
    expect(t.ok).toBe(true);
    const list = await srv.store.listProjects(ws);
    expect(list.map((p) => p.id)).toEqual([t.ok && t.project]);
    b.close();
  });

  it("fails when the tab does not follow navigate", async () => {
    srv = await startServer();
    const { ws } = await seed(srv.store);
    const hub = srv.hub as unknown as { navigateMs: number };
    hub.navigateMs = 100;
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    b.followNavigate = false;
    await b.open(null);
    const t = await srv.hub.target(ws);
    expect(t.ok).toBe(false);
    b.close();
  });

  it("notes a user switch on the next agent call", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    const other = (await srv.store.createProject(ws, { name: "Wall mount" })) as { id: string };
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    expect(await srv.hub.target(ws)).toEqual({ ok: true, project: pid });
    await b.open(other.id);
    const t = await srv.hub.target(ws);
    expect(t.ok && t.project).toBe(other.id);
    expect(t.ok && t.note).toMatch(/"Wall mount"/);
    // Only once
    expect(await srv.hub.target(ws)).toEqual({ ok: true, project: other.id });
    b.close();
  });

  it("agent open: the tab follows, no note afterwards", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    const other = (await srv.store.createProject(ws)) as { id: string };
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    await srv.hub.target(ws);
    expect((await srv.hub.open(ws, other.id, "Claude")).ok).toBe(true);
    expect(await b.waitFor("navigate")).toEqual({ type: "navigate", project: other.id, by: "Claude" });
    expect(await srv.hub.target(ws)).toEqual({ ok: true, project: other.id });
    b.close();
  });

  it("marks agent changes unseen only when the user isn't viewing", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    b.handler = (_op, args) => ({ ...ok("x"), changes: { upsert: [args as { name: string; source: string }] } });
    await srv.hub.call(ws, pid, "set_part", { name: "a", source: "s" });
    expect((await srv.store.project(ws, pid))?.changedByAgent).toBe(false);
    b.send({ type: "visibility", visible: false });
    await sleep(30);
    await srv.hub.call(ws, pid, "set_part", { name: "b", source: "s" });
    expect((await srv.store.project(ws, pid))?.changedByAgent).toBe(true);
    b.send({ type: "visibility", visible: true });
    await sleep(30);
    expect((await srv.store.project(ws, pid))?.changedByAgent).toBe(false);
    b.close();
  });
});

describe("browser changes message", () => {
  const params = {
    form: { params: [{ name: "w", label: "W", type: "number" as const, default: 3 }], groups: [] },
    values: { w: 5 },
  };

  it("saves params changes, ignores everything else", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store, { a: "x" });
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    b.ws.send(JSON.stringify({ type: "changes", project: pid, changes: { params, info: { name: "Box" }, upsert: [{ name: "evil", source: "y" }], delete: ["a"] } }));
    await sleep(50);
    const m = await srv.store.getModel(ws, pid);
    expect(m?.params.values).toEqual({ w: 5 });
    expect(m?.info).toEqual({ name: "Box" });
    expect(m?.parts).toEqual({ a: "x" });
    b.close();
  });

  it("ignores changes for a project that is not open", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    const other = (await srv.store.createProject(ws)) as { id: string };
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    b.send({ type: "changes", project: other.id, changes: { params } });
    await sleep(50);
    expect((await srv.store.getModel(ws, other.id))?.params.values).toEqual({});
    b.close();
  });

  it("rejects invalid params and respects size limits", async () => {
    srv = await startServer({ maxBytes: 400 });
    const { ws, pid } = await seed(srv.store);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    // Default violates its own max -> schema rejects the message
    b.ws.send(JSON.stringify({ type: "changes", project: pid, changes: { params: { form: { params: [{ name: "w", label: "W", type: "number", default: 9, max: 1 }] }, values: {} } } }));
    // Too big for the project
    b.ws.send(JSON.stringify({ type: "changes", project: pid, changes: { params: { ...params, values: { w: 5 }, form: { params: [{ ...params.form.params[0], description: "x".repeat(300) }], groups: [] } } } }));
    await sleep(50);
    expect((await srv.store.getModel(ws, pid))?.params.form.params).toEqual([]);
    b.close();
  });

  it("ignores changes from a superseded tab", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    const a = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await a.open(pid);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    await a.waitFor("superseded");
    if (a.ws.readyState === a.ws.OPEN) a.send({ type: "changes", project: pid, changes: { params } });
    await sleep(50);
    expect((await srv.store.getModel(ws, pid))?.params.values).toEqual({});
    b.close();
  });
});

describe("defaults", () => {
  it("relay timeout defaults to 300 s", async () => {
    const { Hub } = await import("../src/hub");
    const hub = new Hub({} as never) as unknown as { timeoutMs: number };
    expect(hub.timeoutMs).toBe(300_000);
  });
});
