import { useState } from "react";
import { download } from "../scene";
import { useStore } from "../state";
import { currentPlan, runExport, viewTarget, type ExportFile, type Quality } from "../export/run";
import { FORMATS, type Format, type Include } from "../export/plan";
import { CloseIcon } from "./icons";
import { Modal } from "./shell/Shell";

const KEY = "cad.export";
interface Choice extends Include {
  format: Format;
  quality: Quality;
}

const QUALITIES: { id: Quality; label: string; note: string }[] = [
  { id: "draft", label: "Draft", note: "The viewer's mesh, instant" },
  { id: "normal", label: "Normal", note: "Smooth curves for printing" },
  { id: "fine", label: "Fine", note: "Twice as tight, bigger files" },
];

function loadChoice(): Choice {
  const def: Choice = { format: "stl", parts: true, assembled: true, quality: "normal" };
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      ...def, ...c,
      format: FORMATS.some((f) => f.id === c.format) ? c.format : "stl",
      quality: QUALITIES.some((q) => q.id === c.quality) ? c.quality : "normal",
    };
  } catch {
    return def;
  }
}

function saveChoice(c: Choice) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // not remembered
  }
}

// Export dialog: format, what to include, the files you'll get (docs/design)
export function ExportDialog({ onExported }: { onExported?: (file: string) => void }) {
  const open = useStore((s) => s.exportOpen);
  if (!open) return null;
  return <ExportContent close={() => useStore.setState({ exportOpen: false })} onExported={onExported} />;
}

function ExportContent({ close, onExported }: { close: () => void; onExported?: (file: string) => void }) {
  const [choice, setChoice] = useState(loadChoice);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<ExportFile>();
  const [error, setError] = useState<string>();
  useStore((s) => s.parts);
  const instances = useStore((s) => s.assembly.instances);
  const part = viewTarget();
  const plan = currentPlan({ part, format: choice.format, include: choice });
  const isAsm = !part;
  const unique = new Set(instances.map((i) => i.part)).size;
  const set = (c: Partial<Choice>) => {
    const next = { ...choice, ...c };
    setChoice(next);
    saveChoice(next);
    setReady(undefined);
  };

  const go = async () => {
    if (ready) {
      download(ready);
      onExported?.(ready.file);
      return close();
    }
    setBusy(true);
    setError(undefined);
    const t = performance.now();
    try {
      const f = await runExport({ part, format: choice.format, include: choice, quality: choice.quality });
      // Browsers drop downloads started long after the click; offer a button instead
      if (performance.now() - t < 800) {
        download(f);
        onExported?.(f.file);
        close();
      } else setReady(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const merged = choice.format === "stl" || choice.format === "obj";
  const includes = [
    { key: "parts" as const, label: "Each part, ready to print", note: "One file per unique part, resting on Z = 0" },
    { key: "assembled" as const, label: "Assembled model", note: merged ? "Every instance in place, merged into one mesh" : "Every instance in place, parts kept as separate objects" },
  ];
  const nothing = isAsm && !choice.parts && !choice.assembled;
  const cta = ready ? `Download ${ready.file}` : busy ? (choice.format === "step" ? "Preparing exact geometry…" : "Preparing…") : plan.download ? `Download ${plan.download}` : "Download";
  return (
    <Modal label="Export" onClose={close} testid="export-dialog">
      <div className="modal-head" style={{ marginBottom: 4 }}>
        <h2>Export</h2>
        <button className="btn btn-ghost btn-icon" aria-label="Close" onClick={close}><CloseIcon /></button>
      </div>
      <p className="muted" style={{ margin: "0 0 18px" }}>
        {isAsm ? `Assembly · ${instances.length} instance${instances.length === 1 ? "" : "s"}, ${unique} unique part${unique === 1 ? "" : "s"}` : `Part ${part}`}
      </p>
      <div className="ex-label">Format</div>
      <div className="tile-grid btn-lg ex-formats" role="radiogroup" aria-label="Format">
        {FORMATS.map((f) => (
          <button key={f.id} className="btn btn-tile" role="radio" aria-checked={choice.format === f.id} data-format={f.id} onClick={() => set({ format: f.id })}>
            <span>{f.label}</span><small>{f.note}</small>
          </button>
        ))}
      </div>
      {choice.format !== "step" && (
        <>
          <div className="ex-label" style={{ marginTop: 20 }}>Mesh quality</div>
          <div className="seg ex-quality" role="radiogroup" aria-label="Mesh quality">
            {QUALITIES.map((q) => (
              <button key={q.id} className="btn" role="radio" aria-checked={choice.quality === q.id} data-quality={q.id} title={q.note} onClick={() => set({ quality: q.id })}>{q.label}</button>
            ))}
          </div>
          <p className="muted ex-quality-note">{QUALITIES.find((q) => q.id === choice.quality)!.note}</p>
        </>
      )}
      {isAsm && (
        <>
          <div className="ex-label" style={{ marginTop: 20 }}>Include</div>
          <div className="ex-include">
            {includes.map((c) => (
              <button key={c.key} role="switch" aria-checked={choice[c.key]} data-include={c.key} onClick={() => set({ [c.key]: !choice[c.key] })}>
                <span className="t"><b>{c.label}</b><span>{c.note}</span></span>
                <span className={`switch${choice[c.key] ? " on" : ""}`}><i /></span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="ex-files-head">
        <span className="ex-label">Files</span>
        <span className="mono-label">{plan.files.length} file{plan.files.length === 1 ? "" : "s"}{plan.zip ? " · ZIP" : ""}</span>
      </div>
      <div className="ex-files" data-testid="export-files">
        {plan.files.map((f) => (
          <div key={f.name}><span>{f.name}</span><span className="n">{f.kind === "assembly" ? `${instances.length} instances` : f.rest ? "resting on Z = 0" : "part"}</span></div>
        ))}
        {nothing && <div className="err" style={{ fontSize: 13 }}>Pick at least one thing to include.</div>}
      </div>
      {plan.skipped.length > 0 && (
        <p className="err" style={{ margin: "10px 0 0", fontSize: 13 }} data-testid="export-skipped">
          {plan.skipped.join(", ")} failed to build and {plan.skipped.length > 1 ? "are" : "is"} left out.
        </p>
      )}
      {error && <p className="err" role="alert" style={{ marginTop: 10, fontSize: 13 }}>{error}</p>}
      <div className="ex-foot">
        <span className="hint">Units: mm · built in your browser</span>
        <span className="spacer" />
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn btn-primary" onClick={go} disabled={!busy && !ready && !plan.files.length} aria-busy={busy} data-ready={!!ready} data-testid="export-go">{cta}</button>
      </div>
    </Modal>
  );
}
