import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isId } from "shared";
import type { ActivityLog } from "./activity";
import type { AuthStore } from "./auth";
import type { Hub } from "./hub";
import type { Store } from "./store";

// User actions the browser reports itself (exports happen client-side)
const UserEvent = z.object({ verb: z.enum(["exported"]), object: z.string().max(200) });

// Connected agents (list, revoke) and the activity log
export function registerAgentRoutes(app: FastifyInstance, store: Store, auth: AuthStore, activity: ActivityLog, hub: Hub) {
  const reads = { config: { rateLimit: { max: 120 } } };
  const writes = { config: { rateLimit: { max: 60 } } };
  type W = { Params: { ws: string } };
  type P = { Params: { ws: string; pid: string } };
  const notFound = { error: "Not found" };

  app.get<W>("/api/w/:ws/agents", reads, async (req, reply) => {
    if (!isId(req.params.ws)) return reply.code(404).send(notFound);
    return { agents: await auth.approvals(req.params.ws), denied: await auth.deniedToday(req.params.ws) };
  });

  app.post<{ Params: { ws: string; client: string } }>("/api/w/:ws/agents/:client/revoke", writes, async (req, reply) => {
    const { ws, client } = req.params;
    if (!isId(ws) || !isId(client) || !(await auth.revokeApproval(ws, client))) return reply.code(404).send(notFound);
    await hub.pushAgents(ws);
    return { ok: true };
  });

  app.get<P & { Querystring: { before?: string; limit?: string } }>("/api/w/:ws/projects/:pid/activity", reads, async (req, reply) => {
    const { ws, pid } = req.params;
    if (!isId(ws) || !isId(pid) || !(await store.project(ws, pid))) return reply.code(404).send(notFound);
    const before = Number(req.query.before) || undefined;
    reply.header("cache-control", "no-cache");
    return { entries: await activity.list(ws, pid, before, Number(req.query.limit) || 50) };
  });

  app.post<P>("/api/w/:ws/projects/:pid/activity", writes, async (req, reply) => {
    const { ws, pid } = req.params;
    if (!isId(ws) || !isId(pid) || !(await store.project(ws, pid))) return reply.code(404).send(notFound);
    const body = UserEvent.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    await activity.add(ws, pid, { who: "You", verb: body.data.verb, object: body.data.object });
    hub.activityChanged(ws, pid);
    return { ok: true };
  });
}
