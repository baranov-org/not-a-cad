import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { setFilter, type Filter } from "../../console";
import { useStore } from "../../state";
import { PanelIcon } from "../icons";

// ---- layout memory

export const PANEL = {
  left: { def: 300, min: 220, max: 480 },
  right: { def: 340, min: 260, max: 560 },
} as const;
const MIN_VIEWPORT = 320;
const LAYOUT_KEY = "cad.layout";

interface Layout {
  left: number;
  right: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  consoleOpen: boolean;
}

function loadLayout(): Layout {
  const def = { left: PANEL.left.def, right: PANEL.right.def, leftCollapsed: false, rightCollapsed: false, consoleOpen: false };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") };
  } catch {
    return def;
  }
}

export const useLayout = create<Layout>(loadLayout);
useLayout.subscribe((l) => {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    // not remembered
  }
});

export const togglePanel = (side: "left" | "right") =>
  useLayout.setState((l) => (side === "left" ? { leftCollapsed: !l.leftCollapsed } : { rightCollapsed: !l.rightCollapsed }));

// Opens the console log with a filter
export function openLog(filter?: Filter) {
  if (filter) setFilter(filter);
  useLayout.setState({ consoleOpen: true });
}

// ---- media

export function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

export const useNarrow = () => useMedia("(max-width: 720px)");

function useWindowWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  return w;
}

// Panel widths that fit the window: the viewport keeps MIN_VIEWPORT; panels shrink toward their minimum (right first),
// and hide when even that doesn't fit. Stored widths are untouched, so a wider window brings them back
export function useShownPanels(): { left: number; right: number } {
  const l = useLayout();
  const w = useWindowWidth();
  let left = l.leftCollapsed ? 0 : l.left, right = l.rightCollapsed ? 0 : l.right;
  let excess = left + right - (w - MIN_VIEWPORT);
  if (excess > 0 && right) { const cut = Math.min(excess, right - PANEL.right.min); right -= cut; excess -= cut; }
  if (excess > 0 && left) { const cut = Math.min(excess, left - PANEL.left.min); left -= cut; excess -= cut; }
  if (excess > 0 && right) { excess -= right; right = 0; }
  if (excess > 0 && left) left = 0;
  return { left, right };
}

// ---- side panel with a grip on its edge, like the mobile sheet: drag to resize (follows the pointer; released below
// half the minimum it collapses, near the default it snaps to it), click to collapse or reopen; collapsed, a rail keeps the grip

const SNAP = 16;

export function Side({ side, children, testid }: { side: "left" | "right"; children: ReactNode; testid?: string }) {
  const stored = useLayout((l) => l[side]);
  const shown = useShownPanels()[side];
  // No room for it at all: hidden (the corner button reopens it on a wider window)
  if (!shown && !useLayout.getState()[side === "left" ? "leftCollapsed" : "rightCollapsed"]) return null;
  return <SideBody side={side} stored={stored} shown={shown} testid={testid}>{children}</SideBody>;
}

function SideBody({ side, stored, shown, children, testid }: { side: "left" | "right"; stored: number; shown: number; children: ReactNode; testid?: string }) {
  const width = shown || stored;
  const collapsed = useLayout((l) => (side === "left" ? l.leftCollapsed : l.rightCollapsed));
  const [dragW, setDragW] = useState<number>();
  const moved = useRef(false);
  const lim = PANEL[side];
  const key = side === "left" ? "leftCollapsed" : "rightCollapsed";
  const room = () => {
    const l = useLayout.getState();
    const other = side === "left" ? (l.rightCollapsed ? 0 : l.right) : (l.leftCollapsed ? 0 : l.left);
    return window.innerWidth - other - MIN_VIEWPORT;
  };
  const settle = (raw: number, snap = true) => {
    if (raw < lim.min / 2) return useLayout.setState({ [key]: true } as Partial<Layout>);
    let w = Math.max(lim.min, Math.min(lim.max, room(), raw));
    if (snap && Math.abs(w - lim.def) <= SNAP) w = Math.min(lim.def, room());
    useLayout.setState({ [side]: Math.round(w), [key]: false } as Partial<Layout>);
  };
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = collapsed ? 0 : width;
    let raw = w0;
    moved.current = false;
    const move = (ev: PointerEvent) => {
      const dx = side === "left" ? ev.clientX - x0 : x0 - ev.clientX;
      if (!moved.current && Math.abs(dx) <= 3) return;
      moved.current = true;
      raw = w0 + dx;
      setDragW(Math.max(0, Math.min(lim.max, room(), raw)));
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      setDragW(undefined);
      if (moved.current) settle(raw);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  // A click (no drag) collapses or reopens
  const click = () => {
    if (moved.current) return;
    useLayout.setState({ [key]: !collapsed } as Partial<Layout>);
  };
  const keys = (e: React.KeyboardEvent) => {
    const grow = e.key === (side === "left" ? "ArrowRight" : "ArrowLeft") ? 1 : e.key === (side === "left" ? "ArrowLeft" : "ArrowRight") ? -1 : 0;
    if (!grow) return;
    e.preventDefault();
    settle(collapsed ? width : width + grow * 16, false);
  };
  const grip = (
    <button className={`grip${dragW !== undefined ? " drag" : ""}`} role="separator" aria-orientation="vertical"
      aria-valuenow={collapsed ? 0 : width} aria-valuemin={0} aria-valuemax={lim.max}
      aria-label={`${collapsed ? "Open" : "Resize or collapse"} ${side === "left" ? "parts" : "parameters"} panel`}
      title={collapsed ? "Click or drag to open" : "Drag to resize, click to collapse"}
      data-testid={`resize-${side}`} onPointerDown={start} onClick={click} onKeyDown={keys}><span /></button>
  );
  if (collapsed && dragW === undefined) return <div className={`side-rail ${side}`}>{grip}</div>;
  const w = dragW ?? width;
  return (
    <aside className={`side ${side}${dragW === undefined ? " anim" : ""}`} style={{ width: w, ["--side-min" as string]: `${lim.min}px` }} data-testid={testid}>
      {children}
      {grip}
    </aside>
  );
}

export function CollapseButton({ side, label }: { side: "left" | "right"; label: string }) {
  return (
    <button className="btn btn-icon" title={`Hide ${label} panel (${side === "left" ? "L" : "P"})`} aria-label={`Hide ${label}`}
      data-testid={`collapse-${side}`} onClick={() => togglePanel(side)}>
      <PanelIcon side={side} />
    </button>
  );
}

// ---- modal: centred with a scrim, bottom sheet when narrow; Esc closes; focus stays inside

export function Modal({ label, onClose, children, size, testid }: {
  label: string; onClose?: () => void; children: ReactNode; size?: "wide" | "small"; testid?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const before = document.activeElement as HTMLElement | null;
    const focusable = () => [...el.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
      .filter((x) => !x.hasAttribute("disabled"));
    // Focus the dialog itself; Tab moves into it
    el.focus();
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost modal reacts
      const scrims = document.querySelectorAll(".scrim");
      if (scrims[scrims.length - 1] !== el.parentElement) return;
      if (e.key === "Escape" && onClose) {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const f = focusable();
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div ref={ref} className={`modal${size ? ` ${size}` : ""}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-testid={testid}>
        {children}
      </div>
    </div>
  );
}

export const anyModalOpen = () => document.querySelector(".scrim") !== null;

// ---- popover dismissal (outside click, Esc)

export function useDismiss<T extends HTMLElement = HTMLDivElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !anyModalOpen()) close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

// ---- toasts

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-testid="toast">
          <span className="t">{t.text}</span>
          {t.action && <button className="btn btn-sm" onClick={t.action.run}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}

// Clipboard API needs a secure context; fall back for plain http on LAN
export async function copyText(text: string) {
  if (navigator.clipboard) await navigator.clipboard.writeText(text);
  else {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function CopyButton({ text, label = "Copy", className = "btn btn-sm" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className={className} onClick={async () => {
      await copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }}>{copied ? "Copied" : label}</button>
  );
}

// Durations: "310 ms", "1.4 s"
export const dur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export function useNow(ms = 250, active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}

const DAY = 86_400_000;
// "just now", "2 h ago", "yesterday", "3 days ago", "last week", "Sep 28"
export function when(t: number) {
  const ms = Math.max(0, Date.now() - t);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / 3_600_000)} h ago`;
  if (ms < 2 * DAY) return "yesterday";
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)} days ago`;
  if (ms < 14 * DAY) return "last week";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

