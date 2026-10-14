import { useEffect, useState } from "react";
import { go, libraryPath } from "../route";
import { runExport, viewTarget } from "../export/run";
import { download } from "../scene";
import { log } from "../console";
import { useStore } from "../state";
import { projectsApi } from "../workspace";
import { Console } from "./Console";
import { WorkLayout } from "./Layout";
import { Onboarding } from "./Onboarding";
import { ParamsPanel, ResetParams, resetParams, useChangedParams } from "./ParamsPanel";
import type { BarAction } from "./Layout";
import { PartsTree } from "./parts/PartsTree";
import { ExportDialog } from "./ExportDialog";
import { ShareDialog } from "./ShareDialog";
import { CollapseButton, useNarrow } from "./shell/Shell";
import { Stage } from "./Stage";
import { refreshProjects } from "./Workspace";

// Quick download of the shown part or the assembly (share viewer buttons)
export async function quickExport(include: { parts: boolean; assembled: boolean }) {
  const t = performance.now();
  const f = await runExport({ part: viewTarget(), format: "stl", include });
  // Browsers drop downloads started long after the click; offer a button instead
  if (performance.now() - t < 800) download(f);
  else log({ kind: "you", who: "You", level: "ok", text: `${f.file} is ready`, action: { label: "Download", run: () => download(f) } });
  if (f.skipped.length) log({ kind: "you", who: "You", level: "warn", text: `Left out failed part${f.skipped.length > 1 ? "s" : ""}: ${f.skipped.join(", ")}` });
  return f;
}

export function useCanExport() {
  const view = useStore((s) => s.view);
  const parts = useStore((s) => s.parts);
  const assembly = useStore((s) => s.assembly);
  return view.kind === "part"
    ? parts[view.name]?.status === "ok"
    : assembly.instances.some((i) => parts[i.part]?.status === "ok");
}

// Model name and description (the agent sets them; the user edits them in the Share dialog)
export function ModelInfo({ collapsible = true }: { collapsible?: boolean }) {
  const info = useStore((s) => s.info);
  const narrow = useNarrow();
  return (
    <>
      <div className="model-head">
        <h1 className={`model-title${info.name ? "" : " untitled"}`} data-testid="model-name">{info.name ?? "Untitled project"}</h1>
        {collapsible && !narrow && <CollapseButton side="left" label="parts" />}
      </div>
      <p className="model-desc" data-testid="model-desc">{info.description ?? "Your agent names and describes the model. You can edit both in Share…"}</p>
    </>
  );
}

// Who defined the parameters form: the latest "defined parameters" entry in the project's activity
function useParamsAuthor(ws: string, pid: string) {
  const version = useStore((s) => s.activityVersion);
  const hasForm = useStore((s) => s.params.form.params.length > 0);
  const [who, setWho] = useState<string>();
  useEffect(() => {
    if (!hasForm) return setWho(undefined);
    let stop = false;
    projectsApi(ws).activity(pid).then(
      (r) => { if (!stop) setWho(r.entries.find((e) => e.verb === "defined parameters")?.who); },
      () => undefined,
    );
    return () => {
      stop = true;
    };
  }, [ws, pid, version, hasForm]);
  return who;
}

export function ProjectView({ ws, pid }: { ws: string; pid: string }) {
  const ready = useStore((s) => s.kernelReady);
  const restored = useStore((s) => s.restored);
  const name = useStore((s) => s.info.name);
  const agent = useParamsAuthor(ws, pid);
  const canExport = useCanExport();
  const hasParts = useStore((s) => Object.keys(s.parts).length > 0);
  const changedParams = useChangedParams();
  const hasForm = useStore((s) => s.params.form.params.length > 0);
  const paramActions: BarAction[] = hasForm ? [{ label: "Reset to defaults", icon: "reset", disabled: !changedParams, run: resetParams }] : [];
  const [missing, setMissing] = useState(false);

  // Project list feeds the switcher and tells a wrong link from a slow restore
  useEffect(() => {
    setMissing(false);
    void refreshProjects(ws).then((list) => setMissing(!!list && !list.some((p) => p.id === pid)));
  }, [ws, pid]);
  useEffect(() => {
    document.title = `${name ?? "Untitled"} · not-a-cad`;
  }, [name]);

  if (missing && !restored) {
    return (
      <div className="notfound" data-testid="project-missing">
        <div className="in">
          <h1>This project doesn't exist</h1>
          <p>It may have been deleted, or the link is mistyped.</p>
          <button className="btn btn-lg btn-primary" onClick={() => go(libraryPath())}>All projects</button>
        </div>
      </div>
    );
  }



  return (
    <>
      <WorkLayout
        left={<><ModelInfo /><PartsTree /></>}
        leftFoot={
          <>
            <button className="btn btn-lg" onClick={() => useStore.setState({ shareOpen: true })} disabled={!hasParts} data-testid="share-open">Share…</button>
            <button className="btn btn-lg btn-primary" style={{ flex: 1 }} onClick={() => useStore.setState({ exportOpen: true })} disabled={!canExport} data-testid="export">Export…</button>
          </>
        }
        leftActions={[
          { label: "Share…", icon: "share", disabled: !hasParts, run: () => useStore.setState({ shareOpen: true }) },
          { label: "Export…", icon: "export", kind: "primary", disabled: !canExport, run: () => useStore.setState({ exportOpen: true }) },
        ]}
        right={{
          content: <ParamsPanel intro={<p className="params-intro">Set by {agent ?? "your agent"}. Changes rebuild only the parts they affect.</p>} />,
          foot: <ResetParams />,
        }}
        rightActions={paramActions}
        console={<Console ws={ws} pid={pid} />}
        stage={<Stage rightLabel="Parameters" overlay={<Onboarding key={pid} />} section
          loading={!ready ? "Loading CAD kernel…" : !restored ? "Opening project…" : undefined} />}
      />
      <ShareDialog ws={ws} pid={pid} />
      <ExportDialog onExported={(file) => void projectsApi(ws).report(pid, "exported", file).catch(() => undefined)} />
    </>
  );
}
