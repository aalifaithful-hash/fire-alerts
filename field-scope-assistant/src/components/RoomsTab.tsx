"use client";
import { useState } from "react";
import { api } from "./api";
import { locLabel } from "./labels";
import type { WorkspaceData } from "./types";
import type { Location } from "@/lib/schemas";

type P = { ws: WorkspaceData; projectId: string; reload: () => Promise<WorkspaceData | null>; flash: (m: string) => void };

export default function RoomsTab({ ws, projectId, reload, flash }: P) {
  const [f, setF] = useState({ floor: "", unit: "", room: "" });
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<string | null>(null);

  // floor → unit → rooms
  const tree = new Map<string, Map<string, Location[]>>();
  for (const l of ws.locations) {
    const fl = l.floor ?? "";
    const un = l.unit ?? "";
    if (!tree.has(fl)) tree.set(fl, new Map());
    const m = tree.get(fl)!;
    if (!m.has(un)) m.set(un, []);
    m.get(un)!.push(l);
  }
  const countFor = (id: string) => ws.evidence.filter((e) => e.locationId === id).length;

  return (
    <div>
      <div className="card stack">
        <h3 style={{ marginTop: 0 }}>Add room</h3>
        <div className="grid2">
          <input className="in" placeholder="Floor (e.g. 19)" value={f.floor} onChange={(e) => setF({ ...f, floor: e.target.value })} />
          <input className="in" placeholder="Unit (e.g. 19C)" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
        </div>
        <input className="in" placeholder="Room (e.g. Closet)" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} />
        {err && <div style={{ color: "var(--fire)" }}>{err}</div>}
        <button
          className="btn primary"
          disabled={!f.room.trim()}
          onClick={async () => {
            setErr("");
            try {
              await api(`/api/projects/${projectId}/locations`, { body: f });
              setF({ ...f, room: "" });
              reload();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Add room
        </button>
      </div>
      <h2>Floors, units and rooms</h2>
      {!ws.locations.length && <p className="muted">Rooms are created from your notes and the PDF, or add them here.</p>}
      {[...tree.entries()].map(([floor, units]) => (
        <div key={floor} className="card" style={{ marginBottom: 10 }}>
          <div style={{ fontFamily: "var(--stamp)", fontSize: 18, fontWeight: 700, textTransform: "uppercase" }}>{floor ? (/^\d+$/.test(floor) ? `Floor ${floor}` : floor) : "No floor"}</div>
          {[...units.entries()].map(([unit, rooms]) => (
            <div key={unit} style={{ marginTop: 8 }}>
              {unit && <div style={{ fontWeight: 600 }}>Unit {unit}</div>}
              {rooms.map((l) =>
                edit === l.id ? (
                  <RoomEditor
                    key={l.id}
                    loc={l}
                    onCancel={() => setEdit(null)}
                    onSave={async (v) => {
                      await api(`/api/projects/${projectId}/locations/${l.id}`, { method: "PATCH", body: v });
                      setEdit(null);
                      reload();
                      flash("Room updated — scopes re-rendered");
                    }}
                    onDelete={async () => {
                      if (!confirm(`Delete ${locLabel(l)}? Its findings move to “Location to confirm”.`)) return;
                      await api(`/api/projects/${projectId}/locations/${l.id}`, { method: "DELETE" });
                      setEdit(null);
                      reload();
                    }}
                  />
                ) : (
                  <button key={l.id} className="list-item" style={{ marginTop: 6 }} onClick={() => setEdit(l.id)}>
                    <span className="row">
                      <span className="grow">{l.room}</span>
                      <span className="small muted">📷 {countFor(l.id)}</span>
                    </span>
                  </button>
                ),
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RoomEditor({ loc, onSave, onCancel, onDelete }: { loc: Location; onSave: (v: { floor: string; unit: string; room: string }) => void; onCancel: () => void; onDelete: () => void }) {
  const [v, setV] = useState({ floor: loc.floor ?? "", unit: loc.unit ?? "", room: loc.room });
  return (
    <div className="card stack" style={{ marginTop: 6 }}>
      <div className="grid2">
        <input className="in" placeholder="Floor" value={v.floor} onChange={(e) => setV({ ...v, floor: e.target.value })} />
        <input className="in" placeholder="Unit" value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value })} />
      </div>
      <input className="in" placeholder="Room" value={v.room} onChange={(e) => setV({ ...v, room: e.target.value })} />
      <div className="row">
        <button className="btn primary grow" disabled={!v.room.trim()} onClick={() => onSave(v)}>
          Save
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
