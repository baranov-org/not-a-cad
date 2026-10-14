import { create } from "zustand";
import { defaultSections, type Sections } from "./section";
import { emptyGroups, emptyParams, type AgentInfo, type AuthRequestInfo, type Assembly, type ModelInfo, type Params, type PartGroups, type Placed } from "shared";
import type { BuildRound, PartInfo } from "./kernel/engine";
import type { Direction } from "shared";
import type { ProjectCard } from "./workspace";

export type ConnState = "connecting" | "connected" | "disconnected" | "superseded";
export type View = { kind: "part"; name: string } | { kind: "assembly" };

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

interface State {
  conn: ConnState;
  kernelReady: boolean;
  parts: Record<string, PartInfo>;
  meshVersion: number;
  // Evaluated assembly (placed instances); its source (flat list, tree or script) and the last evaluation error
  assembly: { instances: Placed[] };
  assemblySource: Assembly;
  assemblyError?: string;
  params: Params;
  info: ModelInfo;
  groups: PartGroups;
  // View-only: hidden assembly instance keys; capturing renders everything (agent screenshots)
  hidden: Set<string>;
  capturing: boolean;
  // View-only section planes; frame = centre/radius of the visible model
  section: Sections;
  sectionFrame: { center: [number, number, number]; radius: number };
  view: View;
  fitRequest: number;
  toasts: Toast[];
  // Open project: restored once the server sent its model
  restored: boolean;
  // Library cards (also feed the project switcher)
  projects: ProjectCard[];
  // Agent access
  authRequests: AuthRequestInfo[];
  approvalOpen: boolean;
  agents: AgentInfo[];
  // Bumped when the open project's activity changed
  activityVersion: number;
  lastRound?: BuildRound;
  // Size of what is shown (mm), for the console status
  viewSize?: [number, number, number];
  // Standard view in use until the user orbits
  stdView: Direction | null;
  // Part whose error card is open
  openError?: string;
  // Narrow layout: which sheet tab shows
  sheetTab: "parts" | "params";
  shareOpen: boolean;
  // Workspace link popover in the top bar
  linkOpen: boolean;
  exportOpen: boolean;
}

export const useStore = create<State>(() => ({
  conn: "connecting",
  kernelReady: false,
  parts: {},
  meshVersion: 0,
  assembly: { instances: [] },
  assemblySource: { instances: [] },
  params: emptyParams(),
  info: {},
  groups: emptyGroups(),
  hidden: new Set(),
  capturing: false,
  section: defaultSections(),
  sectionFrame: { center: [0, 0, 0], radius: 50 },
  view: { kind: "assembly" },
  fitRequest: 0,
  toasts: [],
  restored: false,
  projects: [],
  authRequests: [],
  approvalOpen: false,
  agents: [],
  activityVersion: 0,
  stdView: "iso",
  sheetTab: "parts",
  shareOpen: false,
  linkOpen: false,
  exportOpen: false,
}));

export const setView = (view: View) => useStore.setState((s) => ({ view, fitRequest: s.fitRequest + 1 }));

let toastId = 0;
// Library page only: bottom-left, at most 3; 3.5 s, or 7 s with an action
export function toast(text: string, action?: Toast["action"], ttlMs = action ? 7000 : 3500) {
  const t = { id: ++toastId, text, action };
  useStore.setState((s) => ({ toasts: [...s.toasts, t].slice(-3) }));
  setTimeout(() => dismissToast(t.id), ttlMs);
  return t.id;
}
export const dismissToast = (id: number) => useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));

// Hidden instances are kept by key across re-posing; keys that no longer exist are forgotten
useStore.subscribe((s, prev) => {
  if (s.assembly === prev.assembly || !s.hidden.size) return;
  const keys = new Set(s.assembly.instances.map((i) => i.key));
  const kept = [...s.hidden].filter((k) => keys.has(k));
  if (kept.length !== s.hidden.size) useStore.setState({ hidden: new Set(kept) });
});

export function toggleHidden(keys: string[]) {
  const hidden = new Set(useStore.getState().hidden);
  const anyVisible = keys.some((k) => !hidden.has(k));
  for (const k of keys) {
    if (anyVisible) hidden.add(k);
    else hidden.delete(k);
  }
  useStore.setState({ hidden });
}

export const setSections = (f: (s: Sections) => Sections) => useStore.setState((s) => ({ section: f(s.section) }));
