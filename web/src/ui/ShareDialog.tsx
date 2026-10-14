import { useEffect, useState } from "react";
import { modelHash, type Model } from "shared";
import { relay, saveInfo } from "../live";
import { engine } from "../runtime";
import { viewer } from "../scene";
import { currentBundle } from "../shareBundle";
import { notify } from "../logSources";
import { useStore } from "../state";
import { projectsApi } from "../workspace";
import { CloseIcon } from "./icons";
import { CopyButton, Modal } from "./shell/Shell";

interface ShareStatus {
  id: string;
  path: string;
  updatedAt: number;
  modelHash: string | null;
  // The current version has a social preview image
  preview?: boolean;
}

// Link-card image (Open Graph size), JPEG for every social site
const socialImage = () => viewer.thumbnail?.(1200, 630, "image/jpeg");

const currentModel = (): Model => {
  const s = useStore.getState();
  return { parts: Object.fromEntries(engine.sources), assembly: s.assemblySource, params: engine.params, info: s.info, groups: s.groups };
};

// Publish / republish / unpublish the open project as a public share
export function ShareDialog({ ws, pid }: { ws: string; pid: string }) {
  const open = useStore((s) => s.shareOpen);
  if (!open) return null;
  return <ShareContent ws={ws} pid={pid} close={() => useStore.setState({ shareOpen: false })} />;
}

function ShareContent({ ws, pid, close }: { ws: string; pid: string; close: () => void }) {
  const api = projectsApi(ws).share(pid);
  const info = useStore((s) => s.info);
  const parts = useStore((s) => s.parts);
  useStore((s) => s.params);
  useStore((s) => s.assembly);
  const [share, setShare] = useState<ShareStatus | null>();
  const [name, setName] = useState(info.name ?? "");
  const [desc, setDesc] = useState(info.description ?? "");
  const [confirm, setConfirm] = useState<"publish" | "unpublish">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<string>();

  useEffect(() => {
    fetch(api).then(async (r) => setShare(r.ok ? await r.json() : null), () => setShare(null));
    const blob = socialImage();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [api]);

  const names = Object.keys(parts);
  const failed = names.filter((n) => parts[n].status === "error");
  const url = share ? `${location.origin}${share.path}` : "";
  let current: string | undefined;
  try {
    current = modelHash({ ...currentModel(), info: { name: name.trim() || undefined, description: desc.trim() || undefined } });
  } catch {
    current = undefined;
  }
  const outOfDate = !!share && share.modelHash !== null && share.modelHash !== current;

  const uploadPreview = async (version: number) => {
    const blob = socialImage();
    if (!blob) return false;
    const r = await fetch(`${api}/preview?version=${version}`, { method: "PUT", headers: { "content-type": blob.type }, body: blob }).catch(() => undefined);
    return !!r?.ok;
  };

  // Shares published before previews existed get one when their owner opens this dialog (if still up to date)
  useEffect(() => {
    if (share && share.preview === false && share.modelHash !== null && share.modelHash === current) {
      void uploadPreview(share.updatedAt).then((ok) => ok && setShare((s) => (s ? { ...s, preview: true } : s)));
    }
  }, [share?.updatedAt, share?.preview]);

  const commitInfo = () => {
    const next = { name: name.trim() || undefined, description: desc.trim() || undefined };
    if (next.name !== info.name || next.description !== info.description) saveInfo(next);
  };

  const publish = async () => {
    commitInfo();
    relay.flushChanges();
    setBusy(true);
    setError(undefined);
    setConfirm(undefined);
    try {
      await engine.idle();
      const r = await fetch(api, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(currentModel()) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      const preview = await uploadPreview(body.updatedAt);
      setShare({ ...body, modelHash: modelHash(currentModel()), preview });
      if (!preview) notify("Published, but the link preview image could not be saved; shared links show no picture.", "warn");
      // Prebuilt meshes so visitors don't rebuild; the share works without them
      const bundle = currentBundle();
      if (bundle) {
        const b = await fetch(`${api}/meshes?version=${body.updatedAt}`, {
          method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bundle as Uint8Array<ArrayBuffer>,
        }).catch(() => undefined);
        if (!b?.ok) notify("Published, but the preview cache upload failed; visitors will build the model themselves.", "warn");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    setBusy(true);
    setConfirm(undefined);
    const r = await fetch(api, { method: "DELETE" }).catch(() => undefined);
    setBusy(false);
    if (r?.ok || r?.status === 404) setShare(null);
    else setError("Could not unpublish; try again");
  };

  const canPublish = names.length > 0 && name.trim().length > 0 && !busy;
  const onPublish = () => (failed.length ? setConfirm("publish") : void publish());
  const state = !share ? "Not shared" : outOfDate ? "Published, out of date" : "Published";

  const sub = share ? `${outOfDate ? "Changed since" : "Updated"} ${new Date(share.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "Only you can see this project.";
  return (
    <Modal label="Share" onClose={close} size="wide" testid="share-dialog">
      <div className="modal-head">
        <h2>Share</h2>
        <button className="btn btn-ghost btn-icon" aria-label="Close" onClick={close}><CloseIcon /></button>
      </div>
      <div className="share-grid" data-testid="share">
        <div className="preview">
          {preview && <img src={preview} alt="Link preview" />}
          <span className="snap-label">link preview</span>
        </div>
        <div className="share-fields">
          <label><div>Name</div>
            <input id="share-name" value={name} maxLength={80} placeholder="Name your model to share it" onChange={(e) => setName(e.target.value)} onBlur={commitInfo} />
          </label>
          {!name.trim() && names.length > 0 && <span className="err">A name is required to share.</span>}
          <label><div>Description</div>
            <textarea id="share-desc" value={desc} maxLength={500} rows={4} onChange={(e) => setDesc(e.target.value)} onBlur={commitInfo} />
          </label>
        </div>
      </div>
      <div className="share-state">
        <div className="st" data-testid="share-state">
          <span className="dot" style={{ background: !share ? "var(--ink-3)" : outOfDate ? "var(--warn)" : "var(--ok)" }} />
          <b>{state}</b><span className="sub">{sub}</span>
        </div>
        {share && (
          <div className="url">
            <code className="codebox" data-testid="share-url">{url}</code>
            <CopyButton text={url} label="Copy link" className="btn" />
          </div>
        )}
        <p>Anyone with the link can view the model, change parameters and export. Part scripts are visible. Changes visitors make are never saved.</p>
        {!names.length && <p>Build something first.</p>}
        {failed.length > 0 && <p className="err" data-testid="share-failed">{failed.length} part{failed.length > 1 ? "s" : ""} failed to build: {failed.join(", ")}.</p>}
        {error && <p className="err" role="alert">{error}</p>}
      </div>
      <div className="share-actions">
        {confirm === "unpublish" ? (
          <>
            <span className="q">Unpublish? The link stops working.</span>
            <button className="btn" onClick={() => setConfirm(undefined)}>Cancel</button>
            <button className="btn btn-danger" onClick={unpublish}>Unpublish</button>
          </>
        ) : confirm === "publish" ? (
          <>
            <span className="q">Publish with failed parts?</span>
            <button className="btn" onClick={() => setConfirm(undefined)}>Cancel</button>
            <button className="btn btn-primary" onClick={publish}>Publish anyway</button>
          </>
        ) : share && (
          <button className="btn" onClick={() => setConfirm("unpublish")} disabled={busy}>Unpublish</button>
        )}
        <span className="spacer" />
        <button className="btn btn-primary" onClick={onPublish} disabled={!canPublish && !busy} aria-busy={busy} data-testid="publish">{share ? "Republish" : "Publish"}</button>
      </div>
    </Modal>
  );
}
