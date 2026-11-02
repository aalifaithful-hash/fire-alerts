"use client";
import { useEffect, useRef, useState } from "react";
import Sheet from "./Sheet";
import { api } from "./api";
import { locLabel } from "./labels";
import type { WorkspaceData } from "./types";

type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage> };
type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }) => { promise: Promise<void> };
};
const cache = new Map<string, Promise<PdfDoc>>();

async function loadPdf(url: string): Promise<PdfDoc> {
  if (!cache.has(url)) {
    cache.set(
      url,
      (async () => {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        return (await pdfjs.getDocument({ url, withCredentials: true }).promise) as unknown as PdfDoc;
      })(),
    );
  }
  return cache.get(url)!;
}

/** Shows the source PDF page (rendered in the browser) and what was read from it. */
export default function EvidenceViewer({
  ws,
  projectId,
  evidenceId,
  onClose,
  reload,
  flash,
}: {
  ws: WorkspaceData;
  projectId: string;
  evidenceId: string;
  onClose: () => void;
  reload: () => Promise<WorkspaceData | null>;
  flash: (m: string) => void;
}) {
  const e = ws.evidence.find((x) => x.id === evidenceId);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState("Loading page…");
  const [loc, setLoc] = useState(e?.locationId ?? "");

  useEffect(() => {
    if (!e) return;
    let cancelled = false;
    (async () => {
      try {
        const pdf = await loadPdf(`/api/projects/${projectId}/documents/${e.documentId}/file`);
        const page = await pdf.getPage(Math.min(e.page, pdf.numPages));
        const vp = page.getViewport({ scale: 1.6 });
        const c = canvas.current;
        if (!c || cancelled) return;
        c.width = vp.width;
        c.height = vp.height;
        await page.render({ canvasContext: c.getContext("2d")!, viewport: vp, canvas: c }).promise;
        setState("");
      } catch {
        if (!cancelled) setState("Could not render this page. Use “Open PDF” instead.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [e, projectId]);

  if (!e) return null;
  const doc = ws.documents.find((d) => d.id === e.documentId);

  return (
    <Sheet title={`Page ${e.page}${e.photoIndex ? ` · photo ${e.photoIndex}` : ""}`} onClose={onClose}>
      <div className="stack">
        <div className="small muted">{doc?.filename}</div>
        {state && <div className="small muted">{state}</div>}
        <canvas ref={canvas} className="pdfpage" />
        <div>
          <div className="small muted">Caption {e.captionSource === "ocr" ? "(read from image)" : ""}</div>
          <div>{e.caption || <span className="muted">None</span>}</div>
        </div>
        {e.conditions.length > 0 && (
          <div>
            <div className="small muted">Visible in photo</div>
            <div>{e.conditions.join("; ")}</div>
          </div>
        )}
        {e.materials.length > 0 && (
          <div>
            <div className="small muted">Materials</div>
            <div>{e.materials.join(", ")}</div>
          </div>
        )}
        {e.captionStatements.length > 0 && (
          <div>
            <div className="small muted">Caption states (not verified)</div>
            <div>{e.captionStatements.join("; ")}</div>
          </div>
        )}
        {e.flags.length > 0 && <div style={{ color: "var(--amber)" }}>⚑ {e.flags.join(" · ")}</div>}
        <label className="field">
          <span>
            Room {e.locationText ? `(read as “${e.locationText}”, ${e.locationConfidence} confidence)` : ""}
          </span>
          <select className="in" value={loc} onChange={(ev) => setLoc(ev.target.value)}>
            <option value="">Not assigned</option>
            {ws.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {locLabel(l)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn primary"
          disabled={loc === (e.locationId ?? "")}
          onClick={async () => {
            await api(`/api/projects/${projectId}/evidence/${e.id}`, { method: "PATCH", body: { locationId: loc || null } });
            await reload();
            flash("Room updated");
          }}
        >
          Save room
        </button>
        <a className="btn ghost" href={`/api/projects/${projectId}/documents/${e.documentId}/file`} target="_blank" rel="noreferrer">
          Open PDF
        </a>
      </div>
    </Sheet>
  );
}
