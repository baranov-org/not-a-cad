import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkValues, isId, ParamValue } from "shared";
import type { Hub } from "./hub";
import type { ShareStore } from "./shareStore";
import { THUMB_MAX, type Store } from "./store";

const THUMB_TYPES = ["image/webp", "image/jpeg", "image/png"];

const shareIdOf = (s: string) => s.trim().match(/(?:\/s\/)?([A-Za-z0-9_-]{22})\/?(?:[?#].*)?$/)?.[1];

const NewProject = z.union([
  z.object({ fromShare: z.string(), values: z.record(z.string(), ParamValue).optional() }),
  z.object({ name: z.string().trim().min(1).max(80).optional() }),
]);
const Rename = z.object({ name: z.string().trim().min(1).max(80) });

// Workspace library: projects CRUD, fork from share, thumbnails
export function registerLibraryRoutes(app: FastifyInstance, store: Store, shares: ShareStore, hub: Hub) {
  const writes = { config: { rateLimit: { max: 60 } } };
  const reads = { config: { rateLimit: { max: 120 } } };
  type W = { Params: { ws: string } };
  type P = { Params: { ws: string; pid: string } };
  const ok = (p: { ws: string; pid?: string }) => isId(p.ws) && (p.pid === undefined || isId(p.pid));
  const notFound = { error: "Not found" };

  app.post("/api/workspaces", { config: { rateLimit: { max: 10 } } }, async (_req, reply) => {
    const r = await store.createWorkspace();
    return r.ok ? { id: r.id } : reply.code(r.status).send({ error: r.error });
  });

  app.get<W>("/api/w/:ws/projects", reads, async (req, reply) => {
    const { ws } = req.params;
    if (!ok(req.params)) return reply.code(404).send(notFound);
    const list = await store.listProjects(ws);
    const shared = await shares.sharedProjects(list.map((p) => p.id));
    const active = hub.openProject(ws) ?? (await store.activeProject(ws));
    const agent = hub.isConnected(ws) ? hub.agentProject(ws) : undefined;
    reply.header("cache-control", "no-cache");
    return {
      projects: list.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        created: p.created,
        updated: p.updated,
        thumbnail: p.thumbAt ? `/api/w/${ws}/projects/${p.id}/thumbnail?v=${p.thumbAt}` : null,
        shared: shared.has(p.id),
        forked: !!p.forkedFromShare,
        changedByAgent: p.changedByAgent,
        active: p.id === active,
        agentHere: p.id === agent,
      })),
    };
  });

  app.post<W>("/api/w/:ws/projects", writes, async (req, reply) => {
    const { ws } = req.params;
    if (!ok(req.params)) return reply.code(404).send(notFound);
    const body = NewProject.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (!("fromShare" in body.data)) {
      const r = await store.createProject(ws, { name: body.data.name });
      return r.ok ? { id: r.id } : reply.code(r.status).send({ error: r.error });
    }
    // Fork: the share's snapshot with the visitor's current values
    const sid = shareIdOf(body.data.fromShare);
    const s = sid ? await shares.get(sid) : undefined;
    if (!s) return reply.code(404).send({ error: "Share not found" });
    const model = structuredClone(s.model);
    if (body.data.values) {
      const errs = checkValues(model.params.form, body.data.values);
      if (errs.length) return reply.code(400).send({ error: errs.join("; ") });
      model.params.values = { ...model.params.values, ...body.data.values };
    }
    const r = await store.createProject(ws, { model, forkedFromShare: sid });
    return r.ok ? { id: r.id } : reply.code(r.status).send({ error: r.error });
  });

  app.patch<P>("/api/w/:ws/projects/:pid", writes, async (req, reply) => {
    if (!ok(req.params)) return reply.code(404).send(notFound);
    const body = Rename.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const r = await store.rename(req.params.ws, req.params.pid, body.data.name);
    return r.ok ? { ok: true } : reply.code(r.status).send({ error: r.error });
  });

  app.post<P>("/api/w/:ws/projects/:pid/duplicate", writes, async (req, reply) => {
    if (!ok(req.params)) return reply.code(404).send(notFound);
    const r = await store.duplicate(req.params.ws, req.params.pid);
    return r.ok ? { id: r.id } : reply.code(r.status).send({ error: r.error });
  });

  // Soft delete; purged (and unpublished) by the sweep unless restored
  app.delete<P>("/api/w/:ws/projects/:pid", writes, async (req, reply) => {
    if (!ok(req.params) || !(await store.softDelete(req.params.ws, req.params.pid))) return reply.code(404).send(notFound);
    return { ok: true };
  });

  app.post<P>("/api/w/:ws/projects/:pid/restore", writes, async (req, reply) => {
    if (!ok(req.params) || !(await store.restore(req.params.ws, req.params.pid))) return reply.code(404).send(notFound);
    return { ok: true };
  });

  app.addContentTypeParser(THUMB_TYPES, { parseAs: "buffer", bodyLimit: THUMB_MAX + 1024 }, (_req, body, done) =>
    done(null, body));
  app.put<P>("/api/w/:ws/projects/:pid/thumbnail", { ...writes, bodyLimit: THUMB_MAX + 1024 }, async (req, reply) => {
    if (!ok(req.params)) return reply.code(404).send(notFound);
    const type = String(req.headers["content-type"]).split(";")[0];
    if (!Buffer.isBuffer(req.body) || !THUMB_TYPES.includes(type)) {
      return reply.code(415).send({ error: "Send image/webp, image/jpeg or image/png" });
    }
    const r = await store.setThumb(req.params.ws, req.params.pid, req.body, type);
    return r.ok ? { ok: true } : reply.code(r.status).send({ error: r.error });
  });

  app.get<P>("/api/w/:ws/projects/:pid/thumbnail", reads, async (req, reply) => {
    const t = ok(req.params) ? await store.thumb(req.params.ws, req.params.pid) : undefined;
    if (!t) return reply.code(404).send(notFound);
    // Versioned by ?v=<upload time>
    return reply.type(t.type).header("cache-control", "private, max-age=31536000, immutable").send(t.data);
  });
}
