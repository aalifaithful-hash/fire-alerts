"use client";
import { VISIT_TYPE_LABELS } from "@/lib/schemas";
import { SERVICE_LINE_LABELS, VISIT_STAGE_LABELS } from "@/lib/fnol";
import { formatDate, formatTime, formatTimestampNY } from "@/lib/time";
import type { WorkspaceData } from "./types";

export default function HistoryTab({ ws, visitId, openVisit }: { ws: WorkspaceData; visitId: string | null; openVisit: (id: string) => void }) {
  return (
    <div>
      {ws.assignments.length > 0 && (
        <>
          <h2 style={{ marginTop: 4 }}>Assignments</h2>
          {ws.assignments.map((a) => (
            <div key={a.id} className="card" style={{ marginBottom: 8 }}>
              <div className="row">
                <strong className="grow">{a.serviceLines.map((l) => SERVICE_LINE_LABELS[l]).join(" + ")}</strong>
                {a.special && <span className="chip red">special</span>}
                <a className="small" href={`/properties/${a.propertyId}`}>
                  Property history
                </a>
              </div>
              <div className="small muted">
                {VISIT_STAGE_LABELS[a.stage]} · received {formatTimestampNY(a.receivedAt)}
                {a.claimNumber ? ` · claim ${a.claimNumber}` : ""}
              </div>
              <ul className="small" style={{ paddingLeft: 18, marginTop: 4 }}>
                {a.history.map((h, i) => (
                  <li key={i}>
                    {formatTimestampNY(h.at)} — {h.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      <h2 style={{ marginTop: ws.assignments.length ? undefined : 4 }}>Visit history</h2>
      {!ws.visits.length && <p className="muted">No visits yet.</p>}
      {[...ws.visits].reverse().map((v, i, arr) => {
        const monitoringDay = v.stage === "daily_monitoring" ? arr.slice(i).filter((x) => x.stage === "daily_monitoring").length : null;
        return (
          <button key={v.id} className="list-item" onClick={() => openVisit(v.id)} style={v.id === visitId ? { borderColor: "var(--fire)" } : undefined}>
            <div className="row">
              <span className="t grow">{formatDate(v.visitDate)}</span>
              {!v.hasDraft && <span className="chip">no draft</span>}
            </div>
            <div className="small muted">
              {[
                v.stage ? VISIT_STAGE_LABELS[v.stage] + (monitoringDay ? ` — day ${monitoringDay}` : "") : null,
                v.serviceLine ? SERVICE_LINE_LABELS[v.serviceLine] : null,
                VISIT_TYPE_LABELS[v.type],
                v.appointmentTime && `appt ${formatTime(v.appointmentTime)}`,
                v.accessOutcome,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </button>
        );
      })}
    </div>
  );
}
