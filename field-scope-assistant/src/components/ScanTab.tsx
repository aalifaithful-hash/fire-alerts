"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReportPanel from "./ReportPanel";
import { api } from "./api";
import { locLabel } from "./labels";
import type { WorkspaceData } from "./types";
import { EXCLUSION_LABELS, EXCLUSION_TARGETS, WATER_SOURCES, type Exclusion, type RoomScanData, type ScopeLine } from "@/lib/scan";
import type { VisitScanView } from "@/lib/scans";

type Editable = Omit<RoomScanData, "lines" | "decisions">;
type Props = { ws: WorkspaceData; projectId: string; visitId: string | null; reload: () => Promise<WorkspaceData | null>; flash: (m: string) => void };

const blank = (): Editable => ({
  source: { where: "unknown", fixture: null, wall: null, positionFt: null, surface: null, status: "unknown", hoursSinceLoss: null, waterSource: null, hold: null },
  loss: { type: null, category: null, waterClass: null, smokeType: null, assessmentReport: null },
  materials: {
    flooring: { type: null, affected: false, affectedPct: null, action: null, choice: null, continuousRun: null, breakNote: null },
    baseboard: { affected: false, walls: [], action: null },
    walls: { material: null, affectedWalls: [], wetHeightIn: null, floodCut: "auto", statedRemovalSF: null, statedApproximate: false, cutSource: null },
    ceiling: { affected: false, affectedPct: null, action: null },
    insulation: false,
    subfloor: null,
    encapsulate: false,
    moldSpecial: [],
    ventHvacIfInaccessible: false,
    framing: { growth: false, where: null, action: null },
    cabinets: { affected: false, lf: null, detach: false },
    fixtures: [],
  },
  contents: { present: false, affected: false, items: null, handling: "none" },
  measurements: { lengthFt: null, widthFt: null, heightFt: null, segments: null, openings: [] },
  moisturePoints: [],
  equipmentPlaced: [],
  reportDocumentId: null,
  reportRoom: null,
  reportPrimary: false,
  reportValues: {},
  containmentGroup: null,
  lineNotes: {},
  reportChanges: [],
  containmentArea: null,
  reportNotes: [],
  quantityOverrides: {},
});
const WALLS = ["N", "E", "S", "W"];
const num = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Number(v));
const rid = () => Math.random().toString(36).slice(2, 10);
const KIND_LABEL: Record<ScopeLine["kind"], string> = {
  mitigation: "Mitigation",
  reconstruction: "Reconstruction",
  contents: "Contents",
  equipment: "Equipment (calculated — not installed)",
  monitoring: "Monitoring",
};

export default function ScanTab({ ws, projectId, visitId, reload, flash }: Props) {
  const [view, setView] = useState<VisitScanView | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<Editable>(blank());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"pm" | "estimator" | "crew">("pm");
  const [newRoom, setNewRoom] = useState({ floor: "", unit: "", room: "" });
  const base = `/api/projects/${projectId}/visits/${visitId}`;

  const load = useCallback(async () => {
    if (!visitId) return;
    try {
      setView(await api<VisitScanView>(`${base}/scans`));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [base, visitId]);
  useEffect(() => {
    void load();
  }, [load]);

  // No dead end: with one scanned room (e.g. right after Quick start), open it so its proposed lines show.
  useEffect(() => {
    if (!sel && view?.rooms.length === 1) setSel(view.rooms[0].locationId);
  }, [view, sel]);
  const room = view?.rooms.find((r) => r.locationId === sel) ?? null;
  useEffect(() => {
    if (!sel) return;
    const r = view?.rooms.find((x) => x.locationId === sel);
    if (r) {
      const { lines: _l, decisions: _d, ...rest } = r.data;
      void _l;
      void _d;
      setForm(rest);
    } else setForm(blank());
    setDirty(false);
    // only when switching rooms
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  if (!visitId) return <div className="card">Start a visit on the Scope tab first, then scan its rooms here.</div>;

  const run = async (label: string, fn: () => Promise<VisitScanView | void>) => {
    setBusy(label);
    setErr("");
    try {
      const v = await fn();
      if (v) setView(v);
      return v;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const upd = (f: (d: Editable) => void) => {
    setForm((prev) => {
      const next = structuredClone(prev);
      f(next);
      return next;
    });
    setDirty(true);
  };
  const save = () =>
    run("save", async () => {
      const v = await api<VisitScanView>(`${base}/scans/${sel}`, { method: "PUT", body: { data: form } });
      setDirty(false);
      flash("Room saved — lines updated");
      void reload();
      return v;
    });
  const decide = (ids: string[], action: "accept" | "reject" | "reset") =>
    run("decide", async () => {
      const v = await api<VisitScanView>(`${base}/scans/${sel}/lines`, { body: { lineIds: ids, action } });
      void reload();
      return v;
    });
  const setQty = (lineId: string, quantity: number | null) =>
    run("qty", async () => {
      const v = await api<VisitScanView>(`${base}/scans/${sel}/quantity`, { body: { lineId, quantity } });
      void reload();
      return v;
    });
  const setOptions = (body: { exclusions?: Partial<Exclusion>[]; reconstructionRequested?: boolean }) =>
    run("opts", async () => {
      const v = await api<VisitScanView>(`${base}/scan-options`, { method: "PUT", body });
      void reload();
      return v;
    });

  const f = form;
  const m = f.materials;
  const water = f.loss.type === "water" || f.loss.type === "sewage";
  const lines = room?.data.lines ?? [];
  const recon = view?.reconstructionRequested ?? false;
  const moldJob = ws.visits.find((x) => x.id === visitId)?.serviceLine === "mold" || !!view?.rooms.some((r) => r.data.loss.type === "mold") || ws.documents.some((d) => d.kind === "mold_report");

  return (
    <div>
      {moldJob && (
        <ReportPanel
          projectId={projectId}
          visitId={visitId}
          onApplied={async () => {
            setSel(null);
            await load();
            await reload();
          }}
        />
      )}
      {/* 1. Room picker */}
      <h2 style={{ marginTop: 4 }}>1. Pick the room</h2>
      <div className="row">
        {ws.locations.map((l) => {
          const scanned = view?.rooms.some((r) => r.locationId === l.id);
          return (
            <button key={l.id} className={`btn sm ${sel === l.id ? "on" : ""}`} onClick={() => setSel(l.id)}>
              {scanned ? "✓ " : ""}
              {locLabel(l)}
            </button>
          );
        })}
      </div>
      <div className="card stack" style={{ marginTop: 8 }}>
        <div className="grid2">
          <input className="in" placeholder="Floor" value={newRoom.floor} onChange={(e) => setNewRoom({ ...newRoom, floor: e.target.value })} aria-label="New room floor" />
          <input className="in" placeholder="Unit" value={newRoom.unit} onChange={(e) => setNewRoom({ ...newRoom, unit: e.target.value })} aria-label="New room unit" />
        </div>
        <div className="row">
          <input className="in grow" placeholder="Room name (e.g. Kitchen)" value={newRoom.room} onChange={(e) => setNewRoom({ ...newRoom, room: e.target.value })} aria-label="New room name" />
          <button
            className="btn"
            disabled={!newRoom.room.trim()}
            onClick={async () => {
              try {
                const r = await api<{ location: { id: string } }>(`/api/projects/${projectId}/locations`, { body: newRoom });
                setNewRoom({ ...newRoom, room: "" });
                await reload();
                setSel(r.location.id);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Add room
          </button>
        </div>
      </div>
      {err && <div className="card danger" style={{ marginTop: 10 }}>{err}</div>}

      {sel && (
        <>
          {/* 2. Cause & location */}
          <h2>2. Cause and location in this room</h2>
          <div className="card stack">
            <div className="grid2">
              <Sel label="Where is the source?" value={f.source.where} onChange={(v) => upd((d) => (d.source.where = v as Editable["source"]["where"]))} options={[["in_room", "In this room"], ["above", "From above"], ["below", "From below"], ["adjacent", "From an adjacent room/unit"], ["exterior", "Exterior"], ["unknown", "Unknown"]]} />
              <Txt label="Fixture / line (e.g. supply line under sink)" value={f.source.fixture} onChange={(v) => upd((d) => (d.source.fixture = v))} />
              <Sel label="On which wall" value={f.source.wall ?? ""} onChange={(v) => upd((d) => (d.source.wall = v || null))} options={[["", "—"], ...WALLS.map((w) => [w, `${w} wall`] as [string, string])]} />
              <Num label="Position along that wall (ft from left end)" value={f.source.positionFt} onChange={(v) => upd((d) => (d.source.positionFt = v))} />
              <Sel label="Source status" value={f.source.status} onChange={(v) => upd((d) => (d.source.status = v as Editable["source"]["status"]))} options={[["unknown", "Unknown"], ["active", "Active"], ["stopped", "Stopped"], ["repaired", "Repaired"]]} />
              <Num label="Hours since loss" value={f.source.hoursSinceLoss} onChange={(v) => upd((d) => (d.source.hoursSinceLoss = v))} />
              <Sel label="Water source" value={f.source.waterSource ?? ""} onChange={(v) => upd((d) => (d.source.waterSource = (v || null) as Editable["source"]["waterSource"]))} options={[["", "—"], ...WATER_SOURCES.map((w) => [w, w.replace(/_/g, " ")] as [string, string])]} />
              <Sel label="Loss type" value={f.loss.type ?? ""} onChange={(v) => upd((d) => (d.loss.type = (v || null) as Editable["loss"]["type"]))} options={[["", "—"], ["water", "Water"], ["sewage", "Sewage"], ["fire", "Fire"], ["smoke", "Smoke"], ["mold", "Mold"]]} />
              {water && <Sel label="Water category (as you confirm it)" value={f.loss.category ?? ""} onChange={(v) => upd((d) => (d.loss.category = (v || null) as Editable["loss"]["category"]))} options={[["", "Not confirmed"], ["1", "Category 1"], ["2", "Category 2"], ["3", "Category 3"]]} />}
              {water && <Sel label="Class" value={f.loss.waterClass ?? ""} onChange={(v) => upd((d) => (d.loss.waterClass = (v || null) as Editable["loss"]["waterClass"]))} options={[["", "—"], ["1", "Class 1"], ["2", "Class 2"], ["3", "Class 3"], ["4", "Class 4"]]} />}
              {f.loss.type === "mold" && <Sel label="Mold assessment report" value={f.loss.assessmentReport ?? ""} onChange={(v) => upd((d) => (d.loss.assessmentReport = (v || null) as Editable["loss"]["assessmentReport"]))} options={[["", "—"], ["pending", "Pending (not received yet)"], ["received", "Received"], ["none", "None"]]} />}
              {(f.loss.type === "fire" || f.loss.type === "smoke") && <Sel label="Smoke type" value={f.loss.smokeType ?? ""} onChange={(v) => upd((d) => (d.loss.smokeType = (v || null) as Editable["loss"]["smokeType"]))} options={[["", "—"], ["dry", "Dry smoke"], ["wet", "Wet smoke"], ["protein", "Protein smoke"]]} />}
            </div>
          </div>

          {/* 3. Materials & contents */}
          <h2>3. Affected materials and contents</h2>
          <div className="card stack">
            <strong>Flooring</strong>
            <div className="grid2">
              <Txt label="Flooring type (carpet+pad, LVP, hardwood, tile…)" value={m.flooring.type} onChange={(v) => upd((d) => (d.materials.flooring.type = v))} />
              <Chk label="Flooring affected" checked={m.flooring.affected} onChange={(v) => upd((d) => (d.materials.flooring.affected = v))} />
              <Num label="% of floor affected" value={m.flooring.affectedPct} onChange={(v) => upd((d) => (d.materials.flooring.affectedPct = v))} />
              <Sel label="Flooring action" value={m.flooring.action ?? ""} onChange={(v) => upd((d) => (d.materials.flooring.action = (v || null) as Editable["materials"]["flooring"]["action"]))} options={[["", "—"], ["dry_in_place", "Dry in place"], ["remove", "Remove"], ["replace", "Replace"], ["sand", "Sand (mold: discoloration)"]]} />
              {f.loss.type === "mold" && <Sel label="Subfloor (mold)" value={m.subfloor ?? ""} onChange={(v) => upd((d) => (d.materials.subfloor = (v || null) as Editable["materials"]["subfloor"]))} options={[["", "—"], ["clean", "Clean & treat (stays)"], ["remove", "Remove"]]} />}
              <Txt label="Continuous run (same name in every room it runs through)" value={m.flooring.continuousRun} onChange={(v) => upd((d) => (d.materials.flooring.continuousRun = v))} />
              <Txt label="Natural break (e.g. threshold at hallway)" value={m.flooring.breakNote} onChange={(v) => upd((d) => (d.materials.flooring.breakNote = v))} />
            </div>
            <strong>Walls and baseboard</strong>
            <div className="grid2">
              <Sel label="Wall material" value={m.walls.material ?? ""} onChange={(v) => upd((d) => (d.materials.walls.material = (v || null) as Editable["materials"]["walls"]["material"]))} options={[["", "—"], ["drywall", "Drywall"], ["plaster", "Plaster"], ["paneling", "Paneling"], ["tile", "Tile"], ["other", "Other"]]} />
              <Num label='Wet height / wicking (in)' value={m.walls.wetHeightIn} onChange={(v) => upd((d) => (d.materials.walls.wetHeightIn = v))} />
            </div>
            <Walls label="Affected walls" value={m.walls.affectedWalls} onChange={(v) => upd((d) => (d.materials.walls.affectedWalls = v))} />
            <div className="grid2">
              <Sel
                label="Flood cut"
                value={typeof m.walls.floodCut === "number" ? String(m.walls.floodCut) : m.walls.floodCut}
                onChange={(v) => upd((d) => (d.materials.walls.floodCut = v === "auto" || v === "none" ? v : Number(v)))}
                options={[["auto", "Auto (Cat 2/3 rule)"], ["none", "None (dry in place)"], ["12", '12"'], ["24", '24"'], ["48", '48"'], ["96", '96" (full)']]}
              />
              <Chk label="Insulation behind" checked={m.insulation} onChange={(v) => upd((d) => (d.materials.insulation = v))} />
              <Chk label="Baseboard affected" checked={m.baseboard.affected} onChange={(v) => upd((d) => (d.materials.baseboard.affected = v))} />
              <Sel label="Baseboard action" value={m.baseboard.action ?? ""} onChange={(v) => upd((d) => (d.materials.baseboard.action = (v || null) as Editable["materials"]["baseboard"]["action"]))} options={[["", "By category"], ["detach_reset", "Detach & reset"], ["remove", "Remove"]]} />
            </div>
            {m.baseboard.affected && <Walls label="Baseboard walls (blank = affected walls)" value={m.baseboard.walls} onChange={(v) => upd((d) => (d.materials.baseboard.walls = v))} />}
            <strong>Ceiling, cabinets, fixtures</strong>
            <div className="grid2">
              <Chk label="Ceiling affected" checked={m.ceiling.affected} onChange={(v) => upd((d) => (d.materials.ceiling.affected = v))} />
              <Num label="% of ceiling" value={m.ceiling.affectedPct} onChange={(v) => upd((d) => (d.materials.ceiling.affectedPct = v))} />
              <Sel label="Ceiling action" value={m.ceiling.action ?? ""} onChange={(v) => upd((d) => (d.materials.ceiling.action = (v || null) as Editable["materials"]["ceiling"]["action"]))} options={[["", "—"], ["dry", "Dry in place"], ["seal_paint", "Seal & paint stain"], ["remove", "Remove"]]} />
              <Chk label="Base cabinets affected" checked={m.cabinets.affected} onChange={(v) => upd((d) => (d.materials.cabinets.affected = v))} />
              <Num label="Cabinet length (LF)" value={m.cabinets.lf} onChange={(v) => upd((d) => (d.materials.cabinets.lf = v))} />
              <Chk label="Detach cabinets" checked={m.cabinets.detach} onChange={(v) => upd((d) => (d.materials.cabinets.detach = v))} />
            </div>
            <Txt label="Fixtures on the floor (comma list: toilet, vanity…)" value={m.fixtures.join(", ") || null} onChange={(v) => upd((d) => (d.materials.fixtures = (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)))} />
            <strong>Contents in this room</strong>
            <div className="grid2">
              <Chk label="Contents present" checked={f.contents.present} onChange={(v) => upd((d) => (d.contents.present = v))} />
              <Chk label="Contents affected" checked={f.contents.affected} onChange={(v) => upd((d) => (d.contents.affected = v))} />
              <Txt label="What contents" value={f.contents.items} onChange={(v) => upd((d) => (d.contents.items = v))} />
              <Sel label="Contents handling" value={f.contents.handling} onChange={(v) => upd((d) => (d.contents.handling = v as Editable["contents"]["handling"]))} options={[["none", "None / move only"], ["manipulate", "Move / block"], ["clean_onsite", "Clean on site"], ["packout", "Pack out"]]} />
            </div>
          </div>

          {/* 4. Measurements */}
          <h2>4. Measurements</h2>
          <div className="card stack">
            <div className="grid2">
              <Num label="Length (ft) — N/S walls" value={f.measurements.lengthFt} onChange={(v) => upd((d) => (d.measurements.lengthFt = v))} />
              <Num label="Width (ft) — E/W walls" value={f.measurements.widthFt} onChange={(v) => upd((d) => (d.measurements.widthFt = v))} />
              <Num label="Ceiling height (ft)" value={f.measurements.heightFt} onChange={(v) => upd((d) => (d.measurements.heightFt = v))} />
            </div>
            <strong>Doors and windows</strong>
            {f.measurements.openings.map((o, i) => (
              <div key={o.id} className="grid2" style={{ borderTop: "1px dashed var(--line)", paddingTop: 8 }}>
                <Sel label="Kind" value={o.kind} onChange={(v) => upd((d) => (d.measurements.openings[i].kind = v as typeof o.kind))} options={[["door", "Door"], ["window", "Window"], ["opening", "Opening"]]} />
                <Sel label="Wall" value={o.wall} onChange={(v) => upd((d) => (d.measurements.openings[i].wall = v))} options={WALLS.map((w) => [w, `${w} wall`] as [string, string])} />
                <Num label="Width (in)" value={o.widthIn} onChange={(v) => upd((d) => (d.measurements.openings[i].widthIn = v ?? 1))} />
                <Num label="Height (in)" value={o.heightIn} onChange={(v) => upd((d) => (d.measurements.openings[i].heightIn = v ?? 1))} />
                <Num label="Offset from wall's left end (ft)" value={o.offsetFt} onChange={(v) => upd((d) => (d.measurements.openings[i].offsetFt = v))} />
                <button className="btn sm danger" onClick={() => upd((d) => d.measurements.openings.splice(i, 1))}>
                  Remove
                </button>
              </div>
            ))}
            <div className="row">
              <button className="btn sm" onClick={() => upd((d) => d.measurements.openings.push({ id: rid(), kind: "door", wall: "S", widthIn: 36, heightIn: 80, offsetFt: null }))}>
                + Door
              </button>
              <button className="btn sm" onClick={() => upd((d) => d.measurements.openings.push({ id: rid(), kind: "window", wall: "N", widthIn: 36, heightIn: 48, offsetFt: null }))}>
                + Window
              </button>
            </div>
            {room && (
              <div className="small muted">
                {room.analysis.takeoff.floorCalc} · {room.analysis.takeoff.perimeterCalc} · {room.analysis.takeoff.wallCalc}
              </div>
            )}
          </div>

          {/* 5. Moisture & equipment */}
          <h2>5. Moisture points and equipment placed</h2>
          <div className="card stack">
            {f.moisturePoints.map((p, i) => (
              <div key={p.id} className="grid2" style={{ borderTop: "1px dashed var(--line)", paddingTop: 8 }}>
                <Txt label={`Point ${i + 1} label`} value={p.label} onChange={(v) => upd((d) => (d.moisturePoints[i].label = v ?? ""))} />
                <Sel label="Surface" value={p.surface} onChange={(v) => upd((d) => (d.moisturePoints[i].surface = v as typeof p.surface))} options={[["floor", "Floor"], ["wall", "Wall"], ["ceiling", "Ceiling"]]} />
                <Sel label="Wall" value={p.wall ?? ""} onChange={(v) => upd((d) => (d.moisturePoints[i].wall = v || null))} options={[["", "—"], ...WALLS.map((w) => [w, `${w} wall`] as [string, string])]} />
                <Txt label="Material" value={p.material} onChange={(v) => upd((d) => (d.moisturePoints[i].material = v))} />
                <Txt label="Reading (as read)" value={p.reading} onChange={(v) => upd((d) => (d.moisturePoints[i].reading = v))} />
                <Txt label="Dry goal (from unaffected reference)" value={p.dryGoal} onChange={(v) => upd((d) => (d.moisturePoints[i].dryGoal = v))} />
                <button className="btn sm danger" onClick={() => upd((d) => d.moisturePoints.splice(i, 1))}>
                  Remove point
                </button>
              </div>
            ))}
            <button className="btn sm" onClick={() => upd((d) => d.moisturePoints.push({ id: rid(), label: `MP${d.moisturePoints.length + 1}`, surface: "wall", wall: null, x: null, y: null, material: null, reading: null, dryGoal: null }))}>
              + Moisture point
            </button>
            <strong>Equipment you placed (installed count)</strong>
            <div className="grid2">
              {(["air_mover", "dehumidifier", "air_scrubber"] as const).map((k) => (
                <Num
                  key={k}
                  label={k.replace(/_/g, " ")}
                  value={f.equipmentPlaced.find((e) => e.kind === k)?.qty ?? null}
                  onChange={(v) =>
                    upd((d) => {
                      d.equipmentPlaced = d.equipmentPlaced.filter((e) => e.kind !== k);
                      if (v && v > 0) d.equipmentPlaced.push({ kind: k, qty: Math.round(v) });
                    })
                  }
                />
              ))}
            </div>
          </div>

          <button className="btn primary big" style={{ marginTop: 12 }} disabled={busy === "save"} onClick={save}>
            {busy === "save" ? "Saving…" : dirty ? "6. Save room and analyze" : "6. Re-analyze room"}
          </button>

          {/* 7. Proposed lines */}
          {room && (
            <>
              <h2>7. Proposed line items — {room.label}</h2>
              {room.analysis.notes.map((n, i) => (
                <div key={i} className="card warn small" style={{ marginBottom: 6 }}>
                  {n}
                </div>
              ))}
              {room.analysis.pending.length > 0 && (
                <div className="card warn small" style={{ marginTop: 8 }}>
                  <strong>Pending the mold assessment report — can&apos;t finalize yet:</strong>
                  <ul style={{ paddingLeft: 18, margin: "4px 0 0" }}>
                    {room.analysis.pending.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
              {room.analysis.questions.length > 0 && (
                <div className="card small" style={{ marginBottom: 8 }}>
                  <strong>To complete this room:</strong>
                  <ul style={{ paddingLeft: 18 }}>
                    {room.analysis.questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
              {lines.some((l) => l.status === "suggested") && (
                <button className="btn sm" disabled={!!busy} onClick={() => decide(lines.filter((l) => l.status === "suggested" && (l.kind !== "reconstruction" || recon)).map((l) => l.id), "accept")}>
                  Accept all suggested{recon ? "" : " (mitigation, contents, equipment)"}
                </button>
              )}
              {(["mitigation", "contents", "equipment", "monitoring", "reconstruction"] as const).map((k) => {
                const group = lines.filter((l) => l.kind === k);
                if (!group.length) return null;
                return (
                  <div key={k} style={{ marginTop: 10 }}>
                    <h3>
                      {KIND_LABEL[k]}
                      {k === "reconstruction" && !recon ? " — pending (not estimated)" : ""}
                    </h3>
                    {group.map((l) => (
                      <LineRow key={l.id} line={l} disabled={!!busy || (k === "reconstruction" && !recon)} onDecide={(a) => decide([l.id], a)} onQuantity={(q) => setQty(l.id, q)} />
                    ))}
                  </div>
                );
              })}
              <button
                className="btn sm danger"
                style={{ marginTop: 10 }}
                onClick={async () => {
                  if (!confirm(`Remove the scan for ${room.label}? Accepted lines leave the scope.`)) return;
                  await run("del", () => api<VisitScanView>(`${base}/scans/${sel}`, { method: "DELETE" }));
                  setSel(null);
                  void reload();
                }}
              >
                Remove this room's scan
              </button>
            </>
          )}
        </>
      )}

      {/* Visit-level: exclusions, reconstruction, summary, views, sketch */}
      {view && (
        <>
          <h2>Customer preferences and exclusions</h2>
          <Exclusions ws={ws} list={view.exclusions} busy={!!busy} onSave={(list) => setOptions({ exclusions: list })} />
          <div className="card" style={{ marginTop: 10 }}>
            <label className="row">
              <input type="checkbox" checked={recon} disabled={!!busy} onChange={(e) => setOptions({ reconstructionRequested: e.target.checked })} />
              <span>
                <strong>Reconstruction estimate requested</strong>
                <span className="small muted"> — off by default; when off, reconstruction is listed as pending, not estimated.</span>
              </span>
            </label>
          </div>

          <h2>Summary and checks</h2>
          <div className="card small stack">
            <div>
              <strong>Equipment (calculated, not installed):</strong>{" "}
              {[
                view.summary.airMoversRecommended ? `air movers ${view.summary.airMoversRecommended}` : null,
                view.summary.dehumidifiers ? `dehumidifiers ${view.summary.dehumidifiers.min}–${view.summary.dehumidifiers.max}` : null,
                view.summary.scrubbers ? `HEPA air scrubbers / negative air ${view.summary.scrubbers}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "none yet"}
            </div>
            {view.summary.airMoverCalcs.map((c, i) => (
              <div key={i} className="muted">
                {c}
              </div>
            ))}
            {view.summary.dehumidifiers && <div className="muted">{view.summary.dehumidifiers.calc}</div>}
            <div className={`card small ${view.summary.presend.ok ? "ok" : "warn"}`} style={{ margin: "6px 0" }} aria-label="Pre-send accuracy check">
              <strong>{view.summary.presend.ok ? "✓ Pre-send accuracy check passed" : `Pre-send accuracy check: ${view.summary.presend.failures.length} problem${view.summary.presend.failures.length === 1 ? "" : "s"} — files are marked DRAFT`}</strong>
              {!view.summary.presend.ok && (
                <ul style={{ paddingLeft: 18, margin: "4px 0 0" }}>
                  {view.summary.presend.failures.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
            </div>
            <strong>Before sending</strong>
            {view.summary.qa.map((q, i) => (
              <div key={i} style={{ color: q.ok ? "var(--green)" : "var(--amber)" }}>
                {q.ok ? "✓" : "⚑"} {q.text}
              </div>
            ))}
            {view.yearBuilt == null && <div className="muted">Year built unknown — set it on the property page (lead/asbestos check).</div>}
          </div>

          <h2>Views</h2>
          <div className="row" style={{ marginBottom: 8 }}>
            {(["pm", "estimator", "crew"] as const).map((v) => (
              <button key={v} className={`btn sm ${mode === v ? "on" : ""}`} onClick={() => setMode(v)}>
                {v === "pm" ? "PM" : v === "estimator" ? "Estimator" : "Crew"}
              </button>
            ))}
          </div>
          <ViewTable view={view} mode={mode} />

          <h2>Sketch of affected areas</h2>
          {view.rooms.length ? (
            <div className="card" style={{ background: "#fff", overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: view.sketchSvg }} data-testid="sketch" />
          ) : (
            <p className="muted">Scan a room to draw the sketch.</p>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <a className="btn" href={`${base}/export?format=pdf`}>
              PDF (scope → line items → sketch)
            </a>
            <a className="btn" href={`${base}/export?format=docx`}>
              DOCX
            </a>
          </div>
        </>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { report: "from the report", measured: "from your measurements", rule: "company default", pm: "entered by you" };

function LineRow({ line: l, onDecide, onQuantity, disabled }: { line: ScopeLine; onDecide: (a: "accept" | "reject" | "reset") => void; onQuantity: (q: number | null) => void; disabled: boolean }) {
  const chip = l.status === "accepted" ? "green" : l.status === "rejected" ? "" : l.status === "excluded" ? "red" : "amber";
  const [qty, setQtyText] = useState("");
  return (
    <div className="card" style={{ marginBottom: 6, opacity: l.status === "rejected" || l.status === "excluded" ? 0.6 : 1 }} data-line={l.id}>
      <div className="row">
        <strong className="grow">
          {l.activity} {l.item}
        </strong>
        <span className="mono">{l.quantity == null ? "— " : l.quantity} {l.unit}</span>
        <span className={`chip ${chip}`}>{l.status}</span>
      </div>
      <div className="small muted" style={{ marginTop: 2 }}>
        {l.calc}
        {l.source ? <span className="chip" style={{ marginLeft: 6 }}>{SOURCE_LABEL[l.source]}</span> : l.quantity == null ? <span className="chip amber" style={{ marginLeft: 6 }}>needs a quantity</span> : null}
      </div>
      <div className="small" style={{ marginTop: 2 }}>
        {l.justification}
      </div>
      {l.flags.map((fl, i) => (
        <div key={i} className="small" style={{ color: "var(--amber)" }}>
          ⚑ {fl}
        </div>
      ))}
      {l.status !== "excluded" && (
        <div className="row" style={{ marginTop: 6 }}>
          {l.status !== "accepted" && (
            <button className="btn sm green" disabled={disabled} onClick={() => onDecide("accept")}>
              Accept
            </button>
          )}
          {l.status !== "rejected" && (
            <button className="btn sm" disabled={disabled} onClick={() => onDecide("reject")}>
              Reject
            </button>
          )}
          {l.status !== "suggested" && (
            <button className="btn sm ghost" disabled={disabled} onClick={() => onDecide("reset")}>
              Undo
            </button>
          )}
          {l.activity !== "Choose" && (
            <span className="row" style={{ gap: 4, marginLeft: "auto" }}>
              <input
                className="in"
                style={{ width: 70 }}
                inputMode="decimal"
                placeholder={l.quantity == null ? "qty" : String(l.quantity)}
                value={qty}
                onChange={(e) => setQtyText(e.target.value)}
                aria-label={`Quantity for ${l.activity} ${l.item}`}
              />
              <button
                className="btn sm"
                disabled={disabled || (qty.trim() !== "" && !Number.isFinite(Number(qty)))}
                onClick={() => {
                  onQuantity(qty.trim() === "" ? null : Number(qty));
                  setQtyText("");
                }}
              >
                {qty.trim() === "" && l.source === "pm" ? "Clear" : "Set"}
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ViewTable({ view, mode }: { view: VisitScanView; mode: "pm" | "estimator" | "crew" }) {
  const rows = useMemo(
    () =>
      view.rooms.flatMap((r) =>
        r.data.lines
          .filter((l) => l.status === "accepted" && (l.kind !== "reconstruction" || view.reconstructionRequested))
          .map((l) => ({ room: r.label, l })),
      ),
    [view],
  );
  if (!rows.length) return <p className="small muted">No accepted lines yet.</p>;
  if (mode === "crew")
    return (
      <div className="card small">
        {view.rooms.map((r) => {
          const work = rows.filter((x) => x.room === r.label);
          if (!work.length) return null;
          return (
            <div key={r.locationId} style={{ marginBottom: 8 }}>
              <strong>{r.label}</strong>
              <ul style={{ paddingLeft: 18 }}>
                {work.map(({ l }) => (
                  <li key={l.id}>
                    {l.activity} {l.item}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    );
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <table className="small" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th>Room</th>
            <th>Activity</th>
            <th>Item</th>
            <th>Qty</th>
            <th>Unit</th>
            {mode === "estimator" && <th>Math / justification</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ room, l }) => (
            <tr key={room + l.id} style={{ borderTop: "1px solid var(--line)", verticalAlign: "top" }}>
              <td>{room}</td>
              <td>{l.activity}</td>
              <td>{l.item}</td>
              <td className="mono">{l.quantity ?? "—"}</td>
              <td>{l.unit}</td>
              {mode === "estimator" && (
                <td>
                  {l.calc}
                  <br />
                  <span className="muted">{l.justification}</span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Exclusions({ ws, list, onSave, busy }: { ws: WorkspaceData; list: Exclusion[]; onSave: (l: Partial<Exclusion>[]) => void; busy: boolean }) {
  const [draft, setDraft] = useState<Partial<Exclusion>>({ target: "contents_all", decidedBy: "customer", signature: "not_documented", reason: "" });
  const strip = (e: Exclusion): Partial<Exclusion> => ({ target: e.target, locationId: e.locationId, serviceLine: e.serviceLine, reason: e.reason, decidedBy: e.decidedBy, date: e.date, signature: e.signature, note: e.note });
  return (
    <div className="card stack">
      {list.length === 0 && <div className="small muted">No exclusions. If the customer declines part of the work (e.g. contents), record it here — it will be stated in the scope.</div>}
      {list.map((e, i) => (
        <div key={e.id} className="small" style={{ borderBottom: "1px dashed var(--line)", paddingBottom: 6 }}>
          <div>{e.text}</div>
          <div className="row" style={{ marginTop: 4 }}>
            <select
              className="in"
              style={{ minHeight: 36, width: "auto" }}
              value={e.signature}
              disabled={busy}
              onChange={(ev) => onSave(list.map((x, j) => (j === i ? { ...strip(x), signature: ev.target.value as Exclusion["signature"] } : strip(x))))}
              aria-label="Signature status"
            >
              <option value="not_documented">Signature: not documented</option>
              <option value="verbal">Verbal only</option>
              <option value="signed">Signed declination on file</option>
            </select>
            <button className="btn sm danger" disabled={busy} onClick={() => onSave(list.filter((_, j) => j !== i).map(strip))}>
              Remove exclusion
            </button>
          </div>
        </div>
      ))}
      <div className="grid2">
        <label className="field">
          <span>Exclude</span>
          <select className="in" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value as Exclusion["target"] })} aria-label="Exclusion target">
            {EXCLUSION_TARGETS.map((t) => (
              <option key={t} value={t}>
                {EXCLUSION_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        {draft.target === "room" && (
          <label className="field">
            <span>Room</span>
            <select className="in" value={draft.locationId ?? ""} onChange={(e) => setDraft({ ...draft, locationId: e.target.value || null })}>
              <option value="">Choose…</option>
              {ws.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {locLabel(l)}
                </option>
              ))}
            </select>
          </label>
        )}
        {draft.target === "service_line" && (
          <label className="field">
            <span>Service line</span>
            <select className="in" value={draft.serviceLine ?? ""} onChange={(e) => setDraft({ ...draft, serviceLine: e.target.value || null })}>
              <option value="">Choose…</option>
              <option value="mitigation">Mitigation</option>
              <option value="reconstruction">Reconstruction</option>
              <option value="contents">Contents</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>Decided by</span>
          <select className="in" value={draft.decidedBy} onChange={(e) => setDraft({ ...draft, decidedBy: e.target.value as Exclusion["decidedBy"] })}>
            <option value="customer">Customer</option>
            <option value="adjuster">Adjuster</option>
            <option value="owner">Owner / building</option>
            <option value="pm">PM</option>
          </select>
        </label>
        <label className="field">
          <span>Signature</span>
          <select className="in" value={draft.signature} onChange={(e) => setDraft({ ...draft, signature: e.target.value as Exclusion["signature"] })}>
            <option value="not_documented">Not documented yet</option>
            <option value="verbal">Verbal only</option>
            <option value="signed">Signed declination on file</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Reason</span>
        <input className="in" placeholder="e.g. Customer will handle contents themselves" value={draft.reason ?? ""} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} aria-label="Exclusion reason" />
      </label>
      <button className="btn" disabled={busy || !draft.reason?.trim()} onClick={() => onSave([...list.map(strip), draft])}>
        Add exclusion
      </button>
    </div>
  );
}

// ---------------- small form controls ----------------

function Txt({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="in" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-label={label} />
    </label>
  );
}
function Num({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  const [s, setS] = useState(value == null ? "" : String(value));
  useEffect(() => setS(value == null ? "" : String(value)), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="in"
        inputMode="decimal"
        value={s}
        onChange={(e) => {
          setS(e.target.value);
          if (e.target.value === "" || !Number.isNaN(Number(e.target.value))) onChange(num(e.target.value));
        }}
        aria-label={label}
      />
    </label>
  );
}
function Sel({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select className="in" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}
function Chk({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ minHeight: 46 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} /> {label}
    </label>
  );
}
function Walls({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div>
      <div className="small muted" style={{ fontWeight: 600 }}>
        {label}
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        {WALLS.map((w) => (
          <button key={w} type="button" className={`btn sm ${value.includes(w) ? "on" : ""}`} onClick={() => onChange(value.includes(w) ? value.filter((x) => x !== w) : [...value, w])} aria-pressed={value.includes(w)}>
            {w} wall
          </button>
        ))}
      </div>
    </div>
  );
}
