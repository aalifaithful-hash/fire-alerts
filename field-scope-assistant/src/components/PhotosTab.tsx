"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, sleep, uploadProjectPdf } from "./api";
import { locLabel } from "./labels";
import type { WorkspaceData } from "./types";
import type { Evidence } from "@/lib/repo";

interface Props {
  ws: WorkspaceData;
  projectId: string;
  reload: () => Promise<WorkspaceData | null>;
  flash: (m: string) => void;
  openEvidence: (id: string) => void;
  aiReady: boolean;
  blobReady: boolean | null; // null until /api/status has loaded
}
type Prog = { total: number; done: number; failed: number; pending: number; errors: string[] };

export default function PhotosTab({ ws, projectId, reload, flash, openEvidence, aiReady, blobReady }: Props) {
  const [upload, setUpload] = useState<number | null>(null);
  const [running, setRunning] = useState<Record<string, string>>({}); // docId -> status message
  const [prog, setProg] = useState<Record<string, Prog>>({});
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const active = useRef(new Set<string>());
  const started = useRef(false);

  const processDoc = async (docId: string, retryFailed = false) => {
    if (active.current.has(docId)) return;
    active.current.add(docId);
    let failures = 0;
    let first = true;
    try {
      for (;;) {
        setRunning((r) => ({ ...r, [docId]: "Analyzing pages…" }));
        try {
          const r = await api<{ done: boolean; progress: Prog; error?: string }>(`/api/projects/${projectId}/documents/${docId}/process`, {
            body: { retryFailed: retryFailed && first },
          });
          first = false;
          setProg((p) => ({ ...p, [docId]: r.progress }));
          if (r.done) break;
          if (r.error) {
            failures++;
            if (failures >= 4) {
              setRunning((x) => ({ ...x, [docId]: `Paused after repeated errors: ${r.error}` }));
              return;
            }
            setRunning((x) => ({ ...x, [docId]: `Retrying after error: ${r.error}` }));
            await sleep(2000 * 2 ** (failures - 1));
          } else failures = 0;
        } catch (e) {
          const ae = e as ApiError;
          if (ae.code === "NO_API_KEY" || ae.status === 404) {
            setRunning((x) => ({ ...x, [docId]: ae.message }));
            return;
          }
          failures++;
          if (failures >= 4) {
            setRunning((x) => ({ ...x, [docId]: `Paused: ${ae.message}` }));
            return;
          }
          await sleep(2000 * 2 ** (failures - 1));
        }
      }
      setRunning((r) => {
        const n = { ...r };
        delete n[docId];
        return n;
      });
      flash("PDF processed");
    } finally {
      active.current.delete(docId);
      reload();
    }
  };

  // Resume interrupted processing when the tab opens.
  useEffect(() => {
    if (started.current || !aiReady) return;
    started.current = true;
    for (const d of ws.documents) if (d.progress.pending > 0) processDoc(d.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiReady]);

  const onFile = async (f: File) => {
    setErr("");
    setUpload(0);
    try {
      const r = await uploadProjectPdf<{ document: { id: string; scannedPages: number; pageCount: number } }>(projectId, f, setUpload, {
        direct: !!blobReady,
      });
      setUpload(null);
      await reload();
      if (r.document.scannedPages) flash(`${r.document.scannedPages} of ${r.document.pageCount} pages have no selectable text — they will be read visually.`);
      if (aiReady) processDoc(r.document.id);
    } catch (e) {
      setUpload(null);
      setErr((e as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const groups = groupEvidence(ws);

  return (
    <div>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hide" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <button className="btn primary big" disabled={upload !== null || blobReady === null} onClick={() => fileRef.current?.click()}>
        {upload !== null ? `Uploading… ${upload}%` : "Upload CompanyCam PDF"}
      </button>
      {!aiReady && <p className="small muted" style={{ marginTop: 6 }}>Uploads are stored and their text extracted; photo analysis starts once the AI key is set.</p>}
      {err && <div className="card danger" style={{ marginTop: 10 }}>{err}</div>}

      {ws.documents.length > 0 && <h2>Reports</h2>}
      {ws.documents.map((d) => {
        const pr = prog[d.id] ?? d.progress;
        const pct = pr.total ? Math.round(((pr.done + pr.failed) / pr.total) * 100) : 0;
        const msg = running[d.id];
        return (
          <div key={d.id} className="card stack">
            <div className="row">
              <strong className="grow" style={{ wordBreak: "break-all" }}>{d.filename}</strong>
              <span className="small muted">{d.pageCount} pages</span>
            </div>
            <div className="progress" aria-label="Processing progress">
              <div style={{ width: `${pct}%`, background: pr.failed ? "var(--amber)" : undefined }} />
            </div>
            <div className="small muted">
              {pr.done}/{pr.total} batches done{pr.failed ? ` · ${pr.failed} failed` : ""}
              {msg ? ` · ${msg}` : ""}
            </div>
            {pr.errors.length > 0 && (
              <details className="small">
                <summary>Errors</summary>
                {pr.errors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </details>
            )}
            <div className="row">
              {!msg?.startsWith("Analyzing") && pr.pending > 0 && aiReady && (
                <button className="btn sm" onClick={() => processDoc(d.id)}>
                  Resume
                </button>
              )}
              {pr.failed > 0 && aiReady && !active.current.has(d.id) && (
                <button className="btn sm" onClick={() => processDoc(d.id, true)}>
                  Retry failed pages
                </button>
              )}
              <a className="btn sm ghost" href={`/api/projects/${projectId}/documents/${d.id}/file`} target="_blank" rel="noreferrer">
                Open PDF
              </a>
              <button
                className="btn sm danger"
                onClick={async () => {
                  if (!confirm("Delete this PDF and the evidence extracted from it?")) return;
                  await api(`/api/projects/${projectId}/documents/${d.id}`, { method: "DELETE" });
                  reload();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}

      {ws.evidence.length > 0 && (
        <>
          <h2>Evidence ({ws.evidence.length})</h2>
          <p className="small muted" style={{ marginTop: -4, marginBottom: 8 }}>
            Tap a photo to see its page and fix its room.
          </p>
        </>
      )}
      {groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 14 }}>
          <h3 style={{ color: g.attention ? "var(--amber)" : undefined }}>
            {g.title} <span className="small muted">({g.items.length})</span>
          </h3>
          {g.items.map((e) => (
            <button key={e.id} className="list-item" onClick={() => openEvidence(e.id)}>
              <div className="row small muted">
                <span>
                  p.{e.page}
                  {e.photoIndex ? ` · photo ${e.photoIndex}` : ""}
                </span>
                {e.locationConfidence === "low" && <span className="chip amber">uncertain room</span>}
                {!e.readable && <span className="chip red">unreadable</span>}
                {e.captionSource === "ocr" && <span className="chip">OCR</span>}
              </div>
              <div>{e.caption || <span className="muted">No caption</span>}</div>
              {e.conditions.length > 0 && <div className="small muted">Visible: {e.conditions.join("; ")}</div>}
              {e.flags.length > 0 && <div className="small" style={{ color: "var(--amber)" }}>⚑ {e.flags.join(" · ")}</div>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function groupEvidence(ws: WorkspaceData) {
  const out: { key: string; title: string; items: Evidence[]; attention?: boolean }[] = [];
  const attention = ws.evidence.filter((e) => !e.readable || !e.locationId);
  if (attention.length) out.push({ key: "attn", title: "Needs a room / unreadable", items: attention, attention: true });
  for (const l of ws.locations) {
    const items = ws.evidence.filter((e) => e.readable && e.locationId === l.id);
    if (items.length) out.push({ key: l.id, title: locLabel(l), items });
  }
  return out;
}
