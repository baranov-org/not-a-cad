import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { isId, Model, modelHash } from "shared";
import type { ActivityLog } from "./activity";
import type { BundleStore } from "./bundles";
import type { ShareStore } from "./shareStore";
import { THUMB_MAX, type Store } from "./store";

export const ROBOTS_TXT = `User-agent: *
Allow: /s/
Allow: /api/shares/
Allow: /assets/
Disallow: /
`;

// Paths crawlers may index; everything else gets X-Robots-Tag: noindex
export const INDEXABLE = (url: string) =>
  url === "/robots.txt" || url.startsWith("/s/") || url.startsWith("/api/shares/") || url.startsWith("/assets/");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const PREVIEW = { width: 1200, height: 630 };

// index.html with the share's title, description and Open Graph tags (with the preview image when there is one)
export function shareHtml(index: string, model: Model, url: string, image?: string): string {
  const title = esc(model.info.name ?? "Shared CAD model");
  const desc = esc(model.info.description ?? "A parametric 3D model. Tweak its parameters and export STL in your browser.");
  const u = esc(url);
  const meta = [
    `<meta name="description" content="${desc}" />`,
    `<meta property="og:site_name" content="not-a-cad" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${desc}" />`,
    `<meta property="og:url" content="${u}" />`,
    ...(image ? [
      `<meta property="og:image" content="${esc(image)}" />`,
      `<meta property="og:image:width" content="${PREVIEW.width}" />`,
      `<meta property="og:image:height" content="${PREVIEW.height}" />`,
      `<meta property="og:image:alt" content="${title}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:image" content="${esc(image)}" />`,
    ] : [`<meta name="twitter:card" content="summary" />`]),
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${desc}" />`,
    `<link rel="canonical" href="${u}" />`,
  ].join("\n    ");
  return index.replace(/<title>.*?<\/title>/s, `<title>${title}</title>\n    ${meta}`);
}

// Public origin: PUBLIC_URL when set (headers can't override it); else X-Forwarded-* from the proxy, else this connection
export const origin = (req: { headers: Record<string, string | string[] | undefined>; protocol: string }) => {
  const pinned = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (pinned) return pinned;
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol).split(",")[0];
  return `${proto}://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
};

export function registerShareRoutes(
  app: FastifyInstance, store: Store, shares: ShareStore, bundles: BundleStore, webDist?: string, activity?: ActivityLog,
) {
  const writes = { config: { rateLimit: { max: 30 } } };
  const reads = { config: { rateLimit: { max: 120 } } };
  type P = { Params: { ws: string; pid: string } };
  // Project of this workspace, or undefined (malformed ids included)
  const project = async (p: P["Params"]) => isId(p.ws) && isId(p.pid) ? store.project(p.ws, p.pid) : undefined;
  const base = "/api/w/:ws/projects/:pid/share";

  app.get("/robots.txt", async (_req, reply) => reply.type("text/plain").send(ROBOTS_TXT));

  app.get<P>(base, reads, async (req, reply) => {
    const s = (await project(req.params)) && (await shares.byProject(req.params.pid));
    if (!s) return reply.code(404).send({ error: "Not published" });
    const full = await shares.get(s.id);
    return {
      id: s.id, path: `/s/${s.id}`, updatedAt: s.updated, modelHash: full ? modelHash(full.model) : null,
      preview: full?.previewAt === s.updated,
    };
  });

  app.put<P>(base, writes, async (req, reply) => {
    if (!(await project(req.params))) return reply.code(404).send({ error: "Not found" });
    const parsed = Model.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `Invalid model: ${parsed.error.message}` });
    const model = parsed.data;
    if (!model.info.name) return reply.code(400).send({ error: "The model needs a name before it can be shared" });
    if (!Object.keys(model.parts).length) return reply.code(400).send({ error: "Nothing to share: the model has no parts" });
    const before = await shares.byProject(req.params.pid);
    const r = await shares.publish(req.params.pid, model);
    if (!r.ok) return reply.code(413).send({ error: r.error });
    await activity?.add(req.params.ws, req.params.pid, { who: "You", verb: before ? "republished share" : "published share", object: `/s/${r.id}` });
    return { id: r.id, path: `/s/${r.id}`, updatedAt: r.updated };
  });

  app.delete<P>(base, writes, async (req, reply) => {
    const id = (await project(req.params)) && (await shares.unpublish(req.params.pid));
    if (!id) return reply.code(404).send({ error: "Not published" });
    await bundles.delete(id);
    await activity?.add(req.params.ws, req.params.pid, { who: "You", verb: "unpublished share", object: `/s/${id}` });
    return { ok: true };
  });

  // Prebuilt meshes for the current share version (raw bundle body)
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: bundles.maxBytes + 1024 }, (_req, body, done) =>
    done(null, body));
  app.put<P & { Querystring: { version?: string } }>(
    `${base}/meshes`,
    { ...writes, bodyLimit: bundles.maxBytes + 1024 },
    async (req, reply) => {
      const s = (await project(req.params)) && (await shares.byProject(req.params.pid));
      if (!s) return reply.code(404).send({ error: "Not published" });
      if (Number(req.query.version) !== s.updated) return reply.code(409).send({ error: "Share was republished; upload the new version" });
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "Send application/octet-stream" });
      const r = await bundles.put(s.id, s.updated, req.body);
      return r.ok ? { ok: true } : reply.code(r.status).send({ error: r.error });
    },
  );

  // Social preview for the current share version (image body; the content type parsers are in library.ts)
  app.put<P & { Querystring: { version?: string } }>(`${base}/preview`, { ...writes, bodyLimit: THUMB_MAX + 1024 }, async (req, reply) => {
    const s = (await project(req.params)) && (await shares.byProject(req.params.pid));
    if (!s) return reply.code(404).send({ error: "Not published" });
    const type = String(req.headers["content-type"] ?? "").split(";")[0];
    if (!Buffer.isBuffer(req.body) || !["image/jpeg", "image/png"].includes(type)) return reply.code(415).send({ error: "Send image/jpeg or image/png" });
    if (req.body.length > THUMB_MAX) return reply.code(413).send({ error: `Preview exceeds ${THUMB_MAX} bytes` });
    if (!(await shares.setPreview(s.id, Number(req.query.version), req.body, type))) {
      return reply.code(409).send({ error: "Share was republished; upload the new version" });
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { v?: string } }>("/api/shares/:id/preview", reads, async (req, reply) => {
    const p = isId(req.params.id) ? await shares.preview(req.params.id) : undefined;
    if (!p) return reply.code(404).header("cache-control", "no-cache").send({ error: "No preview" });
    // Versioned URL: cache forever; unversioned: revalidate
    const versioned = Number(req.query.v) === p.at;
    return reply.type(p.type).header("cache-control", versioned ? "public, max-age=31536000, immutable" : "no-cache").send(p.data);
  });

  app.get<{ Params: { id: string }; Querystring: { v?: string } }>("/api/shares/:id/meshes", reads, async (req, reply) => {
    const data = isId(req.params.id) ? await bundles.get(req.params.id, Number(req.query.v)) : undefined;
    if (!data) return reply.code(404).header("cache-control", "no-cache").send({ error: "No prebuilt meshes" });
    // Versioned URL: safe to cache forever (Cloudflare edge too)
    return reply
      .type("application/octet-stream")
      .header("content-encoding", "gzip")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(data);
  });

  app.get<{ Params: { id: string } }>("/api/shares/:id", reads, async (req, reply) => {
    const s = isId(req.params.id) ? await shares.get(req.params.id) : undefined;
    reply.header("cache-control", "no-cache");
    return s ? { model: s.model, updatedAt: s.updated } : reply.code(404).send({ error: "Share not found" });
  });

  // Share page with server-side metadata for crawlers and link previews
  const indexPath = webDist && join(webDist, "index.html");
  const index = indexPath && existsSync(indexPath) ? readFileSync(indexPath, "utf8") : undefined;
  if (index) {
    app.get<{ Params: { id: string } }>("/s/:id", reads, async (req, reply) => {
      const s = isId(req.params.id) ? await shares.get(req.params.id) : undefined;
      reply.type("text/html; charset=utf-8").header("cache-control", "no-cache");
      if (!s) return reply.code(404).send(index);
      const o = origin(req);
      const image = s.previewAt ? `${o}/api/shares/${req.params.id}/preview?v=${s.previewAt}` : undefined;
      return reply.send(shareHtml(index, s.model, `${o}/s/${req.params.id}`, image));
    });
  }
}
