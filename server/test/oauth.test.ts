import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { newSessionId } from "shared";
import { DENIED, REVOKED } from "../src/auth";
import { origin } from "../src/shares";
import {
  authorizeRequest, complete, decide, FakeBrowser, grant, REDIRECT, seed, sleep, startServer, tokenRequest, VERIFIER,
} from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
afterEach(async () => srv?.app.close());

const listTools = (base: string, token?: string, path = "/mcp") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("public origin", () => {
  it("PUBLIC_URL wins over forwarded headers; without it the headers are used", async () => {
    srv = await startServer();
    const meta = (host: string) =>
      fetch(`${srv.base}/.well-known/oauth-protected-resource`, { headers: { "x-forwarded-host": host, "x-forwarded-proto": "https" } }).then((r) => r.json());
    expect((await meta("evil.example")).resource).toBe("https://evil.example/mcp");
    process.env.PUBLIC_URL = "https://cad.example.com/";
    try {
      expect((await meta("evil.example")).resource).toBe("https://cad.example.com/mcp");
      expect(origin({ headers: { host: "x" }, protocol: "http" })).toBe("https://cad.example.com");
    } finally {
      delete process.env.PUBLIC_URL;
    }
  });
});

describe("OAuth metadata and flow", () => {
  it("publishes resource and authorization server metadata", async () => {
    srv = await startServer();
    const prm = await (await fetch(`${srv.base}/.well-known/oauth-protected-resource`)).json();
    expect(prm).toMatchObject({ resource: `${srv.base}/mcp`, authorization_servers: [srv.base] });
    const ws = newSessionId();
    // No per-workspace resources: /mcp is the only endpoint
    expect((await fetch(`${srv.base}/.well-known/oauth-protected-resource/mcp/${ws}`)).status).toBe(404);
    const as = await (await fetch(`${srv.base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: srv.base, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
  });

  it("register → authorize → consent → code → token → MCP; refresh rotates", async () => {
    srv = await startServer();
    const { ws } = await seed(srv.store);
    const req = await authorizeRequest(srv.base, { name: "Claude Code" });
    expect(req.status).toBe(302);
    expect(req.location).toMatch(/^\/connect\/[A-Za-z0-9_-]{22}$/);
    const info = await (await fetch(`${srv.base}/oauth/requests/${req.requestId}`)).json();
    expect(info).toMatchObject({ status: "pending", client: { name: "Claude Code", recognised: true } });
    expect((await decide(srv.base, req.requestId, "bad")).status).toBe(400);
    expect((await decide(srv.base, req.requestId, ws)).status).toBe(200);
    const back = await complete(srv.base, req.requestId);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st");
    const code = back.searchParams.get("code")!;
    // A code is handed out once
    expect((await fetch(`${srv.base}/oauth/requests/${req.requestId}/complete`, { method: "POST" })).status).toBe(409);

    const t = await tokenRequest(srv.base, { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: req.clientId, redirect_uri: REDIRECT });
    expect(t.headers.get("cache-control")).toBe("no-store");
    const tokens = await t.json();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect((await listTools(srv.base, tokens.access_token)).status).toBe(200);

    const r = await (await tokenRequest(srv.base, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: req.clientId })).json();
    expect(r.access_token).toBeTruthy();
    expect((await tokenRequest(srv.base, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: req.clientId })).status).toBe(400);
    expect((await listTools(srv.base, r.access_token)).status).toBe(200);
  });

  it("rejects a PKCE mismatch, unregistered redirect and wrong resource", async () => {
    srv = await startServer();
    const { ws } = await seed(srv.store);
    const req = await authorizeRequest(srv.base);
    await decide(srv.base, req.requestId, ws);
    const code = (await complete(srv.base, req.requestId)).searchParams.get("code")!;
    const bad = await tokenRequest(srv.base, { grant_type: "authorization_code", code, code_verifier: "x".repeat(50), client_id: req.clientId });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_grant");

    const q = (p: Record<string, string>) => fetch(`${srv.base}/oauth/authorize?${new URLSearchParams(p)}`, { redirect: "manual" });
    const base = { response_type: "code", client_id: req.clientId, code_challenge: "c".repeat(43), code_challenge_method: "S256" };
    expect((await q({ ...base, redirect_uri: "https://evil.example/cb" })).status).toBe(400);
    const wrong = await q({ ...base, redirect_uri: REDIRECT, resource: "https://other.example/mcp" });
    expect(new URL(wrong.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    const plain = await q({ ...base, redirect_uri: REDIRECT, code_challenge_method: "plain" });
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("deny and expiry send access_denied to the client", async () => {
    srv = await startServer();
    const { ws } = await seed(srv.store);
    const req = await authorizeRequest(srv.base);
    await decide(srv.base, req.requestId, ws, false);
    const back = await complete(srv.base, req.requestId);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("error_description")).toBe(DENIED);

    (srv.auth as unknown as { requestTtlMs: number }).requestTtlMs = 50;
    const late = await authorizeRequest(srv.base);
    await sleep(80);
    expect((await (await fetch(`${srv.base}/oauth/requests/${late.requestId}`)).json()).status).toBe("expired");
    expect((await decide(srv.base, late.requestId, ws)).status).toBe(410);
    expect((await complete(srv.base, late.requestId)).searchParams.get("error")).toBe("access_denied");
  });
});

describe("bearer auth on /mcp", () => {
  it("401 with resource metadata; the token selects the workspace; nothing below /mcp", async () => {
    srv = await startServer();
    const { ws } = await seed(srv.store);
    const other = await seed(srv.store);
    const none = await listTools(srv.base);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${srv.base}/.well-known/oauth-protected-resource/mcp"`);
    expect((await listTools(srv.base, "garbage")).status).toBe(401);

    const { token } = await grant(srv.base, ws);
    expect((await listTools(srv.base, token)).status).toBe(200);
    expect((await listTools(srv.base, token, `/mcp/${ws}`)).status).toBe(404);
    expect((await listTools(srv.base, token, `/mcp/${other.ws}`)).status).toBe(404);
  });

  it("revoking cuts access immediately with the REVOKED description", async () => {
    srv = await startServer();
    const { ws } = await seed(srv.store);
    const { token, clientId } = await grant(srv.base, ws, "Cursor");
    const list = await (await fetch(`${srv.base}/api/w/${ws}/agents`)).json();
    expect(list.agents.map((a: { name: string }) => a.name)).toEqual(["Cursor"]);
    expect((await fetch(`${srv.base}/api/w/${ws}/agents/${clientId}/revoke`, { method: "POST" })).status).toBe(200);
    const r = await listTools(srv.base, token);
    expect(r.status).toBe(401);
    expect((await r.json()).error_description).toBe(REVOKED);
    // Header values are ASCII
    expect(r.headers.get("www-authenticate")).toContain(`error_description="${REVOKED.replace("→", "->")}"`);
    expect((await (await fetch(`${srv.base}/api/w/${ws}/agents`)).json()).agents).toEqual([]);
  });

  it("the MCP SDK client completes the OAuth flow by itself", async () => {
    srv = await startServer();
    const { ws, pid } = await seed(srv.store);
    const browser = new FakeBrowser(`${srv.ws}/ws/${ws}`);
    await browser.open(pid);
    browser.handler = () => ({ ok: true, content: [{ type: "text", text: "[]" }] });

    let info: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let verifier = "";
    let code = "";
    const provider: OAuthClientProvider = {
      redirectUrl: REDIRECT,
      clientMetadata: { client_name: "Claude Code", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
      clientInformation: () => info,
      saveClientInformation: (i) => void (info = i),
      tokens: () => tokens,
      saveTokens: (t) => void (tokens = t),
      saveCodeVerifier: (v) => void (verifier = v),
      codeVerifier: () => verifier,
      // Plays the user: opens the consent page and allows
      async redirectToAuthorization(url) {
        const r = await fetch(url, { redirect: "manual" });
        const id = r.headers.get("location")!.split("/connect/")[1];
        await decide(srv.base, id, ws);
        code = (await complete(srv.base, id)).searchParams.get("code")!;
      },
    };
    const url = new URL(`${srv.base}/mcp`);
    let transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    let client = new Client({ name: "Claude Code", version: "2.1.0" });
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    await transport.finishAuth(code);
    transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    client = new Client({ name: "Claude Code", version: "2.1.0" });
    await client.connect(transport);
    const r = await client.callTool({ name: "list_parts", arguments: {} });
    expect(r.isError).toBeFalsy();
    // Version comes from the MCP handshake
    const agents = (await (await fetch(`${srv.base}/api/w/${ws}/agents`)).json()).agents;
    expect(agents[0]).toMatchObject({ name: "Claude Code", version: "2.1.0" });
    await client.close();
    browser.close();
  });
});
