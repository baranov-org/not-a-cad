import { addPlane, MAX_PLANES, PLANE_COLORS, removePlane, resetSections, updatePlane, type CutPlane, type SectionPlane, type Sections } from "../section";
import { setSections, useStore } from "../state";
import { EyeIcon } from "./icons";
import { fmt, ToolCard, ToolPill, ToolRow, ValueControl } from "./tools/Tool";
import { expandSection, minimiseSection, useTools } from "./tools/state";

// Section tool as a viewport card (Claude Design "Section Card"): plane rows with the selected plane's editor below it

const NORMAL: Record<SectionPlane, "x" | "y" | "z"> = { XY: "z", XZ: "y", YZ: "x" };
const AXIS = { x: 0, y: 1, z: 2 } as const;
const color = (p: CutPlane) => PLANE_COLORS[(p.id - 1) % PLANE_COLORS.length];

export const planeSummary = (p: CutPlane) =>
  `${NORMAL[p.plane]} ${fmt(p.offset, 2)}${p.tiltA || p.tiltB ? ` · ∠${fmt(p.tiltA, 0)}°/${fmt(p.tiltB, 0)}°` : ""}`;

const BinIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <path d="M2.5 4.5h11" /><path d="M6 4.5V3h4v1.5" /><path d="M4 4.5l.7 8.5h6.6l.7-8.5" />
  </svg>
);
const PlusIcon = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M8 3v10M3 8h10" /></svg>;
const FlipIcon = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 2v12" strokeDasharray="1.5 2" /><path d="M6 5 2.5 8 6 11z" /><path d="M10 5l3.5 3L10 11" /></svg>;

// Offset limit along the plane's normal: half the model's size on that axis
function useLimit(axis: "x" | "y" | "z") {
  const size = useStore((s) => s.viewSize);
  const radius = useStore((s) => s.sectionFrame.radius);
  const half = (size?.[AXIS[axis]] ?? 0) / 2;
  return Math.round((half > 0 ? half : Math.max(1, radius)) * 100) / 100;
}

export function SectionCard({ sheet = false }: { sheet?: boolean }) {
  const s = useStore((st) => st.section);
  const { tab } = useTools();
  const visible = s.planes.filter((p) => p.enabled).length;
  const status = !s.planes.length ? "No planes" : !visible ? "All hidden" : `${s.planes.length} ${s.planes.length > 1 ? "planes" : "plane"}`;
  const set = (i: number, patch: Partial<CutPlane>) => setSections((x) => updatePlane(x, i, patch));
  return (
    <ToolCard title="Section" status={status} sheet={sheet} testid="section-bar"
      onMinimise={minimiseSection} onClose={() => setSections((x) => ({ ...x, open: false }))}
      actions={<button className="btn btn-ghost" title="Reset all planes" onClick={() => setSections(resetSections)}>Reset</button>}
      hint={s.planes.length >= MAX_PLANES ? "Maximum 3 planes · S closes, planes are kept" : "S closes · planes are kept"}>
      {s.planes.length > 0 && !visible && (
        <div className="tool-inset">
          <strong>All planes hidden</strong>
          <span className="tool-note">Nothing is cut. Show a plane to cut again.</span>
          <div><button className="btn" onClick={() => setSections((x) => ({ ...x, planes: x.planes.map((p) => ({ ...p, enabled: true })) }))}>Show all</button></div>
        </div>
      )}
      {!s.planes.length && (
        <div className="tool-inset">
          <strong>No planes</strong>
          <span className="tool-note">Add a plane to cut the model.</span>
        </div>
      )}
      {s.planes.map((p, i) => (
        <ToolRow key={p.id} badge={p.id} color={color(p)} name={p.plane} summary={planeSummary(p)} muted={!p.enabled}
          expanded={i === s.selected} data={{ "data-plane": String(p.id) }}
          onToggle={() => setSections((x) => ({ ...x, selected: x.selected === i ? -1 : i }))}
          actions={<>
            <button className="btn btn-ghost btn-icon" aria-label={`${p.enabled ? "Hide" : "Show"} plane ${p.id}`} title={p.enabled ? "Hide this plane" : "Show this plane"}
              onClick={() => set(i, { enabled: !p.enabled })}><EyeIcon shown={p.enabled} size={14} /></button>
            <button className="btn btn-ghost btn-icon" aria-label={`Delete plane ${p.id}`} title="Delete plane"
              onClick={() => setSections((x) => removePlane(x, i))}><BinIcon /></button>
          </>}>
          <PlaneEditor plane={p} tab={tab} onChange={(patch) => set(i, patch)} />
        </ToolRow>
      ))}
      {s.planes.length < MAX_PLANES && (
        <div className="tool-item tool-add">
          <button className="btn btn-ghost" onClick={() => setSections(addPlane)} data-testid="section-add"><PlusIcon /><span>Add plane</span></button>
        </div>
      )}
    </ToolCard>
  );
}

function PlaneEditor({ plane: p, tab, onChange }: { plane: CutPlane; tab: "offset" | "tilt"; onChange: (patch: Partial<CutPlane>) => void }) {
  const axis = NORMAL[p.plane];
  const limit = useLimit(axis);
  return (
    <div className="tool-inset tool-editor">
      <div className="tool-editor-row">
        <div className="seg" role="radiogroup" aria-label="Orientation">
          {(["XY", "XZ", "YZ"] as const).map((a) => (
            <button key={a} className="btn" role="radio" aria-checked={p.plane === a} onClick={() => onChange({ plane: a, offset: 0 })}>{a}</button>
          ))}
        </div>
        <button className="btn" aria-pressed={p.flip} onClick={() => onChange({ flip: !p.flip })}><FlipIcon /><span>Flip</span></button>
      </div>
      <div className="seg" role="tablist" aria-label="Adjust">
        <button className="btn" role="tab" aria-selected={tab === "offset"} onClick={() => useTools.setState({ tab: "offset" })}>Offset</button>
        <button className="btn" role="tab" aria-selected={tab === "tilt"} onClick={() => useTools.setState({ tab: "tilt" })}>Tilt</button>
      </div>
      {tab === "offset" ? (
        <ValueControl id={`off-${p.id}`} label={`Offset ${axis}`} unit="mm" digits={2} step={0.1} min={-limit} max={limit}
          value={Math.max(-limit, Math.min(limit, p.offset))} onChange={(v) => onChange({ offset: v })}
          limitText={`At the model edge · limit ±${limit.toFixed(2)} mm`} />
      ) : (
        <>
          <ValueControl id={`ta-${p.id}`} label="Tilt A" unit="°" digits={1} step={1} min={-90} max={90}
            value={p.tiltA} onChange={(v) => onChange({ tiltA: v })} limitText="Limit ±90°" />
          <ValueControl id={`tb-${p.id}`} label="Tilt B" unit="°" digits={1} step={1} min={-90} max={90}
            value={p.tiltB} onChange={(v) => onChange({ tiltB: v })} limitText="Limit ±90°" />
        </>
      )}
    </div>
  );
}

// Minimised: a dot per plane (hollow when hidden), then the one plane's offset, or the count
export function sectionPill(s: Sections) {
  const dots = s.planes.map((p) => ({ color: color(p), on: p.enabled }));
  if (!s.planes.some((p) => p.enabled)) return { dots, label: "Section", unit: "all hidden" };
  if (s.planes.length === 1) {
    const p = s.planes[0];
    return { dots, label: `${p.plane} · ${NORMAL[p.plane]}`, value: fmt(p.offset, 2), unit: "mm" };
  }
  return { dots, label: "Section", value: String(s.planes.length), unit: "planes" };
}

export function SectionPill({ touch = false }: { touch?: boolean }) {
  const s = useStore((st) => st.section);
  return <ToolPill {...sectionPill(s)} touch={touch} title="Show section" onExpand={expandSection} testid="section-pill" />;
}
