import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyModel, newSessionId, type Model } from "shared";
import { seed, startServer } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
afterEach(async () => srv?.app.close());

const web = mkdtempSync(join(tmpdir(), "cad-web-"));
writeFileSync(join(web, "index.html"), "<!doctype html><html><head><title>not-a-cad</title></head><body></body></html>");

const model = (info: Model["info"] = { name: "Wall bracket", description: "L bracket" }): Model =>
  ({ ...emptyModel(), parts: { p: "const main = () => makeBaseBox(1,1,1)" }, info });
// Share URL of a fresh project
const project = async () => {
  const { ws, pid } = await seed(srv.store);
  return { ws, pid, url: `${srv.base}/api/w/${ws}/projects/${pid}/share` };
};
const put = (url: string, body: unknown) =>
  fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("share API", () => {
  it("publish, read, republish keeps id, unpublish", async () => {
    srv = await startServer({ webDist: web });
    const { ws, pid, url } = await project();
    expect((await fetch(url)).status).toBe(404);
    const r1 = await (await put(url, model())).json();
    expect(r1.path).toBe(`/s/${r1.id}`);
    const shared = await fetch(`${srv.base}/api/shares/${r1.id}`);
    const body = await shared.text();
    expect(shared.headers.get("cache-control")).toBe("no-cache");
    expect(JSON.parse(body).model.info.name).toBe("Wall bracket");
    expect(body).not.toContain(ws);
    expect(body).not.toContain(pid);
    const r2 = await (await put(url, model({ name: "v2" }))).json();
    expect(r2.id).toBe(r1.id);
    expect((await (await fetch(url)).json()).id).toBe(r1.id);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${srv.base}/api/shares/${r1.id}`)).status).toBe(404);
  });

  it("shares are per project and need the workspace", async () => {
    srv = await startServer();
    const a = await project();
    const ra = await (await put(a.url, model())).json();
    const pid2 = ((await srv.store.createProject(a.ws)) as { id: string }).id;
    const url2 = `${srv.base}/api/w/${a.ws}/projects/${pid2}/share`;
    const rb = await (await put(url2, model())).json();
    expect(rb.id).not.toBe(ra.id);
    // Wrong workspace for the project
    const other = newSessionId();
    expect((await put(`${srv.base}/api/w/${other}/projects/${a.pid}/share`, model())).status).toBe(404);
    expect((await fetch(`${srv.base}/api/w/${other}/projects/${a.pid}/share`, { method: "DELETE" })).status).toBe(404);
  });

  it("a share id cannot manage the share", async () => {
    srv = await startServer();
    const { url } = await project();
    const { id } = await (await put(url, model())).json();
    expect((await fetch(`${srv.base}/api/w/${id}/projects/${id}/share`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${srv.base}/api/w/${id}/projects/${id}/share`)).status).toBe(404);
    expect((await fetch(`${srv.base}/api/shares/${id}`)).status).toBe(200);
  });

  it("validates: name required, parts required, schema, size", async () => {
    srv = await startServer({ limits: { maxSessionBytes: 400 } });
    const { url } = await project();
    expect((await put(url, model({}))).status).toBe(400);
    expect((await put(url, { ...model(), parts: {} })).status).toBe(400);
    expect((await put(url, { parts: 5 })).status).toBe(400);
    const ok = await (await put(url, model())).json();
    const big = await put(url, { ...model(), parts: { p: "x".repeat(1000) } });
    expect(big.status).toBe(413);
    // Previous share intact
    expect((await (await fetch(`${srv.base}/api/shares/${ok.id}`)).json()).model.parts.p).toMatch(/makeBaseBox/);
  });
});

describe("search indexing", () => {
  it("robots.txt allows only shares", async () => {
    srv = await startServer();
    const r = await fetch(`${srv.base}/robots.txt`);
    const t = await r.text();
    expect(t).toMatch(/Allow: \/s\//);
    expect(t).toMatch(/Allow: \/api\/shares\//);
    expect(t).toMatch(/Allow: \/assets\//);
    expect(t).toMatch(/Disallow: \/\n/);
    expect(r.headers.get("x-robots-tag")).toBeNull();
  });

  it("noindex on session and MCP responses, not on shares", async () => {
    srv = await startServer({ webDist: web });
    const { ws, url } = await project();
    expect((await fetch(`${srv.base}/health`)).headers.get("x-robots-tag")).toBe("noindex");
    expect((await fetch(url)).headers.get("x-robots-tag")).toBe("noindex");
    expect((await fetch(`${srv.base}/api/w/${ws}/projects`)).headers.get("x-robots-tag")).toBe("noindex");
    const mcp = await fetch(`${srv.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.headers.get("x-robots-tag")).toBe("noindex");
    const { id } = await (await put(url, model())).json();
    expect((await fetch(`${srv.base}/s/${id}`)).headers.get("x-robots-tag")).toBeNull();
    expect((await fetch(`${srv.base}/api/shares/${id}`)).headers.get("x-robots-tag")).toBeNull();
  });

  it("share page has escaped title, description, OG and canonical; unknown is 404", async () => {
    srv = await startServer({ webDist: web });
    const { ws, pid, url } = await project();
    const { id } = await (await put(url, model({ name: `Hook <b>"x"</b> & co`, description: "Desc <script>alert(1)</script>" }))).json();
    const r = await fetch(`${srv.base}/s/${id}`, { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "cad.example" } });
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("<title>Hook &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; co</title>");
    expect(html).toContain('<meta name="description" content="Desc &lt;script&gt;alert(1)&lt;/script&gt;" />');
    expect(html).toContain('<meta property="og:title" content="Hook &lt;b&gt;');
    expect(html).toContain(`<link rel="canonical" href="https://cad.example/s/${id}" />`);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain(ws);
    expect(html).not.toContain(pid);
    expect((await fetch(`${srv.base}/s/${newSessionId()}`)).status).toBe(404);
  });

  it("social preview: owner uploads it per share version; share page links it for link cards", async () => {
    srv = await startServer({ webDist: web });
    const { url } = await project();
    const { id, updatedAt } = await (await put(url, model())).json();
    const page = async () => (await fetch(`${srv.base}/s/${id}`, { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "cad.example" } })).text();
    // Before a preview: a small card, no image
    expect(await page()).toContain('<meta name="twitter:card" content="summary" />');
    expect(await page()).not.toContain("og:image");
    expect((await (await fetch(url)).json()).preview).toBe(false);

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const upload = (body: BodyInit, version: number, type = "image/jpeg") =>
      fetch(`${url}/preview?version=${version}`, { method: "PUT", headers: { "content-type": type }, body });
    expect((await upload(new Uint8Array(jpeg), updatedAt, "image/webp")).status).toBe(415);
    expect((await upload(new Uint8Array(jpeg), updatedAt - 1)).status).toBe(409);
    expect((await upload(new Uint8Array(jpeg), updatedAt)).status).toBe(200);
    expect((await (await fetch(url)).json()).preview).toBe(true);

    const html = await page();
    const img = `https://cad.example/api/shares/${id}/preview?v=${updatedAt}`;
    expect(html).toContain(`<meta property="og:image" content="${img}" />`);
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta property="og:site_name" content="not-a-cad" />');
    const r = await fetch(`${srv.base}/api/shares/${id}/preview?v=${updatedAt}`);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(jpeg);

    // Republishing makes the old preview stale until a new one arrives
    const v2 = await (await put(url, model({ name: "v2" }))).json();
    expect((await (await fetch(url)).json()).preview).toBe(false);
    expect((await upload(new Uint8Array(jpeg), v2.updatedAt)).status).toBe(200);
    expect(await page()).toContain(`preview?v=${v2.updatedAt}`);
  });
});
