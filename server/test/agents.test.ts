import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ActivityLog } from "../src/activity";
import { testDb } from "./db";
import { authorizeRequest, decide, FakeBrowser, grant, seed, sleep, startServer } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
afterEach(async () => srv?.app.close());

async function agent(ws: string, name = "Claude Code") {
  const { token, clientId } = await grant(srv.base, ws, name);
  const client = new Client({ name, version: "2.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return { client, clientId };
}

describe("hub: approval requests and agents", () => {
  it("pushes pending requests of a client name approved in the workspace and clears them when answered", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    await grant(srv.base, ws);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    const req = await authorizeRequest(srv.base);
    await sleep(50);
    const last = () => [...b.msgs].reverse().find((m) => m.type === "auth_requests") as { requests: { id: string }[] } | undefined;
    expect(last()?.requests.map((r) => r.id)).toEqual([req.requestId]);
    // A second request queues
    const req2 = await authorizeRequest(srv.base);
    await sleep(50);
    expect(last()?.requests.map((r) => r.id)).toEqual([req.requestId, req2.requestId]);
    await decide(srv.base, req.requestId, ws);
    await sleep(50);
    expect(last()?.requests.map((r) => r.id)).toEqual([req2.requestId]);
    // A name never approved here isn't shown
    await authorizeRequest(srv.base, { name: "Stranger" });
    await sleep(50);
    expect(last()?.requests.map((r) => r.id)).toEqual([req2.requestId]);
    b.close();
  });

  it("expired requests leave the tab's list", async () => {
    srv = await startServer();
    (srv.auth as unknown as { requestTtlMs: number }).requestTtlMs = 100;
    const { ws, pid } = await seed(srv.store);
    await grant(srv.base, ws);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    await authorizeRequest(srv.base);
    await sleep(400);
    const lists = b.msgs.filter((m) => m.type === "auth_requests").map((m) => (m as { requests: unknown[] }).requests.length);
    expect(lists.at(-1)).toBe(0);
    expect(lists).toContain(1);
    b.close();
  });

  it("sends agents with version, and busy state while a tool runs", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    b.handler = () => undefined;
    const { client, clientId } = await agent(ws);
    // Reply to the call only after we checked the busy state
    b.ws.on("message", async (d) => {
      const m = JSON.parse(String(d));
      if (m.type !== "call") return;
      await gate;
      b.send({ type: "result", id: m.id, ok: true, content: [] });
    });
    const call = client.callTool({ name: "list_parts", arguments: {} });
    await sleep(100);
    expect(b.msgs).toContainEqual({ type: "agent_busy", client: clientId, tool: "list_parts" });
    const agents = [...b.msgs].reverse().find((m) => m.type === "agents") as { agents: { name: string; version: string; connected: boolean; busy: string }[] };
    expect(agents.agents[0]).toMatchObject({ name: "Claude Code", version: "2.1.0", connected: true, busy: "list_parts" });
    release();
    await call;
    expect(b.msgs).toContainEqual({ type: "agent_busy", client: clientId, tool: null });
    await client.close();
    b.close();
  });
});

describe("activity", () => {
  it("logs agent parameter changes as old → new, user edits as You, and pages via the API", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    await srv.store.apply(ws, pid, {
      params: { form: { params: [{ name: "length", label: "L", type: "number", default: 30 }], groups: [] }, values: { length: 30 } },
    });
    const b = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await b.open(pid);
    b.handler = (op, args) => {
      if (op !== "set_param_values") return { ok: true, content: [] };
      const values = (args as { values: Record<string, number> }).values;
      return { ok: true, content: [], changes: { params: { form: { params: [{ name: "length", label: "L", type: "number", default: 30 }], groups: [] }, values } } };
    };
    const { client } = await agent(ws);
    await client.callTool({ name: "set_param_values", arguments: { values: { length: 50 } } });
    // User edit from the browser
    b.send({ type: "changes", project: pid, changes: { params: { form: { params: [{ name: "length", label: "L", type: "number", default: 30 }], groups: [] }, values: { length: 42 } }, info: { name: "Rail" } } });
    await sleep(100);
    const page = await (await fetch(`${srv.base}/api/w/${ws}/projects/${pid}/activity?limit=2`)).json();
    expect(page.entries.map((e: { who: string; verb: string; object: string; detail: string }) => [e.who, e.verb, e.object, e.detail])).toEqual([
      ["You", "renamed model", "Rail", null],
      ["You", "changed parameter", "length", "50 → 42"],
    ]);
    const next = await (await fetch(`${srv.base}/api/w/${ws}/projects/${pid}/activity?before=${page.entries[1].id}`)).json();
    expect(next.entries[0]).toMatchObject({ who: "Claude Code", verb: "changed parameter", object: "length", detail: "30 → 50" });
    expect(b.msgs.some((m) => m.type === "activity")).toBe(true);

    // Exports are reported by the browser; other verbs are refused
    const post = (body: unknown) => fetch(`${srv.base}/api/w/${ws}/projects/${pid}/activity`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await post({ verb: "exported", object: "assembly.zip" })).status).toBe(200);
    expect((await post({ verb: "deleted everything", object: "x" })).status).toBe(400);
    expect((await fetch(`${srv.base}/api/w/${ws}/projects/${(await seed(srv.store)).pid}/activity`)).status).toBe(404);
    await client.close();
    b.close();
  });

  it("keeps the last 500 entries per project", async () => {
    const db = await testDb();
    const log = new ActivityLog(db);
    await db.query(`INSERT INTO activity (workspace_id, project_id, at, who, verb)
      SELECT 'w', 'p', $1, 'Claude', 'listed parts' FROM generate_series(1, 510)`, [Date.now()]);
    await log.sweep();
    expect((await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM activity"))[0].n).toBe(500);
    await db.close();
  });
});
