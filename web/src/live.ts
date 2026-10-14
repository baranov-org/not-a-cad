import { emptyModel, hasAssembly, type Model, type ModelInfo } from "shared";
import { setAssemblySource } from "./assembly";
import { makeHandlers } from "./handlers";
import { RelayClient } from "./relay";
import { go, projectPath, useRoute, type Route } from "./route";
import { engine, setParamsSaver } from "./runtime";
import { viewer } from "./scene";
import { log, useConsole } from "./console";
import { startFavicon } from "./favicon";
import { startLogSources } from "./logSources";
import { setView, useStore } from "./state";
import { projectsApi } from "./workspace";

// Key-order independent JSON for comparing models
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x);

let workspace = "";
const api = () => projectsApi(workspace);

// Restore on open/(re)connect; skip the rebuild when the browser already has this model
let loaded: string | undefined;
// Set when the user (not the agent) opened the project: announce it on restore
let announce = false;
// Set when an agent switched the tab: logged on restore, once the project's name is known
let switched: { project: string; by?: string; prev: string; prevName: string } | undefined;

function setModel(model: Model) {
  useStore.setState({ params: model.params, info: model.info, groups: model.groups });
  setAssemblySource(model.assembly, model.params);
  void engine.load(model);
}

export const relay = new RelayClient(makeHandlers(engine), {
  restore(project, model) {
    const st = useStore.getState();
    const current = stable({ parts: Object.fromEntries(engine.sources), assembly: st.assemblySource, params: engine.params, info: st.info, groups: st.groups });
    const incoming = stable({ parts: model.parts, assembly: model.assembly, params: model.params, info: model.info, groups: model.groups });
    useStore.setState({ restored: true });
    const name = model.info.name ?? "Untitled";
    if (announce) log({ kind: "system", text: `Your agent now works on ${name}` });
    announce = false;
    if (switched?.project === project) {
      const { prev, prevName, by } = switched;
      log({
        kind: "agent", who: by ?? "Your agent", text: `switched to ${name}. You followed.`,
        action: { label: `Back to ${prevName}`, run: () => openProject(prev), until: () => relay.project === project },
      });
    }
    switched = undefined;
    if (loaded !== undefined && incoming === current) return;
    loaded = incoming;
    const first = Object.keys(model.parts).sort()[0];
    setView(hasAssembly(model.assembly) || !first ? { kind: "assembly" } : { kind: "part", name: first });
    setModel(model);
  },
  navigate(project, by) {
    const r = useRoute.getState().route;
    const prev = r.kind === "project" ? r.pid : undefined;
    const prevName = useStore.getState().info.name ?? "Untitled";
    switched = prev && prev !== project ? { project, by, prev, prevName } : undefined;
    go(projectPath(project));
  },
});

// Last build durations per project, so "~36 s" survives reloads
function loadTimings(pid: string | null) {
  const key = pid && `cad.timings.${pid}`;
  let t: Record<string, number> = {};
  try {
    if (key) t = JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    t = {};
  }
  engine.setTimings(t, (next) => {
    try {
      if (key) localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // not remembered
    }
  });
}

// User opens a project (switcher, library, Back to)
export function openProject(pid: string) {
  announce = true;
  switched = undefined;
  go(projectPath(pid));
}

// Follow the route: tell the server which project this tab shows
function onRoute(route: Route) {
  const pid = route.kind === "project" ? route.pid : null;
  if (pid === relay.project) return;
  void saveThumbnail();
  if (pid === null) announce = false;
  useConsole.setState({ project: pid ?? undefined });
  loaded = undefined;
  useStore.setState({ restored: false, hidden: new Set() });
  setModel(emptyModel());
  loadTimings(pid);
  relay.open(pid);
}

export function startLive(ws: string) {
  workspace = ws;
  // Chrome doesn't freeze background tabs that hold a Web Lock: agent calls keep working while you're elsewhere
  void navigator.locks?.request(`not-a-cad-tab-${Date.now()}-${Math.random()}`, () => new Promise<void>(() => {})).catch(() => undefined);
  startLogSources();
  startFavicon();
  const r = useRoute.getState().route;
  relay.project = r.kind === "project" ? r.pid : null;
  useConsole.setState({ project: relay.project ?? undefined });
  loadTimings(relay.project);
  relay.connect(ws);
  useRoute.subscribe((s) => onRoute(s.route));
  document.addEventListener("visibilitychange", () => {
    relay.setVisible(document.visibilityState === "visible");
    if (document.visibilityState === "hidden") void saveThumbnail();
  });
  // Thumbnail after builds settle
  useStore.subscribe((s, prev) => {
    if (s.meshVersion !== prev.meshVersion) scheduleThumbnail();
  });
}

setParamsSaver((params) => relay.sendChanges({ params }));

// User edits of name/description (Share dialog)
export function saveInfo(info: ModelInfo) {
  useStore.setState({ info });
  relay.sendChanges({ info });
}

// ---- thumbnails

let thumbTimer: ReturnType<typeof setTimeout> | undefined;
let thumbSaved: { pid: string; version: number } | undefined;

function scheduleThumbnail() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => void engine.idle().then(saveThumbnail), 2000);
}

// Uploads a snapshot of the open project when its geometry changed since the last one
async function saveThumbnail() {
  clearTimeout(thumbTimer);
  const pid = relay.project;
  const st = useStore.getState();
  if (!pid || !st.restored || !viewer.thumbnail || !Object.keys(st.parts).length) return;
  if (Object.values(st.parts).some((p) => p.status === "building")) return;
  if (thumbSaved?.pid === pid && thumbSaved.version === st.meshVersion) return;
  // 4:3 like the library card, sharp on 2x screens
  const blob = viewer.thumbnail(640, 480);
  if (!blob) return;
  thumbSaved = { pid, version: st.meshVersion };
  await api().thumbnail(pid, blob).catch(() => undefined);
}
