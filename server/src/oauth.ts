import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { isId, type AuthRequestInfo } from "shared";
import { recognised, type AuthRequest, type AuthStore } from "./auth";
import type { Hub } from "./hub";
import { origin } from "./shares";
import type { Store } from "./store";

const country = (h: Record<string, unknown>) => {
  const c = h["cf-ipcountry"];
  return typeof c === "string" && /^[A-Z]{2}$/.test(c) && c !== "XX" ? c : undefined;
};

export const summary = (r: AuthRequest): AuthRequestInfo => ({
  id: r.id,
  client: { name: r.client.name, version: r.client.version, recognised: recognised(r.client.name) },
  country: r.client.country ?? r.country,
  created: r.created,
  expires: r.expires,
  status: r.status,
});

// Redirect URIs: https, loopback http, or an app scheme (cursor://, vscode://); never script/data URLs
const RedirectUri = z.string().url().refine((u) => {
  const { protocol, hostname } = new URL(u);
  if (["javascript:", "data:", "file:", "blob:"].includes(protocol)) return false;
  if (protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  return true;
}, "redirect_uri must be https, loopback http, or an app scheme");

const Registration = z.object({
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(RedirectUri).min(1).max(10),
  token_endpoint_auth_method: z.string().optional(),
});

const Decision = z.object({ requestId: z.string(), workspaceId: z.string(), allow: z.boolean() });

// Resource indicator: absent or this server's <origin>/mcp
const validResource = (resource: string | undefined, base: string) => !resource || resource.replace(/\/$/, "") === `${base}/mcp`;

// OAuth 2.1 authorization server for MCP clients (metadata, registration, authorize, token, revoke)
export function registerOAuthRoutes(app: FastifyInstance, auth: AuthStore, store: Store, hub: Hub, perMinute = 60) {
  // Per IP; registration gets a third, status polling four times
  const limited = (share: number) => ({ config: { rateLimit: { max: Math.ceil(perMinute * share) } } });
  const tokenError = (reply: FastifyReply, status: number, error: string, description?: string) =>
    reply.code(status).header("cache-control", "no-store").send({ error, ...(description ? { error_description: description } : {}) });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  // Public metadata and token endpoints may be called from browser-based clients
  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/.well-known/") || /^\/oauth\/(token|register|revoke)/.test(req.url)) {
      reply.header("access-control-allow-origin", "*");
      reply.header("access-control-allow-headers", "authorization, content-type, mcp-protocol-version");
    }
  });
  for (const path of ["/oauth/token", "/oauth/register", "/oauth/revoke"]) {
    app.options(path, async (_req, reply) => reply.code(204).header("access-control-allow-methods", "POST").send());
  }

  const resourceMeta = (base: string, resource: string) => ({
    resource,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    resource_name: "not-a-cad",
  });
  app.get("/.well-known/oauth-protected-resource", async (req) => resourceMeta(origin(req), `${origin(req)}/mcp`));
  app.get("/.well-known/oauth-protected-resource/mcp", async (req) => resourceMeta(origin(req), `${origin(req)}/mcp`));

  const asMeta = (base: string) => ({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["cad"],
  });
  app.get("/.well-known/oauth-authorization-server", async (req) => asMeta(origin(req)));

  app.post("/oauth/register", limited(1 / 3), async (req, reply) => {
    const body = Registration.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_client_metadata", error_description: body.error.issues.map((i) => i.message).join("; ") });
    }
    const id = await auth.registerClient({ name: body.data.client_name, redirectUris: body.data.redirect_uris, country: country(req.headers) });
    return reply.code(201).send({
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.data.client_name,
      redirect_uris: body.data.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // Validates and records the request, then sends the browser to the consent page
  app.get<{ Querystring: Record<string, string | undefined> }>("/oauth/authorize", limited(1), async (req, reply) => {
    const q = req.query;
    const client = q.client_id ? await auth.client(q.client_id) : undefined;
    // Without a valid client and redirect_uri we must not redirect anywhere
    if (!client) return reply.code(400).type("text/plain").send("Unknown client_id. Reconnect the agent to register again.");
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      return reply.code(400).type("text/plain").send("redirect_uri is not registered for this client.");
    }
    const back = (error: string, description: string) => {
      const u = new URL(q.redirect_uri!);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      return reply.redirect(u.toString());
    };
    if (q.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return back("invalid_request", "PKCE with S256 is required");
    if (!validResource(q.resource, origin(req))) return back("invalid_target", "resource must be this server's /mcp endpoint");
    const id = await auth.createRequest({
      clientId: client.id, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge, state: q.state,
      resource: q.resource, country: country(req.headers),
    });
    const r = await auth.request(id);
    if (r) hub.authChanged(await auth.workspacesFor(r), r.expires - Date.now());
    return reply.redirect(`/connect/${id}`);
  });

  app.get<{ Params: { id: string } }>("/oauth/requests/:id", limited(4), async (req, reply) => {
    const r = isId(req.params.id) ? await auth.request(req.params.id) : undefined;
    reply.header("cache-control", "no-store");
    return r ? summary(r) : reply.code(404).send({ error: "Unknown request" });
  });

  // The user's answer, from the consent page or the workspace tab; needs the workspace id
  app.post("/oauth/decision", limited(1), async (req, reply) => {
    const body = Decision.safeParse(req.body);
    if (!body.success || !isId(body.data.workspaceId) || !isId(body.data.requestId)) return reply.code(400).send({ error: "Bad request" });
    // A well-formed workspace link counts; a new one is created (within the workspace cap)
    const ensured = await store.ensureWorkspace(body.data.workspaceId);
    if (!ensured.ok) return reply.code(ensured.status).send({ error: ensured.error });
    const before = await auth.request(body.data.requestId);
    const r = await auth.decide(body.data.requestId, body.data.workspaceId, body.data.allow);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    if (before) hub.authChanged([...new Set([...(await auth.workspacesFor(before)), body.data.workspaceId])]);
    return { ok: true };
  });

  // Redirect URL for the client (code or error); a code is handed out once
  app.post<{ Params: { id: string } }>("/oauth/requests/:id/complete", limited(1), async (req, reply) => {
    if (!isId(req.params.id)) return reply.code(404).send({ error: "Unknown request" });
    const r = await auth.complete(req.params.id);
    reply.header("cache-control", "no-store");
    return r.ok ? { redirect: r.redirect } : reply.code(r.status).send({ error: r.error });
  });

  app.post("/oauth/token", limited(1), async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (!b.client_id || !(await auth.client(b.client_id))) return tokenError(reply, 401, "invalid_client", "Unknown client");
    let r;
    if (b.grant_type === "authorization_code") {
      if (!b.code || !b.code_verifier) return tokenError(reply, 400, "invalid_request", "code and code_verifier are required");
      r = await auth.exchangeCode({ code: b.code, verifier: b.code_verifier, clientId: b.client_id, redirectUri: b.redirect_uri });
    } else if (b.grant_type === "refresh_token") {
      if (!b.refresh_token) return tokenError(reply, 400, "invalid_request", "refresh_token is required");
      r = await auth.refresh(b.refresh_token, b.client_id);
    } else {
      return tokenError(reply, 400, "unsupported_grant_type");
    }
    if (!r.ok) return tokenError(reply, r.status, r.error, r.description);
    return reply.header("cache-control", "no-store").send(r.tokens);
  });

  app.post("/oauth/revoke", limited(1), async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (b.token) await auth.revokeToken(b.token);
    return reply.code(200).send({});
  });
}
