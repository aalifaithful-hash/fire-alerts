"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, uploadProjectPdf } from "./api";
import { useStatus } from "./useStatus";
import type { ScopeLine } from "@/lib/scan";

type Row = { key: string; label: string; value: string | null; quote: string | null; page: number | null; stated: "found" | "open" | "missing" };
type Change = { key: string; label: string; current: string | null; proposed: string; quote: string; page: number; conflict: boolean };
type View = {
  reports: { id: string; filename: string; status: string; warning: string | null; contentType: string; confirmed: boolean }[];
  ai: { enabled: false; message: string };
  active: null | {
    id: string;
    filename: string;
    findings: Row[];
    room: { locationId: string; label: string } | null;
    applied: boolean;
    changes: Change[];
    mismatches: string[];
    preview: ScopeLine[];
    stillMissing: string[];
  };
};

/**
 * Mold report: upload (PDF or photo, same Blob path as galleries) → "Wrong report?" check →
 * rules-based findings with the quoted source text → proposed scan changes and lines → apply.
 * Applied lines arrive as "suggested" in the room below; the PM accepts them there as usual.
 */
export default function ReportPanel({ projectId, visitId, onApplied }: { projectId: string; visitId: string; onApplied: () => void }) {
  const status = useStatus();
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const input = useRef<HTMLInputElement>(null);
  const base = `/api/projects/${projectId}/visits/${visitId}/report`;

  const load = useCallback(async () => {
    try {
      const d = await api<View>(base);
      setV(d);
      setPicked(Object.fromEntries((d.active?.changes ?? []).map((c) => [c.key, !c.conflict])));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (k: string, fn: () => Promise<unknown>) => {
    setErr("");
    setBusy(k);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
      setPct(null);
    }
  };
  const onFile = (f: File) =>
    run("upload", () =>
      uploadProjectPdf(projectId, f, setPct, { direct: !!status?.blobUploads, kind: "mold_report" }).then((r) => {
        const w = (r as { document?: { wrongReport?: string | null } }).document?.wrongReport;
        if (w) window.alert(w);
      }),
    );

  if (!v) return null;
  const a = v.active;
  const held = v.reports.filter((r) => r.status === "needs_confirmation");
  const unreadable = v.reports.filter((r) => r.status === "unreadable");
  const keys = Object.entries(picked).filter(([, on]) => on).map(([k]) => k);

  return (
    <section className="card stack" style={{ marginBottom: 14 }} aria-label="Mold report">
      <div className="row">
        <strong className="grow">Mold report</strong>
        <button className="btn sm" disabled={!!busy} onClick={() => input.current?.click()}>
          {busy === "upload" ? (pct != null ? `Uploading ${pct}%` : "Reading…") : v.reports.length ? "Upload another" : "Upload report"}
        </button>
        <input ref={input} type="file" accept="application/pdf,image/*" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} aria-label="Mold report file" />
      </div>
      {!v.reports.length && <div className="small muted">PDF from the assessor (or a photo of it). The findings are read from the report text by rules (no AI), shown with the quoted text, and proposed for the scope — nothing changes until you apply and accept.</div>}
      {err && <div className="card danger small">{err}</div>}

      {held.map((r) => (
        <div key={r.id} className="card danger small" role="alert">
          <strong>Wrong report?</strong> {r.warning?.replace(/^Wrong report\?\s*/, "")}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm primary" disabled={!!busy} onClick={() => run("confirm", () => api(`/api/projects/${projectId}/documents/${r.id}/confirm`, { body: {} }))}>
              It&apos;s this job&apos;s report — use it
            </button>
            <button className="btn sm" disabled={!!busy} onClick={() => run("cancel", () => api(`/api/projects/${projectId}/documents/${r.id}`, { method: "DELETE" }))}>
              Cancel upload
            </button>
          </div>
        </div>
      ))}

      {unreadable.map((r) => (
        <div key={r.id} className="card warn small">
          <strong>{r.filename}:</strong> no selectable text (a photo or scanned report), so the rules analyzer can&apos;t read it. The file is stored with the project.
          <div style={{ marginTop: 4 }}>{v.ai.message}</div>
        </div>
      ))}

      {a && (
        <>
          <details open={!a.applied}>
            <summary>
              <strong>Report findings</strong> <span className="small muted">— {a.filename}</span>
            </summary>
            <div className="stack" style={{ gap: 6, marginTop: 6 }}>
              {a.findings.map((r) => (
                <div key={r.key} className="small" data-finding={r.key} data-stated={r.stated}>
                  <div>
                    <strong>{r.label}:</strong>{" "}
                    {r.stated === "found" ? r.value : <span style={{ color: "var(--amber, #b7791f)" }}>{r.stated === "open" ? "left open in the report" : "not in the report"}</span>}
                  </div>
                  {r.quote && (
                    <div className="muted" style={{ fontStyle: "italic", paddingLeft: 8, borderLeft: "2px solid var(--line, #ddd)" }}>
                      “{r.quote}”{r.page ? ` (p. ${r.page})` : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </details>

          {a.mismatches.length > 0 && (
            <div className="card warn small" role="alert">
              <strong>Report and scope don&apos;t agree</strong> — nothing is overwritten unless you tick it:
              <ul style={{ paddingLeft: 18, margin: "4px 0 0" }}>
                {a.mismatches.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          )}

          {!a.room && <div className="small muted">Add a room in the scan, or apply to create one from the report.</div>}

          {a.changes.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <strong className="small">Changes to {a.room?.label ?? "the scan"} from the report</strong>
              {a.changes.map((c) => (
                <label key={c.key} className="row small" style={{ alignItems: "flex-start" }}>
                  <input type="checkbox" checked={!!picked[c.key]} onChange={(e) => setPicked({ ...picked, [c.key]: e.target.checked })} aria-label={`Apply ${c.label}`} />
                  <span className="grow">
                    {c.conflict ? "⚑ " : ""}
                    <strong>{c.label}:</strong> {c.current ? `${c.current} → ` : ""}
                    {c.proposed}
                    <span className="muted" style={{ display: "block", fontStyle: "italic" }}>
                      “{c.quote}” (p. {c.page})
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}

          {a.preview.length > 0 && !a.applied && (
            <details>
              <summary className="small">
                <strong>Proposed lines from the report ({a.preview.filter((l) => l.kind !== "reconstruction").length} mitigation, {a.preview.filter((l) => l.kind === "reconstruction").length} reconstruction)</strong>
              </summary>
              <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                {a.preview.map((l) => (
                  <div key={l.id} className="small" data-preview-line={l.id}>
                    <strong>
                      {l.activity} {l.item}
                    </strong>{" "}
                    — {l.quantity == null ? "to measure" : `${l.quantity} ${l.unit}`}
                    <div className="muted">{l.calc}</div>
                    <div>{l.justification}</div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {(!a.applied || a.changes.length > 0) && (
            <button
              className="btn primary"
              disabled={!!busy || held.length > 0}
              onClick={() =>
                run("apply", async () => {
                  await api(`${base}/apply`, { body: { documentId: a.id, keys } });
                  onApplied();
                })
              }
            >
              {busy === "apply" ? "Applying…" : a.applied ? "Apply the ticked changes" : "Apply report to the scan"}
            </button>
          )}
          {a.applied && <div className="small">✓ Applied to {a.room?.label}. The lines below are proposed — accept them in the room as usual.</div>}

          <div className={`card small ${a.stillMissing.length ? "warn" : "ok"}`}>
            <strong>{a.stillMissing.length ? "Still missing after the report" : "The report answers every pending item"}</strong>
            {a.stillMissing.length > 0 && (
              <ul style={{ paddingLeft: 18, margin: "4px 0 0" }}>
                {a.stillMissing.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="small muted">Read by rules from the report text. {v.ai.message}</div>
        </>
      )}
    </section>
  );
}
