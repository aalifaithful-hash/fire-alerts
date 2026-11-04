"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "./Header";
import TimeField from "./TimeField";
import SetupBanner from "./SetupBanner";
import { api } from "./api";
import { useStatus } from "./useStatus";
import type { Project } from "@/lib/types";
import { QUICK_JOBS, QUICK_JOB_LABELS, type QuickJob } from "@/lib/quickJobs";

type Row = Project & { visitCount: number; lastVisit: string | null };

export default function ProjectList() {
  const router = useRouter();
  const status = useStatus();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ address: "", unit: "", customer: "", phone: "", job: "" as QuickJob | "", appointmentTime: "", notes: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ projects: Row[] }>(`/api/projects?q=${encodeURIComponent(q)}`).then((r) => setRows(r.projects)).catch((e) => setErr(e.message));
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  // One tap: property, assignment, project, visit and a first room scan from the notes → straight to the proposed lines.
  const create = async () => {
    setErr("");
    setBusy(true);
    try {
      const r = await api<{ projectId: string; visitId: string }>("/api/quickstart", { body: form });
      router.push(`/projects/${r.projectId}?visit=${r.visitId}&tab=scan`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <Header />
      <main className="page">
        {status && !status.aiConfigured && <SetupBanner />}
        <div className="row" style={{ marginBottom: 12 }}>
          <input className="in grow" type="search" placeholder="Search address, customer, claim #…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
        </div>
        {!creating ? (
          <div className="stack">
            <a className="btn primary big" href="/inbox">
              Paste an FNOL (new assignment)
            </a>
            <button className="btn big" onClick={() => setCreating(true)}>
              + Quick start without an FNOL
            </button>
          </div>
        ) : (
          <div className="card stack">
            <h3 style={{ marginTop: 0 }}>Quick start — no FNOL</h3>
            <label className="field">
              <span>Property address *</span>
              <input className="in" autoFocus value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="123 Main St, New York, NY 10001" aria-label="Property address" />
            </label>
            <div className="grid2">
              <label className="field">
                <span>Unit</span>
                <input className="in" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="4D" aria-label="Unit" />
              </label>
              <div className="field">
                <span>Visit time</span>
                <TimeField label="Visit time" value={form.appointmentTime || null} onChange={(t) => setForm((f) => ({ ...f, appointmentTime: t ?? "" }))} />
              </div>
              <label className="field">
                <span>Customer</span>
                <input className="in" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} aria-label="Customer" />
              </label>
              <label className="field">
                <span>Phone</span>
                <input className="in" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} aria-label="Phone" />
              </label>
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--muted)" }}>Kind of job *</div>
              <div className="row" style={{ marginTop: 6 }} role="group" aria-label="Kind of job">
                {QUICK_JOBS.map((j) => (
                  <button key={j} type="button" className={`btn sm ${form.job === j ? "on" : ""}`} aria-pressed={form.job === j} onClick={() => setForm({ ...form, job: j })}>
                    {form.job === j ? "✓ " : ""}
                    {QUICK_JOB_LABELS[j]}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>Notes (what you know so far)</span>
              <textarea className="in" style={{ minHeight: 80 }} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Mold under wood flooring in the bedroom. Mold report to follow." aria-label="Notes" />
            </label>
            <p className="small muted">Builds the first scope lines from your notes right away (rules, not AI). Measurements and room details come next.</p>
            <div className="row">
              <button className="btn primary grow big" disabled={busy || !form.address.trim() || !form.job} onClick={create}>
                {busy ? "Building scope…" : "Start scope"}
              </button>
              <button className="btn ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {err && <p style={{ color: "var(--fire)", marginTop: 10 }}>{err}</p>}

        <h2>Projects</h2>
        {rows === null && <p className="muted">Loading…</p>}
        {rows?.length === 0 && (
          <div className="card">
            <p>No projects{q ? " match your search" : " yet"}.</p>
            {!q && (
              <button
                className="btn sm"
                style={{ marginTop: 10 }}
                onClick={async () => {
                  const r = await api<{ project: Project }>("/api/projects/demo", { method: "POST" });
                  router.push(`/projects/${r.project.id}`);
                }}
              >
                Load a DEMO project (fictional sample data)
              </button>
            )}
          </div>
        )}
        {rows?.map((p) => (
          <a key={p.id} className="list-item" href={`/projects/${p.id}`}>
            <div className="row">
              <span className="t grow">{p.address || p.name}</span>
              {p.isDemo && <span className="chip amber">DEMO</span>}
            </div>
            <div className="small muted">
              {[p.customer, p.claimNumber && `Claim ${p.claimNumber}`, p.lossType, `${p.visitCount} visit${p.visitCount === 1 ? "" : "s"}`, p.lastVisit && `last ${p.lastVisit}`]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </a>
        ))}
      </main>
    </>
  );
}
