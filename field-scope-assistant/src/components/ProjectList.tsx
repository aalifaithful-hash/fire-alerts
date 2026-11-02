"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "./Header";
import SetupBanner from "./SetupBanner";
import { api } from "./api";
import { useStatus } from "./useStatus";
import type { Project } from "@/lib/types";

type Row = Project & { visitCount: number; lastVisit: string | null };

export default function ProjectList() {
  const router = useRouter();
  const status = useStatus();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ address: "", customer: "", claimNumber: "" });
  const [err, setErr] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ projects: Row[] }>(`/api/projects?q=${encodeURIComponent(q)}`).then((r) => setRows(r.projects)).catch((e) => setErr(e.message));
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  const create = async () => {
    setErr("");
    try {
      const r = await api<{ project: Project }>("/api/projects", { body: { ...form, name: form.address } });
      router.push(`/projects/${r.project.id}`);
    } catch (e) {
      setErr((e as Error).message);
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
          <button className="btn primary big" onClick={() => setCreating(true)}>
            + New project
          </button>
        ) : (
          <div className="card stack">
            <h3 style={{ marginTop: 0 }}>New project</h3>
            <label className="field">
              <span>Property address *</span>
              <input className="in" autoFocus value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="123 Main St, Apt 4B, New York, NY" />
            </label>
            <div className="grid2">
              <label className="field">
                <span>Customer</span>
                <input className="in" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} />
              </label>
              <label className="field">
                <span>Claim #</span>
                <input className="in" value={form.claimNumber} onChange={(e) => setForm({ ...form, claimNumber: e.target.value })} />
              </label>
            </div>
            <p className="small muted">Everything else is optional — add it later or let your notes fill it in.</p>
            <div className="row">
              <button className="btn primary grow" disabled={!form.address.trim()} onClick={create}>
                Create and open
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
