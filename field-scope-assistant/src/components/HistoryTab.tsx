"use client";
import { VISIT_TYPE_LABELS } from "@/lib/schemas";
import { formatDate, formatTime } from "@/lib/time";
import type { WorkspaceData } from "./types";

export default function HistoryTab({ ws, visitId, openVisit }: { ws: WorkspaceData; visitId: string | null; openVisit: (id: string) => void }) {
  if (!ws.visits.length) return <p className="muted">No visits yet.</p>;
  return (
    <div>
      <h2 style={{ marginTop: 4 }}>Visit history</h2>
      {[...ws.visits].reverse().map((v) => (
        <button key={v.id} className="list-item" onClick={() => openVisit(v.id)} style={v.id === visitId ? { borderColor: "var(--fire)" } : undefined}>
          <div className="row">
            <span className="t grow">{formatDate(v.visitDate)}</span>
            {!v.hasDraft && <span className="chip">no draft</span>}
          </div>
          <div className="small muted">
            {[VISIT_TYPE_LABELS[v.type], v.appointmentTime && `appt ${formatTime(v.appointmentTime)}`, v.accessOutcome].filter(Boolean).join(" · ")}
          </div>
        </button>
      ))}
    </div>
  );
}
