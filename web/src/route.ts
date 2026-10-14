import { create } from "zustand";
import { isId } from "shared";

// The workspace id is a secret: it stays out of the address bar (kept in localStorage). "/w/<ws>" is only the
// bookmark link; opening it remembers the workspace and leaves a clean URL. Without storage the URL keeps it.
export type Route =
  | { kind: "library" }
  | { kind: "project"; pid: string }
  | { kind: "link"; ws: string; pid?: string }
  | { kind: "share"; id: string }
  | { kind: "connect"; id: string }
  | { kind: "notfound" };

// Set when this browser can't store the workspace
let urlWs: string | undefined;
export const keepWorkspaceInUrl = (ws: string) => (urlWs = ws);

export function parse(path: string): Route {
  if (path === "/" || path === "") return { kind: "library" };
  const s = path.match(/^\/s\/([^/]+)\/?$/);
  if (s) return isId(s[1]) ? { kind: "share", id: s[1] } : { kind: "notfound" };
  const c = path.match(/^\/connect\/([^/]+)\/?$/);
  if (c) return isId(c[1]) ? { kind: "connect", id: c[1] } : { kind: "notfound" };
  const p = path.match(/^\/p\/([^/]+)\/?$/);
  if (p) return isId(p[1]) ? { kind: "project", pid: p[1] } : { kind: "notfound" };
  const w = path.match(/^\/w\/([^/]+)(?:\/p\/([^/]+))?\/?$/);
  if (!w || !isId(w[1]) || (w[2] !== undefined && !isId(w[2]))) return { kind: "notfound" };
  if (w[1] === urlWs) return w[2] ? { kind: "project", pid: w[2] } : { kind: "library" };
  return { kind: "link", ws: w[1], pid: w[2] };
}

export const useRoute = create<{ route: Route }>(() => ({ route: parse(location.pathname) }));

// Client-side navigation (history API, no router library)
export function go(path: string, replace = false) {
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  useRoute.setState({ route: parse(path) });
}

addEventListener("popstate", () => useRoute.setState({ route: parse(location.pathname) }));

export const projectPath = (pid: string) => (urlWs ? `/w/${urlWs}/p/${pid}` : `/p/${pid}`);
export const libraryPath = () => (urlWs ? `/w/${urlWs}` : "/");
