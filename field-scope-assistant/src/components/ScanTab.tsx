"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReportPanel from "./ReportPanel";
import { api } from "./api";
import { locLabel } from "./labels";
import type { WorkspaceData } from "./types";
import { CASEWORK_ACTION_LABELS, CASEWORK_ACTIONS, CASEWORK_KINDS, CASEWORK_LABELS, COUNTERTOP_MATERIALS, EXCLUSION_LABELS, EXCLUSION_TARGETS, WATER_SOURCES, type CaseworkItem, type CaseworkKind, type Exclusion, type RoomScanData, type ScopeLine } from "@/lib/scan";
import { DEFAULT_RULES, type Rules } from "@/lib/defaults";
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
    casework: [],
    caseworkContents: null,
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
  durationOverrides: {},
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
  const [autosave, setAutosave] = useState<"" | "saving" | "saved">("");
  const verRef = useRef(0);
  const latestRef = useRef<{ sel: string | null; form: Editable; dirty: boolean }>({ sel: null, form: blank(), dirty: false });
  const base = `/api/projects/${projectId}/visits/${visitId}`;
  useEffect(() => {
    latestRef.current = { sel, form, dirty };
  }, [sel, form, dirty]);
  const flush = useCallback(() => {
    const L = latestRef.current;
    if (!L.dirty || !L.sel || !visitId) return;
    latestRef.current = { ...L, dirty: false };
    void fetch(`${base}/scans/${L.sel}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: L.form }), keepalive: true }).catch(() => {});
  }, [base, visitId]);
  useEffect(() => {
    const onHide = () => flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      flush(); // the tab is closing (e.g. Settings / Scope): keep the edits
    };
  }, [flush]);

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
    // leaving this room (or the tab) with unsaved edits: save them, never drop them
    return () => flush();
    // only when switching rooms
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);
  // the scan changed on the server (e.g. a mold report was applied) — pick it up unless there are unsaved edits
  const serverData = room?.data;
  useEffect(() => {
    if (!serverData || dirty) return;
    const { lines: _l, decisions: _d, ...rest } = serverData;
    void _l;
    void _d;
    setForm(rest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverData]);


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
    verRef.current++;
    setDirty(true);
  };
  // Autosave: edits are saved 1.5 s after the last change, and flushed when the room, tab or page changes.
  useEffect(() => {
    if (!dirty || !sel || !visitId) return;
    const t = setTimeout(() => {
      const v0 = verRef.current;
      setAutosave("saving");
      api<VisitScanView>(`${base}/scans/${sel}`, { method: "PUT", body: { data: form } })
        .then((v) => {
          setView(v);
          if (verRef.current === v0) setDirty(false);
          setAutosave("saved");
          void reload();
        })
        .catch((e) => {
          setAutosave("");
          setErr(`Not saved yet: ${(e as Error).message}`);
        });
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, dirty, sel, visitId, base]);
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
  const setDuration = (lineId: string, hours: number | null) =>
    run("dur", async () => {
      const v = await api<VisitScanView>(`${base}/scans/${sel}/duration`, { body: { lineId, hours } });
      void reload();
      return v;
    });
  const setOptions = (body: { exclusions?: Partial<Exclusion>[]; reconstructionRequested?: boolean; crew?: { crewChiefs: number | null; subcontractors: number | null; trades?: string[] } | null }) =>
    run("opts", async () => {
      const v = await api<VisitScanView>(`${base}/scan-options`, { method: "PUT", body });
      void reload();
      return v;
    });

  if (!visitId) return <div className="card">Start a visit on the Scope tab first, then scan its rooms here.</div>;
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
      {view && view.rooms.length > 0 && <CrewAndEquipment view={view} busy={!!busy} onCrew={(crew) => setOptions({ crew })} />}
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
              <Num label={f.loss.type === "mold" ? "Growth height on the wall (in) — sets the drywall cut" : "Wet height / wicking (in) — sets the flood cut"} value={m.walls.wetHeightIn} onChange={(v) => upd((d) => (d.materials.walls.wetHeightIn = v))} />
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
            <strong>Ceiling and fixtures</strong>
            <div className="grid2">
              <Chk label="Ceiling affected" checked={m.ceiling.affected} onChange={(v) => upd((d) => (d.materials.ceiling.affected = v))} />
              <Num label="% of ceiling" value={m.ceiling.affectedPct} onChange={(v) => upd((d) => (d.materials.ceiling.affectedPct = v))} />
              <Sel label="Ceiling action" value={m.ceiling.action ?? ""} onChange={(v) => upd((d) => (d.materials.ceiling.action = (v || null) as Editable["materials"]["ceiling"]["action"]))} options={[["", "—"], ["dry", "Dry in place"], ["seal_paint", "Seal & paint stain"], ["remove", "Remove"]]} />
            </div>
            <Txt label="Fixtures on the floor (comma list: toilet, vanity…)" value={m.fixtures.join(", ") || null} onChange={(v) => upd((d) => (d.materials.fixtures = (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)))} />
            <Casework
              roomName={room?.label ?? ""}
              items={m.casework}
              contents={m.caseworkContents}
              onItems={(items) => upd((d) => (d.materials.casework = items))}
              onContents={(v) => upd((d) => (d.materials.caseworkContents = v))}
            />
            {!m.casework.length && m.cabinets.affected && (
              <div className="grid2">
                <span className="small muted" style={{ gridColumn: "1 / -1" }}>
                  Older entry (base cabinets only) — add the cabinets above instead to get the full set of lines.
                </span>
                <Chk label="Base cabinets affected" checked={m.cabinets.affected} onChange={(v) => upd((d) => (d.materials.cabinets.affected = v))} />
                <Num label="Cabinet length (LF)" value={m.cabinets.lf} onChange={(v) => upd((d) => (d.materials.cabinets.lf = v))} />
                <Chk label="Detach cabinets" checked={m.cabinets.detach} onChange={(v) => upd((d) => (d.materials.cabinets.detach = v))} />
              </div>
            )}
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
          <div className="small muted" aria-live="polite" data-testid="autosave">
            {dirty ? "Unsaved changes — saving automatically…" : autosave === "saving" ? "Saving…" : autosave === "saved" ? "✓ Changes saved automatically" : "Changes save automatically."}
          </div>

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
                <button className="btn sm" disabled={!!busy} onClick={() => decide(lines.filter((l) => l.status === "suggested" && l.quantity != null && (l.kind !== "reconstruction" || recon)).map((l) => l.id), "accept")}>
                  Accept all suggested with a quantity{recon ? "" : " (mitigation, contents, equipment)"}
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
                      <LineRow key={l.id} line={l} disabled={!!busy || (k === "reconstruction" && !recon)} onDecide={(a) => decide([l.id], a)} onQuantity={(q) => setQty(l.id, q)} onDuration={(h) => setDuration(l.id, h)} />
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

function LineRow({ line: l, onDecide, onQuantity, onDuration, disabled }: { line: ScopeLine; onDecide: (a: "accept" | "reject" | "reset") => void; onQuantity: (q: number | null) => void; onDuration: (h: number | null) => void; disabled: boolean }) {
  const chip = l.status === "accepted" ? "green" : l.status === "rejected" ? "" : l.status === "excluded" ? "red" : "amber";
  const [qty, setQtyText] = useState("");
  const [hrs, setHrs] = useState("");
  const d = l.duration;
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
      {d && (
        <div className="small" style={{ marginTop: 2 }} data-duration={l.id}>
          <strong>Runs:</strong> {d.hours != null ? `${d.hours} h (${d.days} day${d.days === 1 ? "" : "s"})` : "run time not set"}
          {d.equipmentDays != null && ` · ${l.quantity} × ${d.days} days = ${d.equipmentDays} equipment-days`}{" "}
          <span className={`chip ${d.hours == null ? "red" : d.estimated ? "amber" : "green"}`}>{d.hours == null ? "missing" : d.source === "report" ? (d.estimated ? "report-based, estimated" : "report") : d.source === "pm" ? "PM" : "estimated"}</span>
          <div className="muted">{d.basis}</div>
          {d.startStop && <div className="muted">{d.startStop}</div>}
        </div>
      )}
      {l.flags.map((fl, i) => (
        <div key={i} className="small" style={{ color: "var(--amber)" }}>
          ⚑ {fl}
        </div>
      ))}
      {d && l.status !== "excluded" && (
        <div className="row" style={{ marginTop: 6, gap: 4 }}>
          <input className="in" style={{ width: 90 }} inputMode="decimal" placeholder={d.hours != null ? `${d.hours} h` : "hours"} value={hrs} onChange={(e) => setHrs(e.target.value)} aria-label={`Run time hours for ${l.activity} ${l.item}`} />
          <button
            className="btn sm"
            disabled={disabled || (hrs.trim() !== "" && !(Number(hrs) > 0))}
            onClick={() => {
              onDuration(hrs.trim() === "" ? null : Number(hrs));
              setHrs("");
            }}
          >
            {hrs.trim() === "" && d.source === "pm" ? "Clear run time" : "Set run time (h)"}
          </button>
        </div>
      )}
      {l.status !== "excluded" && (
        <div className="row" style={{ marginTop: 6 }}>
          {l.status !== "accepted" && (
            <button className="btn sm green" disabled={disabled || l.quantity == null} title={l.quantity == null ? "Enter a quantity first" : undefined} onClick={() => onDecide("accept")}>
              {l.quantity == null ? "Accept (needs a quantity)" : "Accept"}
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
                  {l.duration && (
                    <>
                      <br />
                      Runs {l.duration.hours ?? "?"} h ({l.duration.days ?? "?"} days) = {l.duration.equipmentDays ?? "?"} equipment-days — {l.duration.basis}
                      {l.duration.estimated ? " (estimated)" : ""}
                    </>
                  )}
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
function Num({ label, value, onChange, placeholder }: { label: string; value: number | null; onChange: (v: number | null) => void; placeholder?: string }) {
  const [s, setS] = useState(value == null ? "" : String(value));
  useEffect(() => setS(value == null ? "" : String(value)), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="in"
        inputMode="decimal"
        placeholder={placeholder}
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

const CW_PRESETS: { name: string; test: RegExp; kinds: CaseworkKind[] }[] = [
  { name: "Kitchen set", test: /kitchen|kitchenette|pantry/i, kinds: ["lower", "sink_base", "upper", "countertop", "toe_kick", "backsplash"] },
  { name: "Vanity set", test: /bath|powder|lav|wash|half/i, kinds: ["vanity", "vanity_top", "backsplash"] },
];
const TOPS: CaseworkKind[] = ["countertop", "vanity_top", "backsplash"];
const EACH: CaseworkKind[] = ["doors_drawers", "hardware"];
const newItem = (kind: CaseworkKind): CaseworkItem => ({ kind, affected: true, action: null, extent: null, section: null, wall: null, lf: null, depthIn: null, count: null, material: null });

/** Cabinets, countertops, vanity, backsplash — quick picks; blank measurements stay blank (the lines say what's missing). */
function Casework({ roomName, items, contents, onItems, onContents }: { roomName: string; items: CaseworkItem[]; contents: CaseworkContents; onItems: (v: CaseworkItem[]) => void; onContents: (v: CaseworkContents) => void }) {
  const [cw, setCw] = useState<Rules["casework"]>(DEFAULT_RULES.casework);
  useEffect(() => {
    api<{ rules: Rules }>("/api/rules")
      .then((s) => s.rules?.casework && setCw(s.rules.casework))
      .catch(() => {});
  }, []);
  const presets = [...CW_PRESETS].sort((a, b) => Number(b.test.test(roomName)) - Number(a.test.test(roomName)));
  const add = (kinds: CaseworkKind[]) => onItems([...items, ...kinds.filter((k) => !items.some((i) => i.kind === k) || kinds.length === 1).map(newItem)]);
  const edit = (i: number, patch: Partial<CaseworkItem>) => onItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const baseLF = items.filter((i) => i.affected && ["lower", "sink_base", "island", "vanity"].includes(i.kind)).reduce((a, i) => (a == null || i.lf == null ? null : a + i.lf), 0 as number | null);
  return (
    <section aria-label="Cabinets and countertops" style={{ marginTop: 8 }}>
      <strong>Cabinets &amp; countertops</strong>
      <div className="row" style={{ marginTop: 4, flexWrap: "wrap", gap: 6 }}>
        {presets.map((p) => (
          <button key={p.name} type="button" className="btn sm" onClick={() => add(p.kinds)}>
            + {p.name}
          </button>
        ))}
      </div>
      <div className="row" style={{ marginTop: 6, flexWrap: "wrap", gap: 6 }} aria-label="Add one item">
        {CASEWORK_KINDS.map((k) => (
          <button key={k} type="button" className={`btn sm ${items.some((i) => i.kind === k) ? "on" : ""}`} onClick={() => add([k])}>
            + {CASEWORK_LABELS[k]}
          </button>
        ))}
      </div>
      {items.map((it, i) => {
        const top = TOPS.includes(it.kind);
        const each = EACH.includes(it.kind);
        const defDepth = it.kind === "countertop" ? cw.countertopDepthIn : it.kind === "vanity_top" ? cw.vanityTopDepthIn : null;
        const lfHint = it.kind === "toe_kick" && cw.toeKickEqualsBaseLF ? `= base cabinet LF${baseLF ? ` (${baseLF})` : ""}` : it.kind === "interior" ? "= affected cabinet LF" : (it.kind === "countertop" || it.kind === "vanity_top") && cw.countertopGoesWithBase && baseLF ? `base LF is ${baseLF}` : "measure (LF)";
        return (
          <div key={i} className="card" style={{ marginTop: 8, padding: 10 }} aria-label={CASEWORK_LABELS[it.kind]}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong className="small">{CASEWORK_LABELS[it.kind]}</strong>
              <button type="button" className="btn sm" onClick={() => onItems(items.filter((_, j) => j !== i))} aria-label={`Remove ${CASEWORK_LABELS[it.kind]}`}>
                Remove
              </button>
            </div>
            <div className="grid2">
              <Chk label="Affected" checked={it.affected} onChange={(v) => edit(i, { affected: v })} />
              <Sel label="Action" value={it.action ?? ""} onChange={(v) => edit(i, { action: (v || null) as CaseworkItem["action"] })} options={[["", "— not decided (inspect / ask)"], ...CASEWORK_ACTIONS.map((a) => [a, CASEWORK_ACTION_LABELS[a]] as [string, string])]} />
              {!each && <Num label="Length (LF)" value={it.lf} placeholder={lfHint} onChange={(v) => edit(i, { lf: v })} />}
              {top && <Num label={it.kind === "backsplash" ? "Height (in)" : "Depth (in)"} value={it.depthIn} placeholder={defDepth != null ? `${defDepth} (company default)` : "measure — no default height"} onChange={(v) => edit(i, { depthIn: v })} />}
              {each && <Num label="How many (EA)" value={it.count} placeholder="count them" onChange={(v) => edit(i, { count: v })} />}
              {top && <Sel label="Material" value={it.material ?? ""} onChange={(v) => edit(i, { material: v || null })} options={[["", "— pick (not guessed)"], ...COUNTERTOP_MATERIALS.map((x) => [x, x[0].toUpperCase() + x.slice(1)] as [string, string])]} />}
              <Sel label="Extent" value={it.extent ?? ""} onChange={(v) => edit(i, { extent: (v || null) as CaseworkItem["extent"] })} options={[["", "—"], ["full", "Full run"], ["partial", "Partial (which section)"]]} />
              {it.extent === "partial" && <Txt label="Which section" value={it.section} onChange={(v) => edit(i, { section: v })} />}
              <Sel label="Wall" value={it.wall ?? ""} onChange={(v) => edit(i, { wall: v || null })} options={[["", "—"], ...WALLS.map((w) => [w, `${w} wall`] as [string, string])]} />
            </div>
          </div>
        );
      })}
      {items.length > 0 && (
        <Sel
          label="Cabinet contents"
          value={contents ?? ""}
          onChange={(v) => onContents((v || null) as CaseworkContents)}
          options={[["", "— ask"], ["none", "Empty / none"], ["manipulate", "Move / block"], ["clean_onsite", "Clean on site"], ["packout", "Pack out"]]}
        />
      )}
    </section>
  );
}
type CaseworkContents = RoomScanData["materials"]["caseworkContents"];

/** Crew (CC + subs) and the equipment schedule — at the top, visible without opening a room. */
function CrewAndEquipment({ view, busy, onCrew }: { view: VisitScanView; busy: boolean; onCrew: (c: { crewChiefs: number | null; subcontractors: number | null; trades?: string[] } | null) => void }) {
  const c = view.summary.crew;
  const s = view.summary.equipmentSchedule;
  const cur = c.confirmed ?? (c.proposed ? { ...c.proposed, trades: c.trades.map((t) => t.trade) } : null);
  const [cc, setCc] = useState<number | null>(cur?.crewChiefs ?? null);
  const [subs, setSubs] = useState<number | null>(cur?.subs ?? null);
  const [trades, setTrades] = useState<string[]>(c.confirmed?.trades ?? c.trades.map((t) => t.trade));
  useEffect(() => {
    setCc(cur?.crewChiefs ?? null);
    setSubs(cur?.subs ?? null);
    setTrades(c.confirmed?.trades ?? c.trades.map((t) => t.trade));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.confirmed?.label, c.proposed?.label, c.confirmed?.trades.join(","), c.trades.map((t) => t.trade).join(",")]);
  return (
    <section className="card small stack" aria-label="Crew and equipment" style={{ marginBottom: 10 }}>
      <strong style={{ fontSize: 15 }}>Crew</strong>
      <div data-testid="crew-line">
        {c.confirmed ? (
          <>
            <strong>{c.confirmed.label}</strong> — {c.confirmed.crewChiefs} crew chief{c.confirmed.crewChiefs === 1 ? "" : "s"} + {c.confirmed.subs} sub{c.confirmed.subs === 1 ? "" : "s"}
            {c.confirmed.trades.length ? ` (${c.confirmed.trades.join(", ")})` : ""} = {c.confirmed.total} <span className="chip green">PM confirmed</span>
          </>
        ) : c.proposed ? (
          <>
            <strong>{c.proposed.label}</strong> — {c.proposed.crewChiefs} crew chief{c.proposed.crewChiefs === 1 ? "" : "s"} + {c.proposed.subs} sub{c.proposed.subs === 1 ? "" : "s"} = {c.proposed.total} <span className="chip amber">proposed — confirm</span>
          </>
        ) : (
          <span style={{ color: "var(--amber)" }}>⚑ {c.note}</span>
        )}
      </div>
      {c.trades.length > 0 && <div className="muted">Sub trades the scope indicates: {c.trades.map((t) => `${t.trade} (${t.why})`).join("; ")}</div>}
      {c.phases.map((p) => (
        <details key={p.phase}>
          <summary>
            {p.phase}: {p.total != null ? `${p.crewChiefs} CC + ${p.subs} subs over ${p.targetDays} day${p.targetDays === 1 ? "" : "s"}` : "not calculated"} — show the math
          </summary>
          <ul style={{ paddingLeft: 18, margin: "4px 0" }}>
            {[...p.math, ...p.missing.map((x) => `⚑ ${x}`)].map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </details>
      ))}
      {c.proposed && !c.confirmed && (
        <button className="btn sm green" disabled={busy} onClick={() => onCrew({ crewChiefs: c.proposed!.crewChiefs, subcontractors: c.proposed!.subs, trades: c.trades.map((t) => t.trade) })}>
          Accept {c.proposed.label}
        </button>
      )}
      <div className="grid2">
        <Num label="Crew chiefs" value={cc} onChange={setCc} />
        <Num label="Subs" value={subs} onChange={setSubs} />
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }} aria-label="Sub trades">
        {c.tradeOptions.map((t) => (
          <button key={t} type="button" className={`btn sm ${trades.includes(t) ? "on" : ""}`} aria-pressed={trades.includes(t)} onClick={() => setTrades(trades.includes(t) ? trades.filter((x) => x !== t) : [...trades, t])}>
            {t}
          </button>
        ))}
      </div>
      <div className="row">
        {(() => {
          const base = c.confirmed ?? (c.proposed ? { crewChiefs: c.proposed.crewChiefs, subs: c.proposed.subs, trades: c.trades.map((t) => t.trade) } : null);
          const edited = !base || cc !== base.crewChiefs || subs !== base.subs || [...trades].sort().join(",") !== [...base.trades].sort().join(",");
          return edited ? (
            <button className="btn sm" disabled={busy || cc == null || cc < 1 || subs == null || subs < 0} onClick={() => onCrew({ crewChiefs: cc, subcontractors: subs, trades })}>
              Save edited crew{cc != null && subs != null ? ` (CC${cc > 1 ? ` ×${cc}` : ""}+${subs})` : ""}
            </button>
          ) : null;
        })()}
        {c.confirmed && (
          <button className="btn sm ghost" disabled={busy} onClick={() => onCrew(null)}>
            Back to the proposal
          </button>
        )}
      </div>

      <strong style={{ fontSize: 15, marginTop: 6 }}>Equipment schedule</strong>
      {s.rows.length ? (
        <div style={{ overflowX: "auto" }}>
          <table className="small" style={{ width: "100%", borderCollapse: "collapse" }} aria-label="Equipment schedule">
            <thead>
              <tr>
                <th>Equipment</th>
                <th>Count</th>
                <th>Hours / unit</th>
                <th>Days</th>
                <th>Equip-days</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => (
                <tr key={r.type} style={{ borderTop: "1px solid var(--line)", verticalAlign: "top" }}>
                  <td>
                    {r.type} {r.missing ? <span className="chip red">duration missing</span> : r.estimated ? <span className="chip amber">estimated</span> : <span className="chip green">stated</span>}
                  </td>
                  <td>{r.count ?? "?"}</td>
                  <td>{r.hoursPerUnit.length ? r.hoursPerUnit.join(" / ") : "—"}</td>
                  <td>{r.days.length ? r.days.join(" / ") : "—"}</td>
                  <td>{r.equipmentDays ?? "?"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted">No equipment in the scope yet.</div>
      )}
      {s.spanText && <div data-testid="equipment-span">{s.spanText}.</div>}
      {s.totalEquipmentDays != null && <div>Total: {s.totalEquipmentDays} equipment-days.</div>}
      {s.rows.map((r) => (
        <details key={r.type}>
          <summary>{r.type} — where the run time comes from</summary>
          <ul style={{ paddingLeft: 18, margin: "4px 0" }}>
            {[...r.basis, ...r.startStop].map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}
