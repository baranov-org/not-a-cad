import { useEffect, useRef, useState } from "react";
import { defaults, validateValue, type Param, type ParamValue } from "shared";
import { assemblyOnlyParams } from "../assembly";
import { applyUserValues } from "../runtime";
import { useStore } from "../state";
import { Chevron } from "./icons";

const SLIDER_DEBOUNCE_MS = 350;
const FILTER_AT = 20;

// Why a value is rejected, in the field's own terms ("Max 300 mm")
function problem(p: Param, v: ParamValue): string | undefined {
  const e = validateValue(p, v);
  if (!e) return;
  if (p.type === "number" || p.type === "slider") {
    const unit = p.unit ? ` ${p.unit}` : "";
    if (typeof v !== "number" || !Number.isFinite(v)) return "Enter a number";
    if (p.max !== undefined && v > p.max) return `Max ${p.max}${unit}`;
    if (p.min !== undefined && v < p.min) return `Min ${p.min}${unit}`;
  }
  return e.charAt(0).toUpperCase() + e.slice(1);
}

const rangeOf = (p: Param) =>
  (p.type === "number" || p.type === "slider") && (p.min !== undefined || p.max !== undefined) ? `${p.min ?? "…"}–${p.max ?? "…"}` : undefined;

function Field({ p, value }: { p: Param; value: ParamValue }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Slider value waiting for its debounce; applied right away if the panel goes away
  const pending = useRef<() => void>(undefined);
  useEffect(() => {
    setDraft(String(value));
    setError(undefined);
  }, [value]);
  useEffect(() => () => {
    clearTimeout(timer.current);
    pending.current?.();
  }, []);

  const apply = (v: ParamValue) => {
    const e = problem(p, v);
    setError(e);
    if (!e && v !== value) void applyUserValues({ [p.name]: v });
  };
  const commit = () => apply(p.type === "number" ? (draft.trim() === "" ? NaN : Number(draft)) : draft);
  const onKey = (e: React.KeyboardEvent) => e.key === "Enter" && commit();
  const id = `param-${p.name}`;
  const unit = "unit" in p && p.unit ? <span className="unit">{p.unit}</span> : null;
  const range = rangeOf(p);

  let label = <label id={`${id}-label`} htmlFor={id}>{p.label}</label>;
  let control: React.ReactNode;
  switch (p.type) {
    case "number": {
      const step = p.step ?? 1;
      const nudge = (d: number) => {
        const n = Number(draft) + d;
        const v = Number.isFinite(n) ? Math.round(n / step) * step : value;
        setDraft(String(v));
        apply(v as number);
      };
      control = (
        <div className={`stepper btn-lg${error ? " invalid" : ""}`}>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={`Decrease ${p.label}`} onClick={() => nudge(-step)}>−</button>
          <input id={id} type="number" value={draft} min={p.min} max={p.max} step={p.step ?? "any"} aria-invalid={!!error}
            onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKey} />
          {unit}
          <button type="button" className="btn btn-ghost btn-icon" aria-label={`Increase ${p.label}`} onClick={() => nudge(step)}>+</button>
        </div>
      );
      break;
    }
    case "slider": {
      const n = Number(draft);
      control = (
        <input id={id} type="range" value={n} min={p.min} max={p.max} step={p.step ?? "any"}
          onChange={(e) => {
            const v = Number(e.target.value);
            setDraft(e.target.value);
            clearTimeout(timer.current);
            // Only the assembly reads it: re-pose live while dragging (no rebuild)
            if (assemblyOnlyParams().has(p.name)) {
              pending.current = undefined;
              apply(v);
              return;
            }
            // Rebuild once the drag pauses
            pending.current = () => {
              pending.current = undefined;
              apply(v);
            };
            timer.current = setTimeout(() => pending.current?.(), SLIDER_DEBOUNCE_MS);
          }} />
      );
      label = (
        <>
          <label id={`${id}-label`} htmlFor={id}>{p.label}</label>
          <span className="readout">{draft}{p.unit ? ` ${p.unit}` : ""}</span>
        </>
      );
      break;
    }
    case "checkbox":
      return (
        <div className="param param-checkbox" data-param={p.name}>
          <button id={id} type="button" className="switch-row" role="switch" aria-checked={value === true} onClick={() => apply(value !== true)}>
            <span className="l">{p.label}</span>
            <span className={`switch${value === true ? " on" : ""}`}><i /></span>
          </button>
          {p.description && <small className="desc">{p.description}</small>}
        </div>
      );
    case "radio":
      if (p.options.length <= 5) {
        control = (
          <div className="tiles btn-lg" role="radiogroup" aria-labelledby={`${id}-label`}>
            {p.options.map((o, i) => (
              <button key={i} type="button" className="btn" role="radio" aria-checked={o.value === value} onClick={() => apply(o.value)}>{o.label}</button>
            ))}
          </div>
        );
        label = <span className="l" id={`${id}-label`}>{p.label}</span>;
        break;
      }
    // falls through: many options render as a select
    case "select":
      control = (
        <select id={id} value={p.options.findIndex((o) => o.value === value)}
          onChange={(e) => apply(p.options[Number(e.target.value)].value)}>
          {p.options.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
        </select>
      );
      break;
    case "text":
      control = (
        <input id={id} type="text" value={draft} maxLength={p.maxLength} placeholder={p.placeholder} className={error ? "invalid" : ""}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKey} />
      );
      break;
  }

  return (
    <div className={`param param-${p.type}`} data-param={p.name}>
      <div className="lab">{label}{range && p.type === "number" && <span className="range">{range}</span>}</div>
      {control}
      {error && <small className="msg err" role="alert">{error}</small>}
      {p.description && <small className="desc">{p.description}</small>}
    </div>
  );
}

// Parameters tab; intro differs between the workspace and the share viewer
export function ParamsPanel({ intro }: { intro?: React.ReactNode }) {
  const { form, values } = useStore((s) => s.params);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!form.params.length) {
    return <>{intro}<p className="empty-box" data-testid="no-params">Parameters appear here when your agent defines them.</p></>;
  }
  const filter = q.trim().toLowerCase();
  const match = (p: Param) => !filter || p.label.toLowerCase().includes(filter) || p.name.toLowerCase().includes(filter);
  const fields = (ps: Param[]) => ps.filter(match).map((p) => <Field key={`${p.name}:${p.type}`} p={p} value={values[p.name] ?? p.default} />);
  const ungrouped = form.params.filter((p) => !p.group);
  return (
    <section className="params" data-testid="params">
      {intro}
      {form.params.length >= FILTER_AT && (
        <input type="search" className="pfilter" placeholder="Filter parameters" aria-label="Filter parameters" value={q}
          onChange={(e) => setQ(e.target.value)} data-testid="params-filter" />
      )}
      {fields(ungrouped)}
      {form.groups.map((g) => {
        const all = form.params.filter((p) => p.group === g.id);
        if (!all.some(match)) return null;
        const isOpen = !!filter || (open[g.id] ?? !g.collapsed);
        return (
          <div key={g.id} className="pgroup" data-group={g.id} data-open={isOpen}>
            <button className="pgroup-head" aria-expanded={isOpen} onClick={() => setOpen({ ...open, [g.id]: !isOpen })}>
              <Chevron open={isOpen} /><span className="t">{g.label}</span>
              <span className="count">{all.length} field{all.length === 1 ? "" : "s"}</span>
            </button>
            {isOpen && fields(all)}
          </div>
        );
      })}
    </section>
  );
}

export function ResetParams() {
  const form = useStore((s) => s.params.form);
  if (!form.params.length) return null;
  return <button className="btn" onClick={resetParams}>Reset to defaults</button>;
}

// Parameters the user moved off their defaults (mobile tab hint)
export function useChangedParams(): number {
  return useStore((s) => {
    const d = defaults(s.params.form);
    return s.params.form.params.filter((p) => s.params.values[p.name] !== undefined && s.params.values[p.name] !== d[p.name]).length;
  });
}

export const resetParams = () => void applyUserValues(defaults(useStore.getState().params.form));
