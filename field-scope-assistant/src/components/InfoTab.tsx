"use client";
import { useState } from "react";
import { api } from "./api";
import type { WorkspaceData } from "./types";
import type { Project } from "@/lib/types";
import { SERVICE_LINES, SERVICE_LINE_LABELS, VISIT_STAGES, VISIT_STAGE_LABELS } from "@/lib/fnol";

const FIELDS: { key: keyof Project; label: string; type?: string; options?: [string, string][] }[] = [
  { key: "address", label: "Property address" },
  { key: "customer", label: "Customer" },
  { key: "contact", label: "Contact (name / phone)" },
  { key: "pm", label: "PM" },
  { key: "jfcPma", label: "JFC / PMA" },
  { key: "lossDate", label: "Loss date", type: "date" },
  { key: "lossType", label: "Loss type (water, fire, smoke, sewage, mold, cleaning)" },
  { key: "causeOfLoss", label: "Cause of loss" },
  { key: "sourceStatus", label: "Source", options: [["", "Not recorded"], ["repaired", "Repaired"], ["stopped", "Stopped"], ["active", "Active"], ["unknown", "Unknown"]] },
  { key: "category", label: "Category (only when confirmed)" },
  { key: "waterClass", label: "Class (only when confirmed)" },
  { key: "payer", label: "Payer", options: [["", "Not recorded"], ["insurance", "Insurance"], ["self_pay", "Self-pay"]] },
  { key: "carrier", label: "Insurance carrier" },
  { key: "claimNumber", label: "Claim #" },
  { key: "crewRequirements", label: "Crew (e.g. CC+4)" },
  { key: "productionDays", label: "Production days" },
  { key: "equipmentDays", label: "Equipment days" },
  { key: "accessRestrictions", label: "Access restrictions" },
];

export default function InfoTab({ ws, projectId, reload, flash }: { ws: WorkspaceData; projectId: string; reload: () => Promise<WorkspaceData | null>; flash: (m: string) => void }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, String(ws.project[f.key] ?? "")])));
  const [dirty, setDirty] = useState(false);
  return (
    <div className="stack">
      <p className="small muted">Nothing here is required. Your field notes update cause, source, category and crew automatically.</p>
      {FIELDS.map((f) => (
        <label key={f.key} className="field">
          <span>{f.label}</span>
          {f.options ? (
            <select className="in" value={v[f.key]} onChange={(e) => (setV({ ...v, [f.key]: e.target.value }), setDirty(true))}>
              {f.options.map(([val, l]) => (
                <option key={val} value={val}>
                  {l}
                </option>
              ))}
            </select>
          ) : (
            <input className="in" type={f.type ?? "text"} value={v[f.key]} onChange={(e) => (setV({ ...v, [f.key]: e.target.value }), setDirty(true))} />
          )}
        </label>
      ))}
      <button
        className="btn primary big"
        disabled={!dirty}
        onClick={async () => {
          await api(`/api/projects/${projectId}`, { method: "PATCH", body: { ...v, name: v.address } });
          setDirty(false);
          reload();
          flash("Project saved");
        }}
      >
        Save project info
      </button>
      <section className="card stack" aria-label="Visits — kind of work and stage">
        <strong>Visits — kind of work and stage</strong>
        <p className="small muted" style={{ margin: 0 }}>
          Set each visit&apos;s kind of work (EMS, mitigation, mold, reconstruction, contents) and stage (initial walk-through, kickoff, monitoring, final). A job with more than one kind of work: add a visit for each (Scope → New visit), or pick
          &quot;Also on this job&quot; in Quick Start.
        </p>
        {ws.visits.length === 0 && <div className="small muted">No visits yet.</div>}
        {ws.visits.map((vi) => (
          <div key={vi.id} className="grid2">
            <label className="field">
              <span>{vi.visitDate} — kind of work</span>
              <select
                className="in"
                aria-label={`Kind of work for the visit on ${vi.visitDate}`}
                value={vi.serviceLine ?? ""}
                onChange={async (e) => {
                  await api(`/api/projects/${projectId}/visits/${vi.id}`, { method: "PATCH", body: { serviceLine: e.target.value || null } });
                  await reload();
                  flash("Visit updated");
                }}
              >
                <option value="">Not set</option>
                {SERVICE_LINES.map((l) => (
                  <option key={l} value={l}>
                    {SERVICE_LINE_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Stage</span>
              <select
                className="in"
                aria-label={`Stage for the visit on ${vi.visitDate}`}
                value={vi.stage ?? ""}
                onChange={async (e) => {
                  await api(`/api/projects/${projectId}/visits/${vi.id}`, { method: "PATCH", body: { stage: e.target.value || null } });
                  await reload();
                  flash("Visit updated");
                }}
              >
                <option value="">Not set</option>
                {VISIT_STAGES.map((st) => (
                  <option key={st} value={st}>
                    {VISIT_STAGE_LABELS[st]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
      </section>
      <div className="card danger" style={{ marginTop: 30 }}>
        <strong>Delete project</strong>
        <p className="small" style={{ margin: "6px 0 10px" }}>Permanently deletes this project, its uploaded PDFs, evidence, visits and every draft version.</p>
        <button
          className="btn danger"
          onClick={async () => {
            if (!confirm(`Permanently delete ${ws.project.address || ws.project.name}?`)) return;
            await api(`/api/projects/${projectId}`, { method: "DELETE" });
            window.location.href = "/";
          }}
        >
          Delete project and files
        </button>
      </div>
    </div>
  );
}
