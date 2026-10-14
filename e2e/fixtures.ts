import { test as base, expect, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { newSessionId } from "../shared/src/ids";

export type ToolResult = {
  isError?: boolean;
  content: { type: string; text?: string; data?: string; resource?: { uri: string; mimeType: string; blob: string } }[];
};

// Bytes of the embedded file in a tool result
export const resourceBytes = (r: ToolResult) => {
  const res = r.content.find((c) => c.type === "resource")?.resource;
  if (!res) throw new Error("no resource in result");
  return { ...res, bytes: Buffer.from(res.blob, "base64") };
};

// Opens the workspace's most recent project (creating one if empty); returns its id
export async function openApp(page: Page, ws: string, query = "") {
  const base = `/api/w/${ws}/projects`;
  const { projects } = await (await page.request.get(base)).json();
  const pid: string = projects[0]?.id ?? (await (await page.request.post(base, { data: {} })).json()).id;
  await page.goto(`/w/${ws}/p/${pid}${query}`);
  await expect(page.getByTestId("conn")).toHaveText("connected");
  await expect(page.getByTestId("loading")).toBeHidden({ timeout: 60_000 });
  return pid;
}

const REDIRECT = "http://localhost:9/cb";
export const pkce = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

// Starts an agent authorization like an MCP client would; returns the consent request id
export async function startAuth(baseURL: string, opts: { name?: string; resource?: string } = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const reg = await (await fetch(`${baseURL}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: opts.name ?? "e2e agent", redirect_uris: [REDIRECT] }),
  })).json();
  const q = new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, state: "st", code_challenge: pkce(verifier),
    code_challenge_method: "S256", resource: opts.resource ?? `${baseURL}/mcp`,
  });
  const r = await fetch(`${baseURL}/oauth/authorize?${q}`, { redirect: "manual" });
  return { requestId: r.headers.get("location")!.split("/connect/")[1], clientId: reg.client_id as string, verifier, redirect: REDIRECT };
}

// A pending request the workspace's tab shows: its client name was approved there before (the tab can't know a new name)
export async function requestFor(baseURL: string, ws: string, name = "e2e agent") {
  await grantToken(baseURL, ws, name);
  return startAuth(baseURL, { name });
}

// Approves a new agent for the workspace (what the user does on the consent page) and returns its token
export async function grantToken(baseURL: string, ws: string, name = "e2e agent") {
  const a = await startAuth(baseURL, { name });
  const post = (path: string, body?: unknown) =>
    fetch(`${baseURL}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method: "POST" });
  const d = await post("/oauth/decision", { requestId: a.requestId, workspaceId: ws, allow: true });
  if (!d.ok) throw new Error(`decision: ${d.status} ${await d.text()}`);
  const c = await post(`/oauth/requests/${a.requestId}/complete`);
  if (!c.ok) throw new Error(`complete: ${c.status} ${await c.text()}`);
  const code = new URL((await c.json()).redirect).searchParams.get("code")!;
  const t = await (await fetch(`${baseURL}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: a.verifier, client_id: a.clientId, redirect_uri: REDIRECT }),
  })).json();
  return { token: t.access_token as string, clientId: a.clientId };
}

export async function mcpClient(baseURL: string, ws: string, name = "e2e agent") {
  const { token, clientId } = await grantToken(baseURL, ws, name);
  const client = new Client({ name, version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, token, clientId };
}

export const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
export const json = (r: ToolResult) => JSON.parse(r.content[0].text!);

// sessionId: the workspace id (one per test)
type Fixtures = { sessionId: string; cad: Awaited<ReturnType<typeof mcpClient>> };

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  sessionId: async ({}, use) => use(newSessionId()),
  cad: async ({ baseURL, sessionId }, use) => {
    const c = await mcpClient(baseURL!, sessionId);
    await use(c);
    await c.client.close();
  },
});
export { expect };

// Opens the Share dialog (if needed), publishes, and returns the share URL; the dialog stays open
export async function publishShare(page: Page) {
  if (!(await page.getByTestId("share-dialog").isVisible())) await page.getByTestId("share-open").click();
  await page.getByTestId("publish").click();
  await expect(page.getByTestId("share-url")).toBeVisible();
  return (await page.getByTestId("share-url").textContent())!;
}

export const closeDialog = (page: Page) => page.keyboard.press("Escape");

// What the viewport shows, from the status line ("plate, 10 × 20 × 5 mm. …")
export const shown = (page: Page) => page.getByTestId("statusline").locator(".what");
// Console log: opens the drawer (optionally on a filter) and returns it
export async function openLog(page: Page, filter?: "all" | "agent" | "you" | "build" | "problems") {
  const log = page.getByTestId("console-log");
  if (!(await log.isVisible())) await page.getByTestId("console-toggle").click();
  await expect(log).toBeVisible();
  if (filter) await log.getByTestId(`log-filter-${filter}`).click();
  return log;
}

export async function openShare(page: Page) {
  if (!(await page.getByTestId("share-dialog").isVisible())) await page.getByTestId("share-open").click();
  await expect(page.getByTestId("share-dialog")).toBeVisible();
}

// Export… dialog: optional format and assembly switches, then Download; returns the download
export async function exportFromDialog(page: Page, opts: { format?: string; parts?: boolean; assembled?: boolean; quality?: string } = {}) {
  await page.getByTestId("export").click();
  const dlg = page.getByTestId("export-dialog");
  if (opts.format) await dlg.locator(`[data-format="${opts.format}"]`).click();
  if (opts.quality) await dlg.locator(`[data-quality="${opts.quality}"]`).click();
  for (const key of ["parts", "assembled"] as const) {
    if (opts[key] === undefined) continue;
    const sw = dlg.locator(`[data-include="${key}"]`);
    if ((await sw.getAttribute("aria-checked")) !== String(opts[key])) await sw.click();
  }
  const dl = page.waitForEvent("download", { timeout: 120_000 });
  const go = dlg.getByTestId("export-go");
  await go.click();
  // Slow builds offer a Download button instead of downloading straight away
  const ready = dlg.locator('[data-testid="export-go"][data-ready="true"]');
  const first = await Promise.race([dl.then(() => "download"), ready.waitFor({ timeout: 120_000 }).then(() => "ready")]);
  if (first === "ready") await ready.click();
  return dl;
}
