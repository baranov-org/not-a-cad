import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isId } from "shared";
import { ActivityLog } from "./activity";
import { registerAgentRoutes } from "./agents";
import { AuthStore, REVOKED } from "./auth";
import { Hub } from "./hub";
import { registerOAuthRoutes } from "./oauth";
import { clientIp, limitsFromEnv, type Limits } from "./limits";
import { buildMcpServer } from "./mcp";
import { BundleStore } from "./bundles";
import { ShareStore } from "./shareStore";
import { registerLibraryRoutes } from "./library";
import { INDEXABLE, origin, registerShareRoutes } from "./shares";
import type { Store } from "./store";

export const WORKER_RE = /^\/assets\/worker-[\w-]+\.js(\?|$)/;
export const WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'";

export interface AppOptions {
  store: Store;
  hub?: Hub;
  webDist?: string;
  logger?: boolean;
  limits?: Limits;
  shares?: ShareStore;
  bundleDir?: string;
  auth?: AuthStore;
}

export async function buildApp(opts: AppOptions): Promise<{
  app: FastifyInstance; hub: Hub; shares: ShareStore; bundles: BundleStore; auth: AuthStore; activity: ActivityLog;
}> {
  const { store } = opts;
  const limits = opts.limits ?? limitsFromEnv();
  const shares = opts.shares ?? new ShareStore(store.db, {
    maxBytes: limits.maxSessionBytes, maxShares: limits.maxSessions, maxTotalBytes: limits.maxTotalBytes,
  });
  const hub = opts.hub ?? new Hub(store, undefined, limits);
  const auth = opts.auth ?? new AuthStore(store.db, { requestTtlMs: Number(process.env.AUTH_REQUEST_TTL_MS) || undefined });
  const activity = new ActivityLog(store.db);
  hub.attach({ auth, activity });
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  // Screenshots come back over the socket, so allow large frames
  await app.register(fastifyWebsocket, { options: { maxPayload: 32 * 1024 * 1024 } });
  await app.register(fastifyRateLimit, { global: false, keyGenerator: clientIp, timeWindow: "1 minute" });

  app.get("/health", async () => ({ ok: true }));
  // Readiness: the database answers
  app.get("/ready", async (_req, reply) => {
    try {
      await store.db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.get<{ Params: { ws: string } }>(
    "/ws/:ws",
    { websocket: true, config: { rateLimit: { max: limits.wsPerMinute } } },
    (socket, req) => {
      if (!isId(req.params.ws)) return socket.close(1008, "bad workspace id");
      hub.connect(req.params.ws, socket, clientIp(req));
    },
  );

  // MCP Streamable HTTP, stateless per request; the bearer token selects the workspace
  const mcp = async (req: FastifyRequest, reply: FastifyReply) => {
    const base = origin(req);
    const challenge = (error?: string, description?: string) =>
      [`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        ...(error ? [`error="${error}"`] : []), ...(description ? [`error_description="${description.replace(/→/g, "->").replace(/"/g, "'")}"`] : [])].join(", ");
    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!bearer) {
      return reply.code(401).header("www-authenticate", challenge()).send({ error: "unauthorized", error_description: "Authorization required" });
    }
    const v = await auth.verify(bearer);
    if (!v.ok) {
      const description = v.error === "revoked" ? REVOKED : v.error === "expired" ? "Token expired" : "Invalid token";
      return reply.code(401).header("www-authenticate", challenge("invalid_token", description))
        .send({ error: "invalid_token", error_description: description });
    }
    if (req.method !== "POST") {
      return reply.code(405).header("allow", "POST").send({ error: "Method not allowed" });
    }
    // Client name and version from the MCP handshake
    const body = req.body as { method?: string; params?: { clientInfo?: { name?: string; version?: string } } } | undefined;
    if (body?.method === "initialize") {
      await auth.setClientInfo(v.clientId, body.params?.clientInfo?.name, body.params?.clientInfo?.version);
      void hub.pushAgents(v.workspaceId);
    }
    const client = await auth.client(v.clientId);
    const server = buildMcpServer(v.workspaceId, hub, store, shares, base, {
      clientId: v.clientId, clientName: client?.name ?? "Agent", activity,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // Hijacked replies skip onSend hooks
    reply.raw.setHeader("x-robots-tag", "noindex");
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  const mcpLimit = { config: { rateLimit: { max: limits.mcpPerMinute } } };
  app.all("/mcp", mcpLimit, mcp);

  registerOAuthRoutes(app, auth, store, hub, limits.oauthPerMinute);
  registerAgentRoutes(app, store, auth, activity, hub);

  const bundles = new BundleStore(store.db, opts.bundleDir, {
    maxTotalBytes: Number(process.env.MAX_BUNDLE_BYTES) || undefined,
  });
  registerShareRoutes(app, store, shares, bundles, opts.webDist, activity);
  registerLibraryRoutes(app, store, shares, hub);

  app.addHook("onSend", async (req, reply) => {
    // Kernel worker runs agent code: no network, no DOM
    if (WORKER_RE.test(req.url)) reply.header("content-security-policy", WORKER_CSP);
    // Only shares are for search engines
    if (!INDEXABLE(req.url)) reply.header("x-robots-tag", "noindex");
  });

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, {
      root: opts.webDist,
      // Hashed build assets never change; lets Cloudflare cache them at the edge
      setHeaders: (res, path) => {
        if (path.includes("/assets/")) res.header("cache-control", "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((req, reply) =>
      req.method === "GET" && !req.url.startsWith("/mcp") ? reply.sendFile("index.html") : reply.code(404).send());
  }

  return { app, hub, shares, bundles, auth, activity };
}
