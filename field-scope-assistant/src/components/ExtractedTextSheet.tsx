"use client";
import { useEffect, useState } from "react";
import Sheet from "./Sheet";
import { api } from "./api";

/** Shows the selectable text extracted from each PDF page at upload (works without the AI key). */
export default function ExtractedTextSheet({
  projectId,
  documentId,
  onClose,
  flash,
}: {
  projectId: string;
  documentId: string;
  onClose: () => void;
  flash: (m: string) => void;
}) {
  const [data, setData] = useState<{ filename: string; pages: { page: number; text: string }[] } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<{ filename: string; pages: { page: number; text: string }[] }>(`/api/projects/${projectId}/documents/${documentId}/text`)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [projectId, documentId]);
  const all = data?.pages.map((p) => `--- Page ${p.page} ---\n${p.text || "(no selectable text)"}`).join("\n\n") ?? "";
  return (
    <Sheet title={data ? `Text — ${data.filename}` : "Extracted text"} onClose={onClose}>
      {err && <div className="card danger">{err}</div>}
      {!data && !err && <p className="muted">Loading…</p>}
      {data && (
        <div className="stack">
          <button
            className="btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(all);
                flash("Text copied");
              } catch {
                flash("Copy not allowed — select the text instead");
              }
            }}
          >
            Copy all text
          </button>
          {data.pages.map((p) => (
            <div key={p.page} className="card">
              <div className="small muted">Page {p.page}</div>
              <div className="manual-text small" style={{ marginTop: 4 }}>
                {p.text.trim() ? p.text : <span className="muted">No selectable text on this page (scanned image).</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
