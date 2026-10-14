import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Direction } from "shared";
import { viewer } from "../scene";
import { setSections, useStore } from "../state";
import { togglePanel, useDismiss, useLayout, useNarrow, useShownPanels } from "./shell/Shell";
import { PRESETS, useNav } from "./navigation";
import { PanelIcon } from "./icons";
import { SectionCard, SectionPill } from "./SectionCard";
import { minimiseSection, useTools } from "./tools/state";
import { Viewport } from "./Viewport";
import { MeasureCard, toggleMeasure, useMeasure } from "./Measure";

const VIEWS: { dir: Direction; label: string; key: string }[] = [
  { dir: "iso", label: "Iso", key: "1" },
  { dir: "front", label: "Front", key: "2" },
  { dir: "top", label: "Top", key: "3" },
  { dir: "right", label: "Right", key: "4" },
];

export const fit = () => viewer.fit?.();
export function standardView(dir: Direction) {
  viewer.fit?.(dir);
  useStore.setState({ stdView: dir });
}
// Opens or closes the section bar (cutting follows)
export const toggleSection = () => setSections((s) => ({ ...s, open: !s.open }));

// Floating toolbar: Fit | standard views | Section | Measure
const ICON = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, viewBox: "0 0 24 24", "aria-hidden": true };
const FitIcon = () => <svg {...ICON}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>;
const SectionIcon = () => <svg {...ICON}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 12h16" strokeDasharray="2 3" /></svg>;
const MeasureIcon = () => <svg {...ICON}><path d="M3 17 17 3l4 4L7 21z" /><path d="M7 13l2 2M10 10l2 2M13 7l2 2" /></svg>;

// Full: four view buttons; compact (narrow viewport): one view button; tiny: icons for Fit, Section and Measure
export type ToolbarSize = "full" | "compact" | "tiny";

export function ViewToolbar({ section, size = "full" }: { section: boolean; size?: ToolbarSize }) {
  const std = useStore((s) => s.stdView);
  const sectionOn = useStore((s) => s.section.open);
  const measureOn = useMeasure((s) => s.on);
  const tiny = size === "tiny";
  const narrow = useNarrow() || size !== "full";
  const cycle = () => {
    const i = VIEWS.findIndex((v) => v.dir === std);
    standardView(VIEWS[(i + 1) % VIEWS.length].dir);
  };
  return (
    <div className="viewtools toolbar" role="toolbar" aria-label="View" data-testid="view-toolbar">
      <button className={`btn btn-ghost${tiny ? " btn-icon" : ""}`} onClick={fit} title="Fit view (F)" aria-label="Fit">{tiny ? <FitIcon /> : "Fit"}</button>
      <span className="toolbar-sep" />
      {narrow ? (
        <button className="btn btn-ghost" onClick={cycle} title="Next standard view">{VIEWS.find((v) => v.dir === std)?.label ?? "Iso"}{tiny ? "" : " view"}</button>
      ) : (
        <div className="views">
          {VIEWS.map((v) => (
            <button key={v.dir} className="btn btn-toggle" aria-pressed={std === v.dir} onClick={() => standardView(v.dir)} title={`${v.label} (${v.key})`}>{v.label}</button>
          ))}
        </div>
      )}
      {section && (
        <>
          <span className="toolbar-sep" />
          <button className={`btn btn-toggle${tiny ? " btn-icon" : ""}`} aria-pressed={sectionOn} onClick={toggleSection} title="Section (S)" aria-label="Section" data-testid="section-toggle">{tiny ? <SectionIcon /> : "Section"}</button>
        </>
      )}
      <span className="toolbar-sep" />
      <button className={`btn btn-toggle${tiny ? " btn-icon" : ""}`} aria-pressed={measureOn} onClick={toggleMeasure} title="Measure (M)" aria-label="Measure" data-testid="measure-toggle">{tiny ? <MeasureIcon /> : "Measure"}</button>
    </div>
  );
}

// Mouse preset and what scrolling does (trackpads: pan), remembered per browser. Hidden for now: not in the toolbar
export function NavMenu() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const { preset, scroll } = useNav();
  return (
    <div className="nav-menu" ref={ref}>
      <button className="btn btn-ghost btn-icon" aria-label="Navigation" title="Navigation: mouse and trackpad" aria-expanded={open}
        onClick={() => setOpen(!open)} data-testid="nav-toggle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <rect x="6" y="3" width="12" height="18" rx="6" /><path d="M12 7v4" />
        </svg>
      </button>
      {open && (
        <div className="nav-pop" data-testid="nav-menu">
          <div className="nav-title">Mouse</div>
          <div className="nav-presets btn-sm" role="radiogroup" aria-label="Mouse preset">
            {PRESETS.map((p) => (
              <button key={p.id} className="btn btn-ghost btn-block" role="radio" aria-checked={preset === p.id}
                onClick={() => useNav.setState({ preset: p.id })}>
                <span className="l">{p.label}</span><small>{p.hint}</small>
              </button>
            ))}
          </div>
          <div className="nav-title">Scroll and trackpad</div>
          <div className="seg btn-sm" role="radiogroup" aria-label="Scroll">
            <button className="btn" role="radio" aria-checked={scroll === "zoom"} onClick={() => useNav.setState({ scroll: "zoom" })}>Zoom</button>
            <button className="btn" role="radio" aria-checked={scroll === "pan"} onClick={() => useNav.setState({ scroll: "pan" })}>Pan</button>
          </div>
          <p className="nav-hint">
            {scroll === "zoom" ? "Scrolling zooms to the cursor." : "Two-finger scroll pans, Shift + scroll orbits, pinch zooms."}
            {" "}Orbit and pan pivot on the point under the cursor.
          </p>
        </div>
      )}
    </div>
  );
}

// Viewport with overlays; shared by the workspace and the share viewer
export function Stage({ overlay, rightLabel, loading, section = false }: {
  overlay?: ReactNode; rightLabel: string; loading?: string; section?: boolean;
}) {
  const shown = useShownPanels();
  const leftCollapsed = !shown.left;
  const rightCollapsed = !shown.right;
  const narrow = useNarrow();
  // Phone layout: the measure card is a bottom sheet that shrinks the viewport; elsewhere it stays top right
  // (by layout, not viewport width, so resizing the side panels doesn't move it)
  const sheet = narrow;
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<ToolbarSize>("full");
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(el.clientWidth < 420 ? "tiny" : el.clientWidth < 700 ? "compact" : "full"));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A panel hidden only for lack of room comes back by collapsing the other one
  const reopen = (side: "left" | "right") => {
    const l = useLayout.getState();
    const collapsed = side === "left" ? l.leftCollapsed : l.rightCollapsed;
    if (collapsed) togglePanel(side);
    else togglePanel(side === "left" ? "right" : "left");
  };
  // Tools: Section and Measure share a column top right (Section first); on phones the expanded one is a bottom sheet
  const sectionOpen = useStore((s) => s.section.open) && section;
  const sectionMin = useTools((t) => t.sectionMin);
  const last = useTools((t) => t.last);
  const measureOn = useMeasure((m) => m.on);
  const measureMin = useMeasure((m) => m.min);
  const stack = useRef<HTMLDivElement>(null);
  const tiny = size === "tiny";
  const stackTop = !narrow && (rightCollapsed || (tiny && leftCollapsed)) ? 54 : 12;
  // Only one card fits (phone, a viewport under 420 px, or both taller than the column): the one not used last minimises
  useLayoutEffect(() => {
    const check = () => {
      const both = sectionOpen && !useTools.getState().sectionMin && useMeasure.getState().on && !useMeasure.getState().min;
      if (!both) return;
      let exclusive = narrow || tiny;
      const el = stack.current;
      if (!exclusive && el) {
        // Natural heights: what each card would take without scrolling
        const natural = [...el.children].reduce((sum, c) => {
          const h = c as HTMLElement;
          const scrollers = [h, ...h.querySelectorAll<HTMLElement>(".tool-body, .mc-picks")];
          return sum + h.offsetHeight + scrollers.reduce((x, s) => x + Math.max(0, s.scrollHeight - s.clientHeight), 0);
        }, 0);
        exclusive = natural + 8 * (el.children.length - 1) > el.clientHeight + 1;
      }
      if (!exclusive) return;
      if (useTools.getState().last === "section") useMeasure.setState({ min: true });
      else minimiseSection();
    };
    check();
    const el = stack.current;
    if (!el) return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  }, [narrow, tiny, sectionOpen, sectionMin, measureOn, measureMin, last]);
  const sectionExpanded = sectionOpen && !sectionMin;
  const measureExpanded = measureOn && !measureMin;
  return (
    <div className="center">
      <div className="stage" ref={stage}>
        <div className="viewport"><Viewport /></div>
        {!narrow && leftCollapsed && (
          <div className="corner l"><button className="btn" onClick={() => reopen("left")} title="Show parts panel (L)" data-testid="show-left"><PanelIcon side="left" />Parts</button></div>
        )}
        {!narrow && rightCollapsed && (
          <div className="corner r"><button className="btn" onClick={() => reopen("right")} title="Show parameters panel (P)" data-testid="show-right"><PanelIcon side="right" />{rightLabel}</button></div>
        )}
        {overlay}
        <ViewToolbar section={section} size={size} />
        {!sheet && (sectionOpen || measureOn) && (
          <div className="tool-stack" ref={stack} style={{ "--stack-top": `${stackTop}px` } as React.CSSProperties}>
            {sectionOpen && (sectionMin ? <SectionPill /> : <SectionCard />)}
            {measureOn && <MeasureCard />}
          </div>
        )}
        {sheet && ((sectionOpen && sectionMin) || (measureOn && measureMin)) && (
          <div className="tool-pills">
            {sectionOpen && sectionMin && <SectionPill touch />}
            {measureOn && measureMin && <MeasureCard sheet />}
          </div>
        )}
        {loading && <div className="loading" data-testid="loading">{loading}</div>}
      </div>
      {sheet && (sectionExpanded || measureExpanded) && (
        <div className="tool-sheet-slot" ref={stack}>
          {sectionExpanded && (!measureExpanded || last === "section") ? <SectionCard sheet /> : <MeasureCard sheet />}
        </div>
      )}
    </div>
  );
}
