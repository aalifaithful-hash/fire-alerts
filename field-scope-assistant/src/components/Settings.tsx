"use client";
import { useEffect, useRef, useState } from "react";
import Header from "./Header";
import { api } from "./api";
import { useStatus } from "./useStatus";
import { VISIT_TYPES, VISIT_TYPE_LABELS, type VisitType } from "@/lib/schemas";
import type { ChecklistTemplate, Manual } from "@/lib/repo";

type Conflict = { id: string; description: string; manualIds: string[] };

export default function Settings() {
  const status = useStatus();
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [manuals, setManuals] = useState<Manual[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [editing, setEditing] = useState<{ id?: string; name: string; visitTypes: VisitType[]; items: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const [t, m] = await Promise.all([api<{ templates: ChecklistTemplate[] }>("/api/templates"), api<{ manuals: Manual[]; conflicts: Conflict[] }>("/api/manuals")]);
    setTemplates(t.templates);
    setManuals(m.manuals);
    setConflicts(m.conflicts);
  };
  useEffect(() => {
    load().catch((e) => setErr(e.message));
  }, []);

  return (
    <>
      <Header crumb="Settings" />
      <main className="page">
        <h2 style={{ marginTop: 4 }}>Setup</h2>
        <div className={`card ${status?.aiConfigured ? "ok" : "warn"}`}>
          {status ? (
            status.aiConfigured ? (
              <>
                AI analysis is configured (model <span className="mono">{status.model}</span>).
              </>
            ) : (
              <>
                <strong>AI is off: ANTHROPIC_API_KEY is not set.</strong> Everything else works — see the steps below to turn AI on.
              </>
            )
          ) : (
            "Checking…"
          )}
          <div className="small" style={{ marginTop: 6 }}>
            Passcode protection: {status?.passcodeEnabled ? "on" : "off (set APP_PASSCODE to require one)"}.
          </div>
          {status?.passcodeEnabled && (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={async () => { await fetch("/api/login", { method: "DELETE" }); window.location.href = "/"; }}>
              Sign out
            </button>
          )}
        </div>

        {err && <div className="card danger">{err}</div>}

        <h2 id="ai-key">Turning on AI</h2>
        <div className="card small stack">
          <p>
            AI features use an Anthropic API key. It is billed by Anthropic per use (separate from Vercel) and stays on the server — it is
            never sent to phones or browsers.
          </p>
          <ol style={{ paddingLeft: 18 }}>
            <li>
              Sign up or sign in at <span className="mono">console.anthropic.com</span>.
            </li>
            <li>Under Billing, add a payment method (and credits if asked). Keys don’t work until billing is set up.</li>
            <li>
              Under API Keys, create a key and copy it (starts with <span className="mono">sk-ant-</span>). You only see it once.
            </li>
            <li>
              In Vercel: project <strong>fire-alerts</strong> → Settings → Environment Variables → add <span className="mono">ANTHROPIC_API_KEY</span>{" "}
              with the key, for Production (and Preview if you use preview links).
            </li>
            <li>
              Redeploy (Deployments → latest → Redeploy). Environment variables only apply to new deployments. This page then shows “AI analysis
              is configured”.
            </li>
          </ol>
          <p>
            <strong>What it unlocks:</strong> reading PDF photos and sorting them by room (PDFs already uploaded are analyzed the next time you open the Photos tab), AI-drafted scopes,
            plain-language corrections, AI questions and suggestions, checklist auto-fill, and manual rule extraction. Model:{" "}
            <span className="mono">{status?.model ?? "claude-opus-5-5"}</span>.
          </p>
          <p className="muted">
            Recommended at the same time: set <span className="mono">APP_PASSCODE</span> so only people with the passcode can open customer data —
            the app is currently reachable by anyone with the link.
          </p>
        </div>

        <h2>Checklist templates</h2>
        <p className="small muted" style={{ marginTop: -4, marginBottom: 8 }}>Starter templates are examples — edit them to match your company checklist.</p>
        {templates.map((t) => (
          <div key={t.id} className="card">
            <div className="row">
              <strong className="grow">{t.name}</strong>
              {t.isStarter && <span className="chip amber">starter</span>}
            </div>
            <div className="small muted">{t.visitTypes.map((v) => VISIT_TYPE_LABELS[v]).join(", ") || "Any visit"} · {t.items.length} items</div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => setEditing({ id: t.id, name: t.name, visitTypes: t.visitTypes, items: t.items.map((i) => i.label).join("\n") })}>
                Edit
              </button>
              <button className="btn sm danger" onClick={async () => { await api(`/api/templates/${t.id}`, { method: "DELETE" }); load(); }}>
                Delete
              </button>
            </div>
          </div>
        ))}
        {!editing ? (
          <button className="btn" style={{ marginTop: 10 }} onClick={() => setEditing({ name: "", visitTypes: [], items: "" })}>
            + New template
          </button>
        ) : (
          <div className="card stack" style={{ marginTop: 10 }}>
            <input className="in" placeholder="Template name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <div className="row">
              {VISIT_TYPES.map((v) => (
                <button
                  key={v}
                  className={`btn sm ${editing.visitTypes.includes(v) ? "on" : ""}`}
                  onClick={() =>
                    setEditing({ ...editing, visitTypes: editing.visitTypes.includes(v) ? editing.visitTypes.filter((x) => x !== v) : [...editing.visitTypes, v] })
                  }
                >
                  {VISIT_TYPE_LABELS[v]}
                </button>
              ))}
            </div>
            <textarea className="in" placeholder="One checklist item per line" value={editing.items} onChange={(e) => setEditing({ ...editing, items: e.target.value })} />
            <div className="row">
              <button
                className="btn primary grow"
                onClick={async () => {
                  setErr("");
                  try {
                    await api("/api/templates", { body: { ...editing, items: editing.items.split("\n") } });
                    setEditing(null);
                    load();
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              >
                Save template
              </button>
              <button className="btn ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <h2>Company manuals</h2>
        <p className="small muted" style={{ marginTop: -4, marginBottom: 8 }}>
          Upload operating manuals (PDF or .txt). Rules extracted from them guide every scope; they are kept separate from job facts. Conflicting rules are flagged, never merged.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.txt,application/pdf,text/plain"
          className="hide"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy("upload");
            setErr("");
            try {
              const form = new FormData();
              form.append("file", f);
              const r = await api<{ manuals: Manual[]; conflicts: Conflict[] }>("/api/manuals", { form });
              setManuals(r.manuals);
              setConflicts(r.conflicts);
            } catch (er) {
              setErr((er as Error).message);
              load();
            } finally {
              setBusy("");
              if (fileRef.current) fileRef.current.value = "";
            }
          }}
        />
        <button className="btn" disabled={!!busy || !status?.aiConfigured} onClick={() => fileRef.current?.click()}>
          {busy === "upload" ? "Reading manual…" : "Upload manual"}
        </button>
        {conflicts.length > 0 && (
          <div className="card warn" style={{ marginTop: 10 }}>
            <strong>Conflicting rules ({conflicts.length})</strong>
            {conflicts.map((c) => (
              <div key={c.id} className="flag row">
                <span className="grow">{c.description}</span>
                <button className="btn sm" onClick={async () => setConflicts((await api<{ conflicts: Conflict[] }>(`/api/conflicts/${c.id}`, { method: "POST" })).conflicts)}>
                  Mark resolved
                </button>
              </div>
            ))}
          </div>
        )}
        {manuals.map((m) => (
          <details key={m.id} className="card" style={{ marginTop: 10 }}>
            <summary>
              {m.name} <span className="small muted" style={{ marginLeft: 6 }}>· {m.rules.length} rules · {m.status}</span>
            </summary>
            {m.error && <div className="small" style={{ color: "var(--fire)" }}>{m.error}</div>}
            <ul style={{ paddingLeft: 18, marginTop: 6 }} className="small">
              {m.rules.map((r) => (
                <li key={r.id}>
                  <strong>{r.topic}:</strong> {r.rule}
                </li>
              ))}
            </ul>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" disabled={!!busy} onClick={async () => { setBusy(m.id); try { const r = await api<{ manuals: Manual[]; conflicts: Conflict[] }>(`/api/manuals/${m.id}`, { method: "POST" }); setManuals(r.manuals); setConflicts(r.conflicts); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); } }}>
                Re-extract rules
              </button>
              <button className="btn sm danger" onClick={async () => { await api(`/api/manuals/${m.id}`, { method: "DELETE" }); load(); }}>
                Delete
              </button>
            </div>
          </details>
        ))}
      </main>
    </>
  );
}
