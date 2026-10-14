import { isId, type AuthRequestInfo } from "shared";

const KEY = "cad.workspace";

// Workspace remembered by this browser
export function remembered(): string | undefined {
  try {
    const ws = localStorage.getItem(KEY);
    if (isId(ws)) return ws;
  } catch {
    // storage blocked
  }
}

const LIST = "cad.workspaces";

export function remember(ws: string) {
  try {
    localStorage.setItem(KEY, ws);
    localStorage.setItem(LIST, JSON.stringify([ws, ...rememberedList().filter((x) => x !== ws)].slice(0, 10)));
  } catch {
    // not remembered
  }
}

// All workspaces this browser opened, most recent first
export function rememberedList(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(LIST) ?? "[]");
    const cur = localStorage.getItem(KEY);
    const all = [...(isId(cur) ? [cur] : []), ...(Array.isArray(list) ? list.filter(isId) : [])];
    return [...new Set(all)];
  } catch {
    return [];
  }
}

export async function newWorkspace(): Promise<string> {
  const r = await fetch("/api/workspaces", { method: "POST" });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.id;
}

// Generic endpoint: the agent's token selects the workspace
export const mcpUrl = () => `${location.origin}/mcp`;
export const workspaceUrl = (ws: string) => `${location.origin}/w/${ws}`;

// "Save your link" stays highlighted until copied or marked saved in this browser
const savedKey = (ws: string) => `cad.linkSaved.${ws}`;
export function linkSaved(ws: string): boolean {
  try {
    return localStorage.getItem(savedKey(ws)) === "1";
  } catch {
    return false;
  }
}
export function markLinkSaved(ws: string) {
  try {
    localStorage.setItem(savedKey(ws), "1");
  } catch {
    // not remembered
  }
}

export interface ActivityEntry {
  id: number;
  at: number;
  who: string;
  verb: string;
  object: string | null;
  detail: string | null;
}

export interface ProjectCard {
  id: string;
  name: string;
  description?: string;
  created: number;
  updated: number;
  thumbnail: string | null;
  shared: boolean;
  forked: boolean;
  changedByAgent: boolean;
  active: boolean;
  agentHere: boolean;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
  return json as T;
}

// Library REST API
export const projectsApi = (ws: string) => {
  const base = `/api/w/${ws}/projects`;
  return {
    list: async () => (await call<{ projects: ProjectCard[] }>("GET", base)).projects,
    create: (body: { name?: string } | { fromShare: string; values?: Record<string, unknown> } = {}) =>
      call<{ id: string }>("POST", base, body),
    rename: (pid: string, name: string) => call("PATCH", `${base}/${pid}`, { name }),
    duplicate: (pid: string) => call<{ id: string }>("POST", `${base}/${pid}/duplicate`),
    remove: (pid: string) => call("DELETE", `${base}/${pid}`),
    restore: (pid: string) => call("POST", `${base}/${pid}/restore`),
    thumbnail: (pid: string, blob: Blob) =>
      fetch(`${base}/${pid}/thumbnail`, { method: "PUT", headers: { "content-type": blob.type }, body: blob }),
    share: (pid: string) => `${base}/${pid}/share`,
    activity: (pid: string, before?: number) =>
      call<{ entries: ActivityEntry[] }>("GET", `${base}/${pid}/activity${before ? `?before=${before}` : ""}`),
    report: (pid: string, verb: "exported", object: string) => call("POST", `${base}/${pid}/activity`, { verb, object }),
    agents: () => call<{ agents: unknown[]; denied: { name: string; at: number }[] }>("GET", `/api/w/${ws}/agents`),
    revoke: (clientId: string) => call("POST", `/api/w/${ws}/agents/${clientId}/revoke`),
  };
};

// OAuth consent: answer a pending agent connection request
export const authApi = {
  request: (id: string) => call<AuthRequestInfo>("GET", `/oauth/requests/${id}`),
  decide: (requestId: string, workspaceId: string, allow: boolean) => call("POST", "/oauth/decision", { requestId, workspaceId, allow }),
  complete: (id: string) => call<{ redirect: string }>("POST", `/oauth/requests/${id}/complete`),
};
