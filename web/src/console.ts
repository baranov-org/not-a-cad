import { create } from "zustand";
import type { ActivityEntry } from "./workspace";

// Universal log: local events of this page session merged with the project's server activity

export type Level = "info" | "ok" | "warn" | "error";
export type Kind = "agent" | "you" | "build" | "system";

export interface LogAction {
  label: string;
  run: () => void;
  // The action is offered only while this holds
  until?: () => boolean;
}

export interface LogEvent {
  id: string;
  at: number;
  kind: Kind;
  level: Level;
  who?: string;
  text: string;
  detail?: string;
  // Linkable part
  part?: string;
  action?: LogAction;
  // Project the event belongs to (none: shown everywhere)
  project?: string;
}

export const MAX_LOCAL = 200;
export const PAGE = 50;

export type Filter = "all" | "agent" | "you" | "build" | "problems";
export const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agent", label: "Agents" },
  { id: "you", label: "You" },
  { id: "build", label: "Builds" },
  { id: "problems", label: "Problems" },
];

export const matches = (e: LogEvent, f: Filter) =>
  f === "all" ? true : f === "problems" ? e.level === "error" || e.level === "warn" : e.kind === f;

// Server activity entry as a log event
export function fromActivity(e: ActivityEntry): LogEvent {
  const failed = !!e.detail?.endsWith("failed");
  return {
    id: `s${e.id}`,
    at: e.at,
    kind: e.who === "You" ? "you" : "agent",
    level: failed ? "error" : "info",
    who: e.who,
    text: e.object ? `${e.verb} ${e.object}` : e.verb,
    detail: e.detail ?? undefined,
    part: e.object ?? undefined,
  };
}

// Server pages merged by id, newest first
export function mergeServer(have: ActivityEntry[], page: ActivityEntry[]): ActivityEntry[] {
  const byId = new Map(have.map((e) => [e.id, e]));
  for (const e of page) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

// Local events of this project (and global ones) with server entries, newest first
export function mergeLog(local: LogEvent[], server: ActivityEntry[], project?: string): LogEvent[] {
  const mine = local.filter((e) => !e.project || e.project === project);
  return [...mine, ...server.map(fromActivity)].sort((a, b) => b.at - a.at);
}

interface ConsoleState {
  events: LogEvent[];
  // Server activity of the open project, loaded pages newest first
  server: { pid?: string; entries: ActivityEntry[]; more: boolean };
  filter: Filter;
  // Open project, tagged onto new events
  project?: string;
  // A console is on screen (else notices fall back to toasts)
  mounted: number;
}

export const useConsole = create<ConsoleState>(() => ({ events: [], server: { entries: [], more: false }, filter: "all", mounted: 0 }));

let seq = 0;
export function log(e: Omit<LogEvent, "id" | "at" | "level"> & { at?: number; level?: Level }): LogEvent {
  const ev: LogEvent = { level: "info", project: useConsole.getState().project, ...e, id: `l${++seq}`, at: e.at ?? Date.now() };
  useConsole.setState((s) => ({ events: [...s.events, ev].slice(-MAX_LOCAL) }));
  return ev;
}

export const setFilter = (filter: Filter) => useConsole.setState({ filter });

// ---- server pages

export interface ActivityApi {
  activity(pid: string, before?: number): Promise<{ entries: ActivityEntry[] }>;
}

// Newest page (on open and on each activity push), merged into the pages already loaded
export async function refreshServer(api: ActivityApi, pid: string) {
  const r = await api.activity(pid);
  useConsole.setState((s) => {
    const same = s.server.pid === pid;
    const entries = mergeServer(same ? s.server.entries : [], r.entries);
    return { server: { pid, entries, more: same ? s.server.more : r.entries.length === PAGE } };
  });
}

// "Older": the page before the oldest loaded entry
export async function olderServer(api: ActivityApi, pid: string) {
  const { server } = useConsole.getState();
  if (server.pid !== pid) return;
  const r = await api.activity(pid, server.entries.at(-1)?.id);
  useConsole.setState((s) => (s.server.pid === pid
    ? { server: { pid, entries: mergeServer(s.server.entries, r.entries), more: r.entries.length === PAGE } }
    : {}));
}
