import { useState, type ReactNode } from "react";
import { CloseIcon } from "../icons";

// Shared pieces of the viewport tool cards (Section, Measure): card, row, pill, value control, stack

// "−12.50": true minus sign, fixed decimals
export const fmt = (v: number, digits: number) => (v < 0 && Math.abs(v) >= 0.5 * 10 ** -digits ? "−" : "") + Math.abs(v).toFixed(digits);
const parse = (s: string) => parseFloat(s.replace(/[−–]/g, "-").replace(",", "."));

export const Chevron = ({ dir }: { dir: "up" | "down" }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden style={{ transform: dir === "up" ? "rotate(180deg)" : undefined }}>
    <path d="M2 4l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.6" />
  </svg>
);

export function ToolCard({ title, status, actions, sheet, hint, onMinimise, onClose, children, testid }: {
  title: string; status?: string; actions?: ReactNode; sheet?: boolean; hint?: string;
  onMinimise: () => void; onClose?: () => void; children: ReactNode; testid?: string;
}) {
  return (
    <section className={sheet ? "tool-card is-sheet" : "tool-card"} aria-label={title} data-testid={testid}>
      {sheet && <span className="tool-grab" aria-hidden />}
      <header className="tool-head">
        <h3 className="tool-title">{title}</h3>
        {status && <span className="tool-status">{status}</span>}
        <span className="grow" />
        <div className="btn-cluster">
          {actions}
          <button className="btn btn-ghost btn-icon" aria-label="Minimise" title="Minimise" onClick={onMinimise}>
            <Chevron dir={sheet ? "down" : "up"} />
          </button>
          {onClose && (
            <button className="btn btn-ghost btn-icon" aria-label={`Close ${title.toLowerCase()}`} title={`Close ${title.toLowerCase()}`} onClick={onClose}>
              <CloseIcon />
            </button>
          )}
        </div>
      </header>
      <div className="tool-body">{children}</div>
      {hint && <p className="tool-hint">{hint}</p>}
    </section>
  );
}

export function ToolPill({ dots, label, value, unit, touch, title, onExpand, testid }: {
  dots: { color: string; on: boolean }[]; label: string; value?: string; unit?: string; touch?: boolean; title: string;
  onExpand: () => void; testid?: string;
}) {
  return (
    <button className={touch ? "tool-pill is-touch" : "tool-pill"} title={title} onClick={onExpand} data-testid={testid}>
      <span className="tool-dots">
        {dots.map((d, i) => <span key={i} className={d.on ? "tool-dot" : "tool-dot is-off"} style={{ color: d.color }} />)}
      </span>
      <span className="lbl">{label}</span>
      {value && <span className="val">{value}</span>}
      {unit && <span className="unit">{unit}</span>}
      <Chevron dir="up" />
    </button>
  );
}

export function ToolRow({ badge, color, name, summary, muted, expanded, onToggle, actions, children, data }: {
  badge: ReactNode; color: string; name: string; summary: string; muted?: boolean; expanded: boolean;
  onToggle: () => void; actions?: ReactNode; children?: ReactNode; data?: Record<string, string>;
}) {
  return (
    <div className="tool-item" {...data}>
      <div className={muted ? "tool-row is-muted" : "tool-row"}>
        <button className="tool-row-main" aria-expanded={expanded} onClick={onToggle}>
          <span className="tool-badge" style={{ background: color }}>{badge}</span>
          <span className="tool-name">{name}</span>
          <span className="tool-key">{summary}</span>
        </button>
        {actions && <div className="btn-cluster tool-actions">{actions}</div>}
      </div>
      {expanded && children}
    </div>
  );
}

// Fixed-width field over a full-width slider; the field never resizes, so the slider never moves.
// Enter or blur commits, Esc reverts, ↑ ↓ step (Shift × 10); out-of-range input clamps
export function ValueControl({ id, label, value, unit, min, max, step, digits, limitText, onChange }: {
  id: string; label: string; value: number; unit: string; min: number; max: number; step: number; digits: number;
  limitText: string; onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (x: number) => Math.min(max, Math.max(min, Math.round(x * 10 ** digits) / 10 ** digits));
  const commit = (raw: string) => {
    const x = parse(raw);
    if (!Number.isNaN(x)) onChange(clamp(x));
    setDraft(null);
  };
  const span = Math.max(-min, max) || 1;
  const lo = 50 + (Math.min(0, value) / span) * 50, hi = 50 + (Math.max(0, value) / span) * 50;
  const atLimit = value <= min || value >= max;
  return (
    <div className="tool-ctl">
      <label htmlFor={id}>{label}</label>
      <span className={atLimit ? "num is-limit" : "num"}>
        <input id={id} inputMode="decimal" autoComplete="off" aria-label={label} value={draft ?? fmt(value, digits)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => draft !== null && commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
            else if (e.key === "Escape") { setDraft(null); e.currentTarget.blur(); }
            else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              setDraft(null);
              onChange(clamp(value + step * (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1)));
            }
          }} />
        <span>{unit}</span>
      </span>
      <input className="tool-range" type="range" aria-label={`${label} slider`} min={min} max={max} step={step / 10} value={value}
        style={{ "--lo": `${lo}%`, "--hi": `${hi}%` } as React.CSSProperties} onChange={(e) => onChange(clamp(+e.target.value))} />
      {atLimit && <span className="tool-limit">{limitText}</span>}
    </div>
  );
}
