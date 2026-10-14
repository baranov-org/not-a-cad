import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { useStore } from "../state";
import { fit, standardView, toggleSection } from "./Stage";
import { clearPicks, toggleMeasure, useMeasure } from "./Measure";
import { minimiseSection, useTools } from "./tools/state";
import { anyModalOpen, CollapseButton, Side, togglePanel, useNarrow } from "./shell/Shell";
import { useChangedParams } from "./ParamsPanel";

export interface RightPanel {
  content: ReactNode;
  foot?: ReactNode;
}

// Footer actions as icons in the mobile tab bar (when the sheet's footer is hidden)
export interface BarAction {
  label: string;
  icon: "share" | "export" | "reset";
  kind?: "primary";
  disabled?: boolean;
  run: () => void;
  testid?: string;
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

// F fit, S section, M measure (Esc clears, then exits), P/L panels, 1–4 standard views; not while typing or with a modal open
export function useShortcuts(section = true) {
  useEffect(() => {
    const views = { "1": "iso", "2": "front", "3": "top", "4": "right" } as const;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || anyModalOpen()) return;
      const k = e.key.toLowerCase();
      if (k === "f") fit();
      else if (k === "s" && section) toggleSection();
      else if (k === "m") toggleMeasure();
      else if (k === "escape" && useMeasure.getState().on) {
        if (useMeasure.getState().picks.length) clearPicks();
        else toggleMeasure();
      }
      else if (k === "p") togglePanel("right");
      else if (k === "l") togglePanel("left");
      else if (k in views) standardView(views[k as keyof typeof views]);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [section]);
}

// Left panel | stage | right panel (parameters), with the console along the bottom; at narrow widths the stage on
// top, a tabbed sheet (parts, parameters) below, then the console
export function WorkLayout({ left, leftFoot, leftActions = [], right, rightActions = [], stage, console, section = true }: {
  left: ReactNode; leftFoot?: ReactNode; leftActions?: BarAction[]; right: RightPanel; rightActions?: BarAction[];
  stage: ReactNode; console: ReactNode; section?: boolean;
}) {
  const narrow = useNarrow();
  useShortcuts(section);

  if (narrow) {
    return (
      <div className="work">
        <MobileSheet stage={stage} parts={{ content: left, foot: leftFoot, actions: leftActions }} params={{ content: right.content, foot: right.foot, actions: rightActions }} />
        {console}
      </div>
    );
  }

  return (
    <div className="work">
      <div className="body">
        <Side side="left" testid="left-panel">
          <div className="scroll">{left}</div>
          {leftFoot && <div className="foot">{leftFoot}</div>}
        </Side>
        {stage}
        <Side side="right" testid="right-panel">
          <div className="panel-head">
            <h2>Parameters</h2>
            <CollapseButton side="right" label="parameters" />
          </div>
          <div className="scroll">{right.content}</div>
          {right.foot && <div className="foot">{right.foot}</div>}
        </Side>
      </div>
      {console}
    </div>
  );
}

// ---- narrow layout: the stage above a sheet whose tab bar is its handle; full, half or collapsed

type Det = "full" | "half" | "col";
const SHEET_KEY = "cad.sheet";
const TAB_H = 64;

interface SheetState {
  det: Det;
  last: Det; // height to reopen at
  prev?: Det; // height before measure mode collapsed it
  prevSection?: Det; // height before the section dock collapsed it
}

function loadSheet(): Partial<SheetState> & { tab?: "parts" | "params" } {
  try {
    return JSON.parse(localStorage.getItem(SHEET_KEY) ?? "{}");
  } catch {
    return {};
  }
}

const saved = loadSheet();
export const useSheet = create<SheetState>(() => ({ det: saved.det ?? "full", last: saved.last ?? "full" }));
if (saved.tab) useStore.setState({ sheetTab: saved.tab });
const saveSheet = () => {
  const { det, last } = useSheet.getState();
  try {
    localStorage.setItem(SHEET_KEY, JSON.stringify({ det, last, tab: useStore.getState().sheetTab }));
  } catch {
    // per-device convenience only
  }
};
useSheet.subscribe(saveSheet);
useStore.subscribe((s, p) => s.sheetTab !== p.sheetTab && saveSheet());

const narrowNow = () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 720px)").matches;

// The panel sheet and a tool sheet never share the screen: opening the panel shrinks the tools to pills
function minimiseTools() {
  const m = useMeasure.getState();
  if (m.on && !m.min) useMeasure.setState({ min: true });
  if (useStore.getState().section.open && !useTools.getState().sectionMin) minimiseSection();
}

// Opening a tab shrinks open tool cards to pills; while measuring the sheet opens at half
function openSheet(tab?: "parts" | "params") {
  const m = useMeasure.getState();
  minimiseTools();
  const { last } = useSheet.getState();
  useSheet.setState({ det: m.on ? "half" : last });
  if (tab) useStore.setState({ sheetTab: tab });
}
function collapseSheet() {
  const { det, last } = useSheet.getState();
  useSheet.setState({ det: "col", last: det === "col" ? last : det });
}

// Measure on collapses the sheet (the measure sheet takes its place), off restores it; the pill reopening collapses it
useMeasure.subscribe((m, p) => {
  if (!narrowNow()) return;
  if (m.on && !p.on) {
    const { det, last } = useSheet.getState();
    useSheet.setState({ prev: det, last: det === "col" ? last : det, det: "col" });
    if (m.min) useMeasure.setState({ min: false });
  } else if (!m.on && p.on) {
    const { prev } = useSheet.getState();
    if (prev) useSheet.setState({ det: prev, prev: undefined });
  } else if (m.on && p.min && !m.min) collapseSheet();
});

// The section sheet needs the room too: opening it collapses the sheet, closing it restores the height (if still collapsed)
useStore.subscribe((s, p) => {
  if (!narrowNow() || s.section.open === p.section.open) return;
  const { det, prevSection } = useSheet.getState();
  if (s.section.open) {
    if (det !== "col") useSheet.setState({ prevSection: det, last: det, det: "col" });
  } else if (prevSection) {
    useSheet.setState({ prevSection: undefined, ...(det === "col" ? { det: prevSection } : {}) });
  }
});
// Expanding the section pill takes the room back
useTools.subscribe((t, p) => {
  if (narrowNow() && p.sectionMin && !t.sectionMin && useStore.getState().section.open) collapseSheet();
});

const ICONS: Record<BarAction["icon"], ReactNode> = {
  share: <><path d="M9 11.5V2.5M5.5 6L9 2.5 12.5 6" /><path d="M4 9.5v5h10v-5" /></>,
  export: <><path d="M9 2.5v9M5.5 8L9 11.5 12.5 8" /><path d="M3 13.5v2h12v-2" /></>,
  reset: <><path d="M3.5 9a5.5 5.5 0 1 0 1.8-4.1" /><path d="M3.5 2.5v3h3" /></>,
};

interface Pane {
  content: ReactNode;
  foot?: ReactNode;
  actions: BarAction[];
}

function MobileSheet({ stage, parts, params }: { stage: ReactNode; parts: Pane; params: Pane }) {
  const tab = useStore((s) => s.sheetTab);
  const partCount = useStore((s) => Object.keys(s.parts).length);
  const changed = useChangedParams();
  const { det } = useSheet();
  const body = useRef<HTMLDivElement>(null);
  const [bodyH, setBodyH] = useState(0);
  const [dragT, setDragT] = useState<number>();
  const dragged = useRef(false);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Full keeps the viewport at 44%; half is a fifth of the screen
  const full = Math.max(0, Math.round(bodyH * 0.56) - TAB_H);
  const half = Math.min(full, Math.round(window.innerHeight * 0.2));
  const heights = { full, half, col: 0 };
  const T = dragT ?? heights[det];
  const pane = tab === "params" ? params : parts;
  const showFoot = dragT === undefined && det === "full";

  const tapTab = (id: "parts" | "params") => {
    if (dragged.current) return;
    if (id === tab) return det === "col" ? openSheet() : collapseSheet();
    if (det === "col") openSheet(id);
    else useStore.setState({ sheetTab: id });
  };

  // Drag anywhere on the bar: follow the finger, then snap to the nearest height; a fling goes one step
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".sheet-bar > .btn")) return;
    const y0 = e.clientY, T0 = T;
    let py = e.clientY, pt = performance.now(), v = 0, cur = T0;
    dragged.current = false;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      if (!dragged.current && Math.abs(dy) <= 6) return;
      dragged.current = true;
      const t = performance.now();
      if (t > pt) [v, py, pt] = [(ev.clientY - py) / (t - pt), ev.clientY, t];
      cur = Math.max(0, Math.min(full, T0 - dy));
      setDragT(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!dragged.current) return;
      // Holding still before letting go is a snap, not a fling
      if (performance.now() - pt > 100) v = 0;
      const stops = [0, half, full].filter((x, i, a) => a.indexOf(x) === i).sort((a, b) => a - b);
      const target = Math.abs(v) > 0.4
        ? v > 0 ? [...stops].reverse().find((x) => x < cur - 2) ?? 0 : stops.find((x) => x > cur + 2) ?? full
        : stops.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a));
      const next: Det = target === 0 ? "col" : target === full ? "full" : "half";
      setDragT(undefined);
      if (next === "col") collapseSheet();
      else {
        minimiseTools();
        useSheet.setState({ det: next, last: next });
      }
      setTimeout(() => (dragged.current = false), 60);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const tabs = [
    { id: "parts" as const, label: "Parts", meta: `${partCount} part${partCount === 1 ? "" : "s"}` },
    { id: "params" as const, label: "Parameters", meta: changed ? `${changed} changed` : "defaults" },
  ];
  return (
    <div className="body" ref={body}>
      {stage}
      <div className="sheet-bar" onPointerDown={down} data-det={dragT === undefined ? det : "drag"}>
        <button className="sheet-handle" aria-label={T > 0 ? "Collapse panel" : "Expand panel"}
          onClick={() => !dragged.current && (det === "col" ? openSheet() : collapseSheet())}><span /></button>
        <div className="sheet-tabs seg btn-lg" role="tablist" data-testid="sheet-tabs">
          {tabs.map((t) => (
            <button key={t.id} className="btn" role="tab" aria-selected={tab === t.id} aria-expanded={tab === t.id && T > 0} onClick={() => tapTab(t.id)}>
              <span className="l">{t.label}</span>
              <span className="m">{t.meta}</span>
            </button>
          ))}
        </div>
        {!showFoot && pane.actions.map((a) => (
          <button key={a.label} className={`btn btn-lg btn-icon${a.kind === "primary" ? " btn-primary" : ""}`} aria-label={a.label} title={a.label}
            disabled={a.disabled} onClick={a.run} data-testid={a.testid}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{ICONS[a.icon]}</svg>
          </button>
        ))}
      </div>
      <div className={`sheet${dragT === undefined ? " anim" : ""}`} data-testid="sheet" style={{ height: T }} inert={T === 0 && dragT === undefined}>
        <div className="scroll">{pane.content}</div>
        {showFoot && pane.foot && <div className="foot">{pane.foot}</div>}
      </div>
    </div>
  );
}

