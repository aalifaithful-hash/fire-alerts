"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "./Header";
import { api } from "./api";
import { SERVICE_LINES, SERVICE_LINE_LABELS, VISIT_STAGES, VISIT_STAGE_LABELS, type FnolParse, type ServiceLine } from "@/lib/fnol";
import type { Assignment, AssignmentInput, Property } from "@/lib/intake";
import { formatTimestampNY } from "@/lib/time";

type ParseResult = {
  parse: FnolParse;
  input: AssignmentInput;
  matchedProperty: Property | null;
  propertyHistory: { id: string; serviceLines: ServiceLine[]; stage: string; receivedAt: string; status: string; claimNumber: string | null }[];
  deadlines: { program: string; deadlines: { label: string; due: string; hours: number }[] };
};
type Row = Assignment & { property: Property | null };

const CONF_LABEL: Record<string, string> = { labeled: "from a labeled field", keyword: "from a keyword", assumed: "assumed — confirm" };

export default function Inbox() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [res, setRes] = useState<ParseResult | null>(null);
  const [form, setForm] = useState<AssignmentInput | null>(null);
  const [saved, setSaved] = useState<{ assignment: Assignment; property: Property; propertyCreated: boolean } | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const loadRows = () => api<{ assignments: Row[] }>("/api/assignments").then((r) => setRows(r.assignments)).catch((e) => setErr(e.message));
  useEffect(() => {
    void loadRows();
  }, []);

  const parse = async () => {
    setErr("");
    setSaved(null);
    setBusy("parse");
    try {
      const r = await api<ParseResult>("/api/fnol/parse", { body: { text } });
      setRes(r);
      setForm(r.input);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    if (!form) return;
    setErr("");
    setBusy("save");
    try {
      const r = await api<{ assignment: Assignment; property: Property; propertyCreated: boolean }>("/api/assignments", { body: { rawText: text, input: form } });
      setSaved(r);
      setRes(null);
      setForm(null);
      setText("");
      void loadRows();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const open = async (aid: string) => {
    setBusy("open");
    try {
      const r = await api<{ projectId: string; visitId: string }>(`/api/assignments/${aid}/open`, { body: {} });
      router.push(`/projects/${r.projectId}?visit=${r.visitId}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy("");
    }
  };

  const set = <K extends keyof AssignmentInput>(k: K, v: AssignmentInput[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const ev = (k: keyof FnolParse) => {
    const f = res?.parse[k] as { confidence: string; evidence: string } | null | undefined;
    return f && typeof f === "object" && "confidence" in f ? (
      <span className="small muted" title={f.evidence}>
        {" "}
        · {CONF_LABEL[f.confidence]}
      </span>
    ) : (
      <span className="small muted"> · not found</span>
    );
  };
  const field = (k: keyof AssignmentInput, label: string, evKey: keyof FnolParse, type = "text") => (
    <label className="field">
      <span>
        {label}
        {ev(evKey)}
      </span>
      <input
        className="in"
        type={type}
        value={(form?.[k] as string | null) ?? ""}
        onChange={(e) => set(k, (e.target.value || null) as never)}
        aria-label={label}
      />
    </label>
  );

  return (
    <>
      <Header crumb="FNOL inbox" />
      <main className="page">
        <h2 style={{ marginTop: 4 }}>Paste an FNOL</h2>
        <div className="card stack">
          <textarea
            className="in"
            style={{ minHeight: 180 }}
            placeholder="Paste the FNOL / assignment message from Slack, email or the dispatch system…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="FNOL text"
          />
          <button className="btn primary big" disabled={!text.trim() || !!busy} onClick={parse}>
            {busy === "parse" ? "Reading…" : "Parse"}
          </button>
          <p className="small muted">Read by rules, not AI. Nothing is saved until you review and tap Save.</p>
        </div>
        {err && <div className="card danger" style={{ marginTop: 10 }}>{err}</div>}

        {saved && (
          <div className="card ok" style={{ marginTop: 12 }}>
            <strong>Saved.</strong> {saved.propertyCreated ? "New property created" : "Added to the existing property"}:{" "}
            <a href={`/properties/${saved.property.id}`}>{saved.property.address}</a>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={!!busy} onClick={() => open(saved.assignment.id)}>
                Open project &amp; start visit
              </button>
              <a className="btn" href={`/properties/${saved.property.id}`}>
                Property history
              </a>
            </div>
          </div>
        )}

        {res && form && (
          <>
            <h2>Review before saving</h2>
            {res.parse.warnings.length > 0 && (
              <div className="card warn">
                {res.parse.warnings.map((w, i) => (
                  <div key={i} className="small">
                    ⚑ {w}
                  </div>
                ))}
              </div>
            )}
            {res.matchedProperty && (
              <div className="card" style={{ marginTop: 10 }}>
                <strong>Existing property:</strong> {res.matchedProperty.address}
                {res.matchedProperty.unit ? `, Unit ${res.matchedProperty.unit}` : ""} — this FNOL will be added as a new assignment.
                <ul className="small" style={{ paddingLeft: 18, marginTop: 6 }}>
                  {res.propertyHistory.map((h) => (
                    <li key={h.id}>
                      {formatTimestampNY(h.receivedAt)} · {h.serviceLines.join(" + ")} · {h.stage.replace(/_/g, " ")} · {h.status}
                      {h.claimNumber ? ` · claim ${h.claimNumber}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="card stack" style={{ marginTop: 10 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--muted)" }}>Kind of work (service lines)</div>
                <div className="row" style={{ marginTop: 6 }}>
                  {SERVICE_LINES.map((l) => {
                    const on = form.serviceLines.includes(l);
                    const hit = res.parse.serviceLines.find((x) => x.value === l);
                    return (
                      <button
                        key={l}
                        type="button"
                        className={`btn sm ${on ? "on" : ""}`}
                        title={hit?.evidence}
                        onClick={() => set("serviceLines", on ? form.serviceLines.filter((x) => x !== l) : [...form.serviceLines, l])}
                      >
                        {on ? "✓ " : ""}
                        {SERVICE_LINE_LABELS[l]}
                      </button>
                    );
                  })}
                </div>
                <label className="row small" style={{ marginTop: 6 }}>
                  <input type="checkbox" checked={form.contentsOnly} onChange={(e) => set("contentsOnly", e.target.checked)} /> Contents only (no structure work)
                </label>
              </div>
              <label className="field">
                <span>
                  Kind of visit (stage){ev("stage")}
                </span>
                <select className="in" value={form.stage} onChange={(e) => set("stage", e.target.value as AssignmentInput["stage"])} aria-label="Visit stage">
                  {VISIT_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {VISIT_STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              {res.parse.stageConflict && <div className="small" style={{ color: "var(--amber)" }}>⚑ {res.parse.stageConflict}</div>}
              <label className="row">
                <input type="checkbox" checked={form.special} onChange={(e) => set("special", e.target.checked)} /> <strong>Special assignment</strong>
                {ev("special")}
              </label>
              {form.special && (
                <label className="field">
                  <span>Special instructions / reason</span>
                  <textarea className="in" style={{ minHeight: 70 }} value={form.specialReason ?? ""} onChange={(e) => set("specialReason", e.target.value || null)} />
                </label>
              )}
              <div className="grid2">
                {field("claimNumber", "Claim #", "claimNumber")}
                {field("assignmentNumber", "Job / assignment #", "assignmentNumber")}
                {field("carrier", "Carrier", "carrier")}
                {field("program", "Program / TPA", "program")}
                {field("insured", "Insured / customer", "insured")}
                {field("contactPhone", "Phone", "contactPhone")}
              </div>
              {field("address", "Property address *", "address")}
              <div className="grid2">
                {field("unit", "Unit", "unit")}
                {field("lossDate", "Date of loss", "lossDate", "date")}
                {field("lossType", "Loss type", "lossType")}
                {field("receivedAt", "Received (starts deadlines)", "receivedAt")}
              </div>
              <label className="field">
                <span>
                  Cause of loss{ev("causeOfLoss")}
                </span>
                <textarea className="in" style={{ minHeight: 70 }} value={form.causeOfLoss ?? ""} onChange={(e) => set("causeOfLoss", e.target.value || null)} />
              </label>
              <div className="small muted">
                Deadlines ({res.deadlines.program}):{" "}
                {res.deadlines.deadlines.map((d) => `${d.label} within ${d.hours} h`).join(" · ")}
              </div>
              <button className="btn primary big" disabled={!!busy || !form.address.trim() || !form.serviceLines.length} onClick={save}>
                {busy === "save" ? "Saving…" : "Save assignment"}
              </button>
            </div>
          </>
        )}

        <h2>Assignments</h2>
        {rows === null && <p className="muted">Loading…</p>}
        {rows?.length === 0 && <p className="muted">No assignments yet. Paste an FNOL above.</p>}
        {rows?.map((a) => (
          <div key={a.id} className="list-item">
            <div className="row">
              <a className="t grow" href={a.property ? `/properties/${a.property.id}` : "#"}>
                {a.property?.address ?? "?"}
                {a.property?.unit ? `, Unit ${a.property.unit}` : ""}
              </a>
              <span className={`chip ${a.status === "new" ? "amber" : a.status === "linked" ? "green" : ""}`}>{a.status}</span>
              {a.special && <span className="chip red">special</span>}
            </div>
            <div className="small muted">
              {a.serviceLines.map((l) => SERVICE_LINE_LABELS[l]).join(" + ")}
              {a.contentsOnly ? " (contents only)" : ""} · {VISIT_STAGE_LABELS[a.stage]} · received {formatTimestampNY(a.receivedAt)}
              {a.claimNumber ? ` · claim ${a.claimNumber}` : ""}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              {a.projectId ? (
                <a className="btn sm" href={`/projects/${a.projectId}`}>
                  Open project
                </a>
              ) : (
                <button className="btn sm primary" disabled={!!busy} onClick={() => open(a.id)}>
                  Open project &amp; start visit
                </button>
              )}
            </div>
          </div>
        ))}
      </main>
    </>
  );
}
