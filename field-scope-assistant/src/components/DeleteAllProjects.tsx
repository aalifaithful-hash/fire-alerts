"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type P = { id: string; name: string; address: string; customer: string | null; visitCount: number };

/**
 * "Delete All Projects" — one button, then an IN-PAGE confirmation panel (no browser confirm/alert,
 * so it works on a phone and in automated browsers). Nothing is deleted until the second, explicit
 * "Yes, delete all" tap; the server also refuses unless it gets the confirmation phrase and the exact
 * list of projects this panel showed.
 */
export default function DeleteAllProjects({ onDeleted, listVersion }: { onDeleted: (n: number, unlinked: number) => void; listVersion: number }) {
  const [all, setAll] = useState<P[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => api<{ projects: P[] }>("/api/projects").then((r) => setAll(r.projects)), []);
  // refresh the count when the list changes — without closing an open panel
  useEffect(() => {
    if (!open) load().catch((e) => setErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, listVersion]);

  if (!all || all.length === 0) return null;
  const n = all.length;

  const confirmDelete = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ deleted: number; unlinkedAssignments: number }>("/api/projects/delete-all", { body: { confirm: "DELETE ALL PROJECTS", ids: all.map((p) => p.id) } });
      setOpen(false);
      setAll([]);
      onDeleted(r.deleted, r.unlinkedAssignments);
    } catch (e) {
      setErr((e as Error).message);
      await load().catch(() => undefined); // show the current list if it changed
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 28 }}>
      {!open ? (
        <button className="btn danger" onClick={() => setOpen(true)} aria-label={`Delete All Projects (${n})`}>
          Delete All Projects ({n})
        </button>
      ) : (
        <div className="card danger stack" role="alertdialog" aria-modal="false" aria-labelledby="delall-title" aria-describedby="delall-desc">
          <strong id="delall-title">Delete all {n} projects?</strong>
          <p id="delall-desc" className="small" style={{ margin: 0 }}>
            This permanently deletes <strong>ALL {n} projects</strong>, their uploaded PDFs and reports, evidence, visits, room scans and every draft version.{" "}
            <strong>There is no undo.</strong> FNOL assignments stay in the inbox; any linked to these projects go back to “new” so they can be linked again.
          </p>
          <div className="small" style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--line, #ddd)", borderRadius: 6, padding: "4px 8px" }} aria-label="Projects to delete">
            <ol style={{ paddingLeft: 18, margin: 0 }}>
              {all.map((p) => (
                <li key={p.id}>
                  {p.address || p.name}
                  {p.customer ? ` — ${p.customer}` : ""} <span className="muted">({p.visitCount} visit{p.visitCount === 1 ? "" : "s"})</span>
                </li>
              ))}
            </ol>
          </div>
          {err && <div className="small" style={{ color: "var(--fire, #c53030)" }}>{err}</div>}
          <div className="row">
            <button className="btn danger grow" disabled={busy} onClick={confirmDelete}>
              {busy ? "Deleting…" : `Yes, delete all ${n} projects`}
            </button>
            <button className="btn" disabled={busy} onClick={() => { setOpen(false); setErr(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
