import { afterEach, describe, expect, it } from "vitest";
import { emptyModel, newSessionId, type Model } from "shared";
import { startServer } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
afterEach(async () => srv?.app.close());

const json = (method: string, body?: unknown) => ({
  method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
type Card = { id: string; name: string; shared: boolean; forked: boolean; active: boolean; thumbnail: string | null };
const list = async (ws: string): Promise<Card[]> => (await (await fetch(`${srv.base}/api/w/${ws}/projects`)).json()).projects;

describe("library API", () => {
  it("creates a workspace and does project CRUD with undo", async () => {
    srv = await startServer();
    const { id: ws } = await (await fetch(`${srv.base}/api/workspaces`, { method: "POST" })).json();
    expect(await list(ws)).toEqual([]);
    const p = `${srv.base}/api/w/${ws}/projects`;
    const { id } = await (await fetch(p, json("POST", { name: "Wall mount" }))).json();
    expect((await list(ws)).map((c) => c.name)).toEqual(["Wall mount"]);

    expect((await fetch(`${p}/${id}`, json("PATCH", { name: "Bracket" }))).status).toBe(200);
    expect((await fetch(`${p}/${id}`, json("PATCH", { name: "" }))).status).toBe(400);
    const dup = await (await fetch(`${p}/${id}/duplicate`, { method: "POST" })).json();
    expect((await list(ws)).map((c) => c.name).sort()).toEqual(["Bracket", "Bracket copy"]);

    expect((await fetch(`${p}/${dup.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await list(ws)).map((c) => c.id)).toEqual([id]);
    expect((await fetch(`${p}/${dup.id}/restore`, { method: "POST" })).status).toBe(200);
    expect(await list(ws)).toHaveLength(2);
  });

  it("404 for malformed ids and other workspaces' projects", async () => {
    srv = await startServer();
    expect((await fetch(`${srv.base}/api/w/bad/projects`)).status).toBe(404);
    const ws = newSessionId();
    const { id } = await (await fetch(`${srv.base}/api/w/${ws}/projects`, json("POST", {}))).json();
    const other = newSessionId();
    expect((await fetch(`${srv.base}/api/w/${other}/projects/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${srv.base}/api/w/${other}/projects/${id}`, json("PATCH", { name: "x" }))).status).toBe(404);
    expect((await fetch(`${srv.base}/api/w/${ws}/projects/bad`, { method: "DELETE" })).status).toBe(404);
  });

  it("forks a share with the visitor's values; the share is unchanged", async () => {
    srv = await startServer();
    const shared: Model = {
      ...emptyModel(),
      parts: { p: "x" },
      info: { name: "Hook", description: "d" },
      params: { form: { params: [{ name: "w", label: "W", type: "number", default: 3, max: 10 }], groups: [] }, values: { w: 3 } },
    };
    const pub = await srv.shares.publish(newSessionId(), shared);
    if (!pub.ok) throw new Error("publish");
    const ws = newSessionId();
    const p = `${srv.base}/api/w/${ws}/projects`;
    expect((await fetch(p, json("POST", { fromShare: newSessionId() }))).status).toBe(404);
    expect((await fetch(p, json("POST", { fromShare: pub.id, values: { w: 99 } }))).status).toBe(400);
    const { id } = await (await fetch(p, json("POST", { fromShare: `https://cad.example/s/${pub.id}`, values: { w: 7 } }))).json();
    const m = await srv.store.getModel(ws, id);
    expect(m?.params.values).toEqual({ w: 7 });
    expect(m?.info.name).toBe("Hook");
    expect((await list(ws))[0]).toMatchObject({ id, forked: true, shared: false });
    expect((await srv.shares.get(pub.id))?.model).toEqual(shared);
  });

  it("stores and serves thumbnails, flags shared projects", async () => {
    srv = await startServer();
    const ws = newSessionId();
    const p = `${srv.base}/api/w/${ws}/projects`;
    const { id } = await (await fetch(p, json("POST", {}))).json();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const put = (body: BodyInit, type = "image/png") =>
      fetch(`${p}/${id}/thumbnail`, { method: "PUT", headers: { "content-type": type }, body });
    expect((await put("not an image", "text/plain")).status).toBe(415);
    expect((await put(new Uint8Array(200 * 1024))).status).toBe(413);
    expect((await put(new Uint8Array(png))).status).toBe(200);
    const card = (await list(ws))[0];
    expect(card.thumbnail).toMatch(new RegExp(`/api/w/${ws}/projects/${id}/thumbnail\\?v=\\d+`));
    const r = await fetch(`${srv.base}${card.thumbnail}`);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(png);
    // Safari can't encode WebP: JPEG is accepted too
    expect((await put(new Uint8Array([0xff, 0xd8, 0xff, 1]), "image/jpeg")).status).toBe(200);
    expect((await fetch(`${srv.base}${(await list(ws))[0].thumbnail}`)).headers.get("content-type")).toBe("image/jpeg");

    await srv.shares.publish(id, { ...emptyModel(), parts: { p: "x" }, info: { name: "N" } });
    expect((await list(ws))[0].shared).toBe(true);
  });
});
