import { useEffect, useState } from "react";
import { LogoMark } from "./icons";
import { hasAssembly, Model, type ParamValue } from "shared";
import { setAssemblySource } from "../assembly";
import { decodeBundle } from "../kernel/bundle";
import { decodeParams, encodeParams } from "../paramsUrl";
import { applyUserValues, engine } from "../runtime";
import { projectPath } from "../route";
import { startFavicon } from "../favicon";
import { notifyError, startLogSources } from "../logSources";
import { setView, useStore } from "../state";
import { newWorkspace, projectsApi, remember, remembered } from "../workspace";
import { ModelInfo, quickExport, useCanExport } from "./App";
import { ExportDialog } from "./ExportDialog";
import { WorkLayout } from "./Layout";
import { ParamsPanel, ResetParams, resetParams, useChangedParams } from "./ParamsPanel";
import type { BarAction } from "./Layout";
import { PartsTree } from "./parts/PartsTree";
import { useNarrow } from "./shell/Shell";
import { Console } from "./Console";
import { Stage } from "./Stage";

startLogSources();
startFavicon();

// Visitor's parameter edits live in the hash (only values that differ from the published ones)
let stopUrlSync: (() => void) | undefined;
function keepParamsInUrl(published: Record<string, ParamValue>) {
  stopUrlSync?.();
  const unsub = useStore.subscribe((s, prev) => {
    if (s.params === prev.params) return;
    const hash = encodeParams(s.params.form, published, s.params.values);
    if (hash !== location.hash.replace(/^#/, "")) history.replaceState(history.state, "", `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`);
  });
  // A hash edited by hand applies too
  const onHash = () => {
    const form = useStore.getState().params.form;
    void applyUserValues({ ...published, ...decodeParams(form, location.hash) });
  };
  addEventListener("hashchange", onHash);
  stopUrlSync = () => {
    unsub();
    removeEventListener("hashchange", onHash);
  };
}

type Status = "loading" | "missing" | "failed" | "ready";

// STL of the view (the assembly as one mesh), or all parts as a ZIP
const download = (all: boolean) =>
  quickExport(all ? { parts: true, assembled: false } : { parts: false, assembled: true })
    .catch(notifyError);

// Public product page for a share: the workspace layout without workspace-only controls
export function ShareApp({ shareId }: { shareId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const ready = useStore((s) => s.kernelReady);
  const parts = useStore((s) => Object.keys(s.parts).length);
  const viewSize = useStore((s) => s.viewSize);
  const isAssembly = useStore((s) => s.view.kind === "assembly" && s.assembly.instances.length > 0);
  const canExport = useCanExport();
  const changedParams = useChangedParams();
  const hasForm = useStore((s) => s.params.form.params.length > 0);
  const paramActions: BarAction[] = hasForm ? [{ label: "Reset to defaults", icon: "reset", disabled: !changedParams, run: resetParams }] : [];
  const narrow = useNarrow();
  const [forking, setForking] = useState(false);

  useEffect(() => {
    fetch(`/api/shares/${shareId}`)
      .then(async (r) => {
        if (r.status === 404) return setStatus("missing");
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        const parsed = Model.parse(data.model);
        // The visitor's edits come back from the link's hash
        const published = parsed.params.values;
        const model = { ...parsed, params: { ...parsed.params, values: { ...published, ...decodeParams(parsed.params.form, location.hash) } } };
        keepParamsInUrl(published);
        // Name, description and form show right away; the meshes may take a while
        useStore.setState({ params: model.params, info: model.info, groups: model.groups, restored: true });
        if (model.info.name) document.title = model.info.name;
        // Prebuilt meshes for this exact version; any failure just means building
        const bundle = await fetch(`/api/shares/${shareId}/meshes?v=${data.updatedAt}`)
          .then(async (b) => (b.ok ? decodeBundle(await b.arrayBuffer()) : []))
          .catch(() => []);
        engine.seed(bundle);
        setAssemblySource(model.assembly, model.params);
        const first = Object.keys(model.parts).sort()[0];
        setView(hasAssembly(model.assembly) || !first ? { kind: "assembly" } : { kind: "part", name: first });
        setStatus("ready");
        await engine.load(model);
      })
      .catch(() => setStatus("failed"));
  }, [shareId]);

  // New project from this share, with the parameter values shown here
  const fork = async () => {
    setForking(true);
    try {
      const ws = remembered() ?? (await newWorkspace());
      remember(ws);
      const { id } = await projectsApi(ws).create({ fromShare: shareId, values: engine.params.values });
      // Without storage the workspace travels in the link
      location.assign(remembered() === ws ? projectPath(id) : `/w/${ws}/p/${id}`);
    } catch (e) {
      notifyError(e);
      setForking(false);
    }
  };

  if (status === "missing" || status === "failed") {
    return (
      <div className="notfound" data-testid="share-missing">
        <div className="in">
          <div className="mono-label">{location.pathname}</div>
          <h1>{status === "missing" ? "This share doesn't exist" : "Could not load this share"}</h1>
          <p>{status === "missing" ? "The owner may have unpublished it, or the link is mistyped." : "Please try again later."}</p>
          <a className="btn btn-lg btn-primary" href="/">Open not-a-cad</a>
        </div>
      </div>
    );
  }

  const size = viewSize ? ` · ${viewSize.map((x) => Math.round(x)).join(" × ")} mm` : "";
  return (
    <div className={`shell${narrow ? " narrow" : ""}`}>
      <header className="topbar">
        <a className="logo" href="/"><LogoMark /><span className="made">Made with <b>not-a-cad</b></span></a>
        <span className="spacer" />
        <button className="btn" onClick={fork} disabled={forking || status !== "ready"} aria-busy={forking} data-testid="fork">Fork to my projects</button>
      </header>
      <WorkLayout
        left={
          <section data-testid="share-head">
            <ModelInfo />
            <div className="model-chips">
              <span className="chip">{parts} part{parts === 1 ? "" : "s"}{size}</span>
              <span className="chip">Built in your browser</span>
            </div>
            <PartsTree />
            <p className="hint" style={{ marginTop: 14 }}>Shared from <span className="nobr">not-a-cad</span>. Part scripts are visible to anyone with this link.</p>
          </section>
        }
        leftFoot={
          <div className="stack">
            <button className="btn btn-lg btn-primary" onClick={() => download(false)} disabled={!canExport} data-testid="export">Download STL</button>
            {isAssembly && <button className="btn" onClick={() => download(true)} disabled={!canExport} data-testid="export-zip">Download all parts (ZIP)</button>}
            <button className="btn btn-link" style={{ alignSelf: "center" }} onClick={() => useStore.setState({ exportOpen: true })} disabled={!canExport} data-testid="export-more">Other formats (3MF, STEP, OBJ)…</button>
          </div>
        }
        leftActions={[{ label: "Download STL", icon: "export", kind: "primary", disabled: !canExport, run: () => download(false) }]}
        rightActions={paramActions}
        right={{
          content: (
            <ParamsPanel intro={
              <div className="params-intro"><h2>Make it yours</h2>Changes stay on this page and rebuild in your browser.</div>
            } />
          ),
          foot: <ResetParams />,
        }}
        console={<Console />}
        stage={<Stage rightLabel="Parameters" section loading={!ready || status === "loading" ? "Loading model…" : undefined} />}
      />
      <ExportDialog />
    </div>
  );
}
