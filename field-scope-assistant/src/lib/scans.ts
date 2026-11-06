import { query, queryOne } from "./db";
import { newId } from "./ids";
import { assignmentsForProject, getProperty, getRules } from "./intake";
import { fullLabel } from "./locations";
import * as repo from "./repo";
import { airMoverCalc, analyzeRoom, dehuCalc, floorReplaceEffective, type RoomAnalysis } from "./roomRules";
import { emptyScan, Exclusion, RoomScanData, type ScopeLine } from "./scan";
import type { Category, Location, ScopeItem, VisitFacts } from "./schemas";
import { CATEGORIES } from "./schemas";
import { commit, UserError } from "./service";
import { buildSketch, type SketchModel } from "./sketch";
import { nowIso, todayNY } from "./time";
import type { Rules } from "./defaults";
import type { ReportFindings } from "./report/types";
import { crewPlan, equipmentSchedule, type CrewPlan, type EquipmentSchedule } from "./crew";

/**
 * Room-by-room scan service. Saving any room re-analyzes the whole visit
 * (continuous flooring runs cross rooms), keeps the PM's decisions, and syncs
 * accepted lines into the visit's scope as a new saved version.
 */

export interface RoomScanRec {
  id: string;
  locationId: string;
  data: RoomScanData;
  updatedAt: string;
}

async function rows(projectId: string, visitId: string): Promise<RoomScanRec[]> {
  const r = await query<{ id: string; location_id: string; data: string; updated_at: string }>`
    SELECT id, location_id, data, updated_at FROM room_scans WHERE project_id = ${projectId} AND visit_id = ${visitId} ORDER BY created_at`;
  return r.map((x) => {
    let parsed = emptyScan();
    try {
      const p = RoomScanData.safeParse(JSON.parse(x.data));
      if (p.success) parsed = p.data;
    } catch {
      /* keep empty */
    }
    return { id: x.id, locationId: x.location_id, data: parsed, updatedAt: x.updated_at };
  });
}

async function writeScan(projectId: string, visitId: string, locationId: string, data: RoomScanData) {
  const now = nowIso();
  await query`INSERT INTO room_scans (id, project_id, visit_id, location_id, data, created_at, updated_at)
    VALUES (${newId("scn")}, ${projectId}, ${visitId}, ${locationId}, ${JSON.stringify(data)}, ${now}, ${now})
    ON CONFLICT (visit_id, location_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`;
}

async function yearBuiltFor(projectId: string): Promise<number | null> {
  const a = (await assignmentsForProject(projectId))[0];
  if (!a) return null;
  try {
    return (await getProperty(a.propertyId)).yearBuilt;
  } catch {
    return null;
  }
}

export interface VisitScanView {
  rooms: { locationId: string; label: string; floor: string | null; data: RoomScanData; analysis: Omit<RoomAnalysis, "lines">; excluded: boolean }[];
  exclusions: Exclusion[];
  reconstructionRequested: boolean;
  yearBuilt: number | null;
  summary: {
    airMoversRecommended: number;
    airMoverCalcs: string[];
    dehumidifiers: { min: number; max: number; calc: string } | null;
    scrubbers: number;
    affectedFloorSF: number;
    questions: string[];
    notes: string[];
    /** na = nothing to check yet (e.g. no exclusions, no accepted equipment) — shown neutral, never as a pass. */
    qa: { ok: boolean; text: string; na?: boolean }[];
    /** Crew chiefs + subs (proposed from the scope, or confirmed by the PM). */
    crew: CrewPlan;
    /** How long each kind of equipment runs, and the equipment-days. */
    equipmentSchedule: EquipmentSchedule;
    pendingReconstruction: ScopeLine[];
    /** Pre-send accuracy check: fails if any accepted line lacks a quantity, a justification or a source, or a room is on HOLD. */
    presend: { ok: boolean; accepted: number; failures: string[] };
  };
  sketchSvg: string;
}

/** Findings of the mold reports applied to these rooms (documents.findings). */
async function reportsFor(projectId: string, recs: RoomScanRec[]): Promise<Map<string, ReportFindings>> {
  const out = new Map<string, ReportFindings>();
  for (const id of new Set(recs.map((r) => r.data.reportDocumentId).filter((x): x is string => !!x))) {
    try {
      const d = await repo.getDocument(projectId, id);
      if (d.findings) out.set(id, d.findings as ReportFindings);
    } catch {
      /* report deleted — the room keeps its data, the lines lose the report quotes */
    }
  }
  return out;
}

function analyzeAll(recs: RoomScanRec[], locations: Location[], facts: VisitFacts, rules: Rules, yearBuilt: number | null, visitServiceLine: string | null = null, reports: Map<string, ReportFindings> = new Map()) {
  const label = (id: string) => {
    const l = locations.find((x) => x.id === id);
    return l ? fullLabel(l) : "Room";
  };
  const quick = recs.map((r) => ({ r, floorSF: r.data.measurements.lengthFt && r.data.measurements.widthFt ? r.data.measurements.lengthFt * r.data.measurements.widthFt : null }));
  // the crew for per-worker-per-day lines (PPE): PM-confirmed people × work days; PPE counted once, in the first mold room
  const j = facts.jobInfo;
  const people = j.crewChiefs != null && j.subcontractors != null ? j.crewChiefs + j.subcontractors : null;
  const pd = Number(String(j.productionDays ?? "").match(/\d+(\.\d+)?/)?.[0] ?? NaN);
  const moldRec = recs.find((r) => r.data.loss.type === "mold" || (r.data.loss.type == null && visitServiceLine === "mold"));
  const crew = {
    people,
    label: people != null ? `CC${j.crewChiefs! > 1 ? ` ×${j.crewChiefs}` : ""}+${j.subcontractors}` : null,
    days: Number.isFinite(pd) && pd > 0 ? pd : rules.crew.targetDays.mold,
    daysBasis: Number.isFinite(pd) && pd > 0 ? "production days on the job info" : "company target days for mold remediation — edit Production days if different",
    ppeRoom: moldRec ? label(moldRec.locationId) : null,
  };
  return recs.map((rec) => {
    const runLabel = rec.data.materials.flooring.continuousRun?.trim().toLowerCase();
    const run = runLabel
      ? quick
          .filter((q) => q.r.data.materials.flooring.continuousRun?.trim().toLowerCase() === runLabel)
          .map((q) => ({
            roomLabel: label(q.r.locationId),
            floorSF: q.floorSF,
            replace: floorReplaceEffective(q.r.data, rules, visitServiceLine),
          }))
      : [];
    const analysis = analyzeRoom(rec.data, {
      rules,
      roomLabel: label(rec.locationId),
      run,
      exclusions: facts.exclusions,
      locationId: rec.locationId,
      reconstructionRequested: facts.reconstructionRequested,
      yearBuilt,
      visitServiceLine,
      report: rec.data.reportDocumentId ? (reports.get(rec.data.reportDocumentId) ?? null) : null,
      crew,
    });
    return { rec, analysis };
  });
}

const CATEGORY_SET = new Set<string>(CATEGORIES);
const fmtQty = (l: ScopeLine) => (l.quantity == null ? "quantity to measure" : `${l.quantity} ${l.unit}`);

/** Accepted lines become scope bullets (id "ln_…"); pending reconstruction becomes notes ("lnp_…"). */
function syncedFacts(facts: VisitFacts, analyzed: ReturnType<typeof analyzeAll>): VisitFacts {
  const items: ScopeItem[] = facts.items.filter((i) => !/^ln[pqh]?_/.test(i.id));
  for (const { rec, analysis } of analyzed) {
    // what can't be finalized yet (e.g. pending the mold assessment report) prints in the scope
    analysis.pending.forEach((p, i) => items.push(scopeItem(`lnq_${rec.locationId}_${i}`, rec.locationId, "note", p.startsWith("HOLD") ? `${p}.` : `Pending the mold assessment report: ${p}.`, "proposed")));
    // hazard check prints before the demolition lines (category "condition" sorts first in the room)
    const demo = analysis.lines.filter((l) => l.status === "accepted" && /^(Remove|Flood cut|Tear out)/i.test(l.activity) && l.flags.some((f) => HAZARD_FLAG.test(f)));
    if (demo.length) {
      const hz = [...new Set(demo.flatMap((l) => l.flags.filter((f) => HAZARD_FLAG.test(f))))];
      items.push(scopeItem(`lnh_${rec.locationId}`, rec.locationId, "condition", `⚠ Before demolition: ${hz.join(" ")}`, "proposed"));
    }
    for (const l of analysis.lines) {
      const pendingRecon = l.kind === "reconstruction" && !facts.reconstructionRequested;
      if (l.status === "excluded" || l.status === "rejected") continue;
      if (pendingRecon) {
        items.push(scopeItem(`lnp_${rec.locationId}_${l.id}`, rec.locationId, "note", `Pending reconstruction (separate assignment, not estimated): ${l.activity.toLowerCase()} ${l.item}.`, "proposed"));
        continue;
      }
      if (l.status !== "accepted") continue;
      const cat = (CATEGORY_SET.has(l.scopeCategory) ? l.scopeCategory : "note") as Category;
      items.push(scopeItem(`ln_${rec.locationId}_${l.id}`, rec.locationId, cat, `${l.activity} ${l.item} — ${fmtQty(l)}`, "proposed", l.flags.filter((f) => !f.startsWith("Pending reconstruction"))));
    }
  }
  return { ...facts, items };
}

const HAZARD_FLAG = /lead-safe|Year built unknown|asbestos/i;

function scopeItem(id: string, locationId: string, category: Category, text: string, status: ScopeItem["status"], flags: string[] = []): ScopeItem {
  return { id, locationId, needsLocation: false, category, text, status, source: "manual_edit", evidenceIds: [], carriedForward: false, carriedFromVisitId: null, quantity: null, flags };
}

async function persistAndSync(projectId: string, visitId: string, change: string) {
  const [recs, locations, visit, rules, yearBuilt] = await Promise.all([
    rows(projectId, visitId),
    repo.listLocations(projectId),
    repo.getVisit(projectId, visitId),
    getRules(),
    yearBuiltFor(projectId),
  ]);
  const analyzed = analyzeAll(recs, locations, visit.facts, rules, yearBuilt, visit.serviceLine, await reportsFor(projectId, recs));
  for (const { rec, analysis } of analyzed) await writeScan(projectId, visitId, rec.locationId, { ...rec.data, lines: analysis.lines });
  const facts = syncedFacts(visit.facts, analyzed);
  const before = JSON.stringify(visit.facts.items.filter((i) => i.id.startsWith("ln")).map((i) => i.text));
  const after = JSON.stringify(facts.items.filter((i) => i.id.startsWith("ln")).map((i) => i.text));
  if (before !== after || change.startsWith("Exclusion") || change.startsWith("Reconstruction"))
    await commit(projectId, visitId, facts, { trigger: "manual_edit", input: null, changes: [change] }, visit.manualText);
}

export async function getVisitScans(projectId: string, visitId: string): Promise<VisitScanView> {
  const [recs, locations, visit, rules, yearBuilt] = await Promise.all([
    rows(projectId, visitId),
    repo.listLocations(projectId),
    repo.getVisit(projectId, visitId),
    getRules(),
    yearBuiltFor(projectId),
  ]);
  const reports = await reportsFor(projectId, recs);
  const analyzed = analyzeAll(recs, locations, visit.facts, rules, yearBuilt, visit.serviceLine, reports);
  const roomsOut = new Set(visit.facts.exclusions.filter((e) => e.target === "room").map((e) => e.locationId));
  const loc = (id: string) => locations.find((l) => l.id === id);

  let am = 0;
  const amCalcs: string[] = [];
  let affected = 0;
  let scrubbers = 0;
  const questions: string[] = [];
  const notes: string[] = [];
  const pending: ScopeLine[] = [];
  for (const { rec, analysis } of analyzed) {
    if (roomsOut.has(rec.locationId)) continue;
    if (analysis.airMovers) {
      am += analysis.airMovers.recommended;
      amCalcs.push(`${fullLabel(loc(rec.locationId) ?? { floor: null, unit: null, room: "Room" })}: ${analysis.airMovers.calc}`);
    }
    affected += analysis.dryingSF ?? 0; // dehumidifier sizing counts wet (water) rooms only — never mold/fire rooms
    scrubbers += analysis.lines.filter((l) => (l.id === "equip.scrubber" || l.id === "mold.negair") && l.status !== "rejected" && l.status !== "excluded").reduce((a, l) => a + (l.quantity ?? 0), 0);
    questions.push(...analysis.questions);
    notes.push(...analysis.notes);
    if (!visit.facts.reconstructionRequested) pending.push(...analysis.lines.filter((l) => l.kind === "reconstruction" && l.status !== "rejected" && l.status !== "excluded"));
  }
  const allLines = analyzed.flatMap((a) => a.analysis.lines);
  const roomLabelOf = (id: string) => {
    const l = loc(id);
    return l ? fullLabel(l) : "Room";
  };
  const acceptedLines = analyzed.flatMap((a) => (roomsOut.has(a.rec.locationId) ? [] : a.analysis.lines.filter((l) => l.status === "accepted").map((l) => ({ l, room: roomLabelOf(a.rec.locationId) }))));
  const failures: string[] = [];
  // every check passes only on real evidence: nothing accepted is not "ready to send"
  if (!acceptedLines.length) failures.push("No accepted lines yet — accept the lines that go in the scope.");
  for (const { l, room } of acceptedLines) {
    const what = `${room}: ${l.activity} ${l.item}`;
    if (l.quantity == null) failures.push(`${what} — no quantity${l.unit.includes("DA") ? " (days not set)" : ""}`);
    if (!l.justification.trim()) failures.push(`${what} — no justification`);
    if (l.quantity != null && !l.source) failures.push(`${what} — no source for the quantity`);
  }
  // equipment must say how long it runs; the crew must be set (proposed from the scope or entered)
  for (const { l, room } of acceptedLines)
    if (l.kind === "equipment" && (!l.duration || l.duration.hours == null)) failures.push(`${room}: ${l.activity} ${l.item} — no run time (hours / days)`);
  const activeRooms = analyzed.filter((a) => !roomsOut.has(a.rec.locationId)).map((a) => ({ label: roomLabelOf(a.rec.locationId), data: a.rec.data, analysis: a.analysis }));
  const crew = crewPlan(activeRooms, { rules, serviceLine: visit.serviceLine, reconstructionRequested: visit.facts.reconstructionRequested, jobInfo: visit.facts.jobInfo });
  if (analyzed.length && !crew.confirmed && !crew.proposed) failures.push(`Crew: ${crew.note}`);
  const waterDays = activeRooms.flatMap((r) => r.analysis.lines.filter((l) => l.id === "equip.airmovers" && l.status !== "rejected" && l.status !== "excluded" && l.duration?.days != null).map((l) => l.duration!.days!));
  const offH = [...reports.values()].map((f) => f.equipmentOff?.value.hours).find((h) => h != null) ?? null;
  const schedule = equipmentSchedule(activeRooms, {
    waterDehu: affected > 0 ? dehuCalc(affected, rules) : null,
    offBeforeClearanceHours: activeRooms.some((r) => r.data.loss.type === "mold" || r.data.reportDocumentId) ? offH : null,
    waterDryingDays: waterDays.length ? Math.max(...waterDays) : (rules.equipmentDuration.waterDryingDaysClassUnknown ?? null),
  });
  for (const a of analyzed) if (a.analysis.pending.some((x) => x.startsWith("HOLD")) && !roomsOut.has(a.rec.locationId)) failures.push(`${roomLabelOf(a.rec.locationId)}: HOLD — moisture source not confirmed fixed`);
  const presend = { ok: failures.length === 0, accepted: acceptedLines.length, failures };
  const decided = allLines.filter((l) => l.status === "accepted" || l.status === "rejected").length;
  // the room's effective loss type: what the PM set, else what the visit's kind of work implies
  const sl = visit.serviceLine;
  const isMold = (d: RoomScanData) => d.loss.type === "mold" || (d.loss.type == null && sl === "mold");
  const isWater = (d: RoomScanData) => d.loss.type === "water" || d.loss.type === "sewage" || (d.loss.type == null && (d.source.waterSource != null || sl === "mitigation" || sl === "ems"));
  const live = analyzed.filter((a) => !roomsOut.has(a.rec.locationId));
  const waterRooms = live.filter((a) => isWater(a.rec.data));
  const moldRooms = live.filter((a) => isMold(a.rec.data));
  const accEquip = acceptedLines.filter(({ l }) => l.kind === "equipment");
  const accRemovals = allLines.filter((l) => l.status === "accepted" && /^(Remove|Flood cut)/.test(l.activity));
  const accQty = acceptedLines.filter(({ l }) => l.quantity != null);
  const na = (text: string) => ({ ok: false, na: true, text });
  const qa: { ok: boolean; text: string; na?: boolean }[] = [
    { ok: analyzed.length > 0, text: "At least one room scanned" },
    { ok: analyzed.every((a) => a.rec.data.source.where !== "unknown"), text: "Every room has a source or migration path" },
    { ok: analyzed.every((a) => a.analysis.takeoff.floorSF != null), text: "Every room is measured" },
    { ok: live.every((a) => a.rec.data.loss.type != null), text: "Loss type set in every room" },
    ...(waterRooms.length ? [{ ok: waterRooms.every((a) => a.rec.data.loss.category != null), text: "Water category confirmed in every water room" }] : []),
    accRemovals.length ? { ok: accRemovals.every((l) => !!l.justification), text: "Every accepted removal has a justification" } : na("Every accepted removal has a justification — no accepted removals to check yet"),
    { ok: allLines.length > 0 && decided === allLines.filter((l) => l.status !== "excluded").length, text: "Every suggested line accepted or rejected" },
    { ok: acceptedLines.length > 0, text: acceptedLines.length ? `${acceptedLines.length} line${acceptedLines.length === 1 ? "" : "s"} accepted` : "At least one line accepted" },
    { ok: acceptedLines.length > 0 && acceptedLines.every(({ l }) => l.quantity != null), text: "Accuracy: every accepted line has a quantity" },
    { ok: acceptedLines.length > 0 && acceptedLines.every(({ l }) => !!l.justification.trim()), text: "Accuracy: every accepted line has a justification" },
    accQty.length ? { ok: accQty.every(({ l }) => !!l.source), text: "Accuracy: every accepted quantity has a source (report quote, measurement, company rule or PM entry)" } : na("Accuracy: every accepted quantity has a source — no accepted lines to check yet"),
    accEquip.length ? { ok: accEquip.every(({ l }) => l.duration?.hours != null), text: "Accuracy: every accepted equipment line states how long it runs" } : na("Accuracy: every accepted equipment line states how long it runs — no accepted equipment lines to check yet"),
    { ok: !!crew.confirmed, text: crew.confirmed ? `Crew confirmed: ${crew.confirmed.label}` : "Crew (crew chiefs + subs) confirmed by the PM" },
    { ok: !schedule.estimated, text: "Equipment run times confirmed (none still estimated)" },
    visit.facts.exclusions.length ? { ok: visit.facts.exclusions.every((e) => e.signature === "signed"), text: "Exclusions have a signed customer declination" } : na("Exclusions have a signed customer declination — no exclusions recorded, nothing to check"),
    ...(waterRooms.length ? [{ ok: waterRooms.every((a) => a.rec.data.moisturePoints.length > 0), text: "Moisture points mapped in water rooms" }] : []),
    // mold: "stopped" is not "fixed" — only a source marked repaired counts
    ...(moldRooms.length ? [{ ok: moldRooms.every((a) => a.rec.data.source.status === "repaired"), text: "Mold: moisture source confirmed repaired (remediation can't be finalized otherwise; “stopped” is not enough)" }] : []),
  ];

  return {
    rooms: analyzed.map(({ rec, analysis }) => {
      const l = loc(rec.locationId);
      const { lines: _lines, ...rest } = analysis;
      void _lines;
      return { locationId: rec.locationId, label: l ? fullLabel(l) : "Room", floor: l?.floor ?? null, data: { ...rec.data, lines: analysis.lines }, analysis: rest, excluded: roomsOut.has(rec.locationId) };
    }),
    exclusions: visit.facts.exclusions,
    reconstructionRequested: visit.facts.reconstructionRequested,
    yearBuilt,
    summary: {
      airMoversRecommended: am,
      airMoverCalcs: amCalcs,
      dehumidifiers: affected > 0 ? dehuCalc(affected, rules) : null,
      scrubbers,
      affectedFloorSF: Math.round(affected * 10) / 10,
      questions,
      notes,
      qa,
      crew,
      equipmentSchedule: schedule,
      pendingReconstruction: pending,
      presend,
    },
    sketchSvg: (await import("./sketch")).toSvg(sketchFor(analyzed, locations, roomsOut)),
  };
}

function sketchFor(analyzed: ReturnType<typeof analyzeAll>, locations: Location[], roomsOut: Set<string | null>): SketchModel {
  return buildSketch(
    analyzed.map(({ rec, analysis }) => {
      const l = locations.find((x) => x.id === rec.locationId);
      return {
        locationId: rec.locationId,
        label: l ? (l.unit ? `Unit ${l.unit} — ${l.room}` : l.room) : "Room",
        floor: l?.floor ?? null,
        scan: rec.data,
        lines: analysis.lines,
        excluded: roomsOut.has(rec.locationId),
      };
    }),
  );
}

/** Sketch + estimator rows for exports. */
export async function exportAppendix(projectId: string, visitId: string) {
  const view = await getVisitScans(projectId, visitId);
  if (!view.rooms.length) return null;
  const [recs, locations, visit, rules, yearBuilt] = await Promise.all([
    rows(projectId, visitId),
    repo.listLocations(projectId),
    repo.getVisit(projectId, visitId),
    getRules(),
    yearBuiltFor(projectId),
  ]);
  const analyzed = analyzeAll(recs, locations, visit.facts, rules, yearBuilt, visit.serviceLine, await reportsFor(projectId, recs));
  const roomsOut = new Set(visit.facts.exclusions.filter((e) => e.target === "room").map((e) => e.locationId));
  const rowsOut: { room: string; activity: string; item: string; quantity: string; unit: string; rate: string; total: string; notes: string }[] = [];
  for (const { rec, analysis } of analyzed) {
    const l = locations.find((x) => x.id === rec.locationId);
    for (const line of analysis.lines) {
      if (line.status !== "accepted") continue;
      if (line.kind === "reconstruction" && !visit.facts.reconstructionRequested) continue;
      rowsOut.push({
        room: l ? fullLabel(l) : "Room",
        activity: line.activity,
        item: line.item,
        quantity: line.quantity == null ? "—" : String(line.quantity),
        unit: line.unit,
        rate: rules.lineFormat.showRates && line.rate != null ? String(line.rate) : "",
        total: rules.lineFormat.showRates && line.total != null ? String(line.total) : "",
        notes: `${line.justification} [${line.calc}]${line.duration ? ` Runs ${line.duration.hours ?? "?"} h (${line.duration.days ?? "?"} days) = ${line.duration.equipmentDays ?? "?"} equipment-days — ${line.duration.basis}${line.duration.estimated ? " (estimated)" : ""}.` : ""}${line.flags.length ? ` ⚑ ${line.flags.join(" ")}` : ""}`,
      });
    }
  }
  return { rows: rowsOut, sketch: sketchFor(analyzed, locations, roomsOut), summary: view.summary, columns: rules.lineFormat.columns };
}

// ---------------- mutations ----------------

/** Editable parts of a room scan. Lines and decisions are owned by the server. */
const EditableScan = RoomScanData.omit({ lines: true, decisions: true });

export async function saveRoomScan(projectId: string, visitId: string, locationId: string, input: unknown) {
  await repo.getVisit(projectId, visitId);
  if (!(await repo.listLocations(projectId)).some((l) => l.id === locationId)) throw new repo.NotFound("Room not found.");
  const parsed = EditableScan.safeParse(input);
  if (!parsed.success) throw new UserError(`Check the room details: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 3).join("; ")}`);
  const existing = (await rows(projectId, visitId)).find((r) => r.locationId === locationId);
  await writeScan(projectId, visitId, locationId, { ...parsed.data, lines: existing?.data.lines ?? [], decisions: existing?.data.decisions ?? {} });
  await persistAndSync(projectId, visitId, "Room scan updated.");
  return getVisitScans(projectId, visitId);
}

export async function decideLines(projectId: string, visitId: string, locationId: string, lineIds: string[], action: "accept" | "reject" | "reset") {
  const rec = (await rows(projectId, visitId)).find((r) => r.locationId === locationId);
  if (!rec) throw new repo.NotFound("Room scan not found.");
  const decisions = { ...rec.data.decisions };
  const lineNotes = { ...rec.data.lineNotes };
  let skipped: string[] = [];
  if (action === "accept") {
    // a line with no quantity can't be accepted — enter the quantity (or answer its question) first
    const current = (await getVisitScans(projectId, visitId)).rooms.find((r) => r.locationId === locationId)?.data.lines ?? [];
    const noQty = new Set(current.filter((l) => l.quantity == null).map((l) => l.id));
    skipped = lineIds.filter((id) => noQty.has(id));
    if (skipped.length && skipped.length === lineIds.length) {
      const names = current.filter((l) => skipped.includes(l.id)).map((l) => `${l.activity} ${l.item}`);
      throw new UserError(`Enter a quantity before accepting: ${names.join("; ")}.`);
    }
    lineIds = lineIds.filter((id) => !noQty.has(id));
  }
  for (const id of lineIds) {
    if (action === "reset") delete decisions[id];
    else decisions[id] = action === "accept" ? "accepted" : "rejected";
    if (action !== "reset") delete lineNotes[id]; // the PM has now decided on the changed line
  }
  await writeScan(projectId, visitId, locationId, { ...rec.data, decisions, lineNotes });
  await persistAndSync(projectId, visitId, `${action === "accept" ? "Accepted" : action === "reject" ? "Rejected" : "Reset"} ${lineIds.length} line(s).${skipped.length ? ` ${skipped.length} left suggested — no quantity yet.` : ""}`);
  return getVisitScans(projectId, visitId);
}

export async function deleteRoomScan(projectId: string, visitId: string, locationId: string) {
  await query`DELETE FROM room_scans WHERE project_id = ${projectId} AND visit_id = ${visitId} AND location_id = ${locationId}`;
  await persistAndSync(projectId, visitId, "Room scan removed.");
  return getVisitScans(projectId, visitId);
}

export async function setScanOptions(
  projectId: string,
  visitId: string,
  opts: { exclusions?: unknown[]; reconstructionRequested?: boolean; crew?: { crewChiefs: number | null; subcontractors: number | null; trades?: string[] } | null },
) {
  const visit = await repo.getVisit(projectId, visitId);
  const rules = await getRules();
  const locations = await repo.listLocations(projectId);
  const facts: VisitFacts = structuredClone(visit.facts);
  const changes: string[] = [];
  if (opts.exclusions) {
    const list: Exclusion[] = [];
    for (const raw of opts.exclusions) {
      const p = Exclusion.safeParse({ id: newId("exc"), date: todayNY(), signature: "not_documented", ...(raw as object) });
      if (!p.success) throw new UserError(`Exclusion: ${p.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      const e = p.data;
      if (e.target === "room" && (!e.locationId || !locations.some((l) => l.id === e.locationId))) throw new UserError("Choose the room to exclude.");
      if (!e.reason.trim()) throw new UserError("Give a reason for the exclusion.");
      e.text = exclusionText(e, rules, locations);
      list.push(e);
    }
    facts.exclusions = list;
    changes.push(`Exclusions updated (${list.length}).`);
  }
  if (opts.reconstructionRequested !== undefined) {
    facts.reconstructionRequested = !!opts.reconstructionRequested;
    changes.push(`Reconstruction estimate ${facts.reconstructionRequested ? "requested" : "not requested"}.`);
  }
  if (opts.crew !== undefined) {
    const c = opts.crew;
    const ok = (n: number | null) => n == null || (Number.isInteger(n) && n >= 0 && n <= 99);
    if (c && (!ok(c.crewChiefs) || !ok(c.subcontractors))) throw new UserError("Crew chiefs and subs are whole numbers (0–99).");
    if (c && c.crewChiefs != null && c.crewChiefs < 1) throw new UserError("At least one crew chief.");
    const allowed = rules.crew.trades;
    const trades = (c?.trades ?? []).filter((t) => allowed.includes(t));
    facts.jobInfo = {
      ...facts.jobInfo,
      crewChiefs: c?.crewChiefs ?? null,
      subcontractors: c?.subcontractors ?? null,
      subTrades: trades,
      crewRaw: c && c.crewChiefs != null && c.subcontractors != null ? `CC${c.crewChiefs > 1 ? ` ×${c.crewChiefs}` : ""}+${c.subcontractors}` : null,
    };
    changes.push(c && c.crewChiefs != null ? `Crew set: ${facts.jobInfo.crewRaw}${trades.length ? ` (${trades.join(", ")})` : ""}.` : "Crew cleared (back to the proposal).");
  }
  await commit(projectId, visitId, facts, { trigger: "manual_edit", input: null, changes }, visit.manualText);
  await persistAndSync(projectId, visitId, changes.join(" ").startsWith("Exclusions") ? "Exclusions applied." : changes.join(" ").startsWith("Crew") ? "Crew applied." : "Reconstruction setting applied.");
  return getVisitScans(projectId, visitId);
}

function exclusionText(e: Exclusion, rules: Rules, locations: Location[]): string {
  const who = e.decidedBy === "customer" ? "the customer" : e.decidedBy;
  if (e.target === "contents_all" || e.target === "contents_cleaning" || e.target === "contents_packout" || (e.target === "service_line" && e.serviceLine === "contents")) {
    const base = rules.exclusions.contentsDeclinedText.replace("{date}", e.date).replace("{decidedBy}", who);
    if (e.target === "contents_cleaning") return base.replace("Contents cleaning and pack-out", "Contents cleaning");
    if (e.target === "contents_packout") return base.replace("Contents cleaning and pack-out", "Contents pack-out");
    return `${base} Reason: ${e.reason}.`;
  }
  if (e.target === "room") {
    const l = locations.find((x) => x.id === e.locationId);
    return `${l ? fullLabel(l) : "Room"} excluded from this scope (${e.date}, decided by ${who}). Reason: ${e.reason}.`;
  }
  return `${(e.serviceLine ?? "Service line").replace(/^\w/, (c) => c.toUpperCase())} excluded from this scope (${e.date}, decided by ${who}). Reason: ${e.reason}.`;
}

/**
 * Runs the rules on the whole visit as it would be with `overrides` (rooms changed or added by a
 * report), without saving anything. New rooms use `new:<name>` as their id. Returns lines per room.
 */
export async function previewVisit(projectId: string, visitId: string, overrides: { locationId: string | null; roomName: string; data: RoomScanData }[], yearBuilt: number | null) {
  const [recs, locations, visit, rules] = await Promise.all([rows(projectId, visitId), repo.listLocations(projectId), repo.getVisit(projectId, visitId), getRules()]);
  const locs: Location[] = locations.map((l) => {
    const o = overrides.find((x) => x.locationId === l.id);
    return o ? { ...l, room: o.roomName } : l;
  });
  const all: RoomScanRec[] = recs.map((r) => {
    const o = overrides.find((x) => x.locationId === r.locationId);
    return o ? { ...r, data: o.data } : r;
  });
  const unit = locations.find((l) => l.unit)?.unit ?? null;
  for (const o of overrides.filter((x) => !x.locationId || !recs.some((r) => r.locationId === x.locationId))) {
    const id = o.locationId ?? `new:${o.roomName}`;
    if (!locs.some((l) => l.id === id)) locs.push({ id, floor: null, unit, room: o.roomName } as Location);
    all.push({ id: `scn_${id}`, locationId: id, data: o.data, updatedAt: "" });
  }
  const analyzed = analyzeAll(all, locs, visit.facts, rules, yearBuilt, visit.serviceLine, await reportsFor(projectId, all));
  return analyzed.map(({ rec, analysis }) => ({ locationId: rec.locationId, label: fullLabel(locs.find((l) => l.id === rec.locationId)!), lines: analysis.lines, pending: analysis.pending }));
}

/** The PM types a quantity on a line (null clears it); it shows as "entered by the PM". */
export async function setLineQuantity(projectId: string, visitId: string, locationId: string, lineId: string, quantity: number | null) {
  const rec = (await rows(projectId, visitId)).find((r) => r.locationId === locationId);
  if (!rec) throw new repo.NotFound("Room scan not found.");
  if (quantity != null && (!Number.isFinite(quantity) || quantity < 0)) throw new UserError("Enter a quantity of 0 or more.");
  const quantityOverrides = { ...rec.data.quantityOverrides };
  if (quantity == null) delete quantityOverrides[lineId];
  else quantityOverrides[lineId] = Math.round(quantity * 100) / 100;
  await writeScan(projectId, visitId, locationId, { ...rec.data, quantityOverrides });
  await persistAndSync(projectId, visitId, `Quantity entered on ${lineId}.`);
  return getVisitScans(projectId, visitId);
}

/** The PM's run time for one equipment line (hours); null clears it back to the report / default. */
export async function setLineDuration(projectId: string, visitId: string, locationId: string, lineId: string, hours: number | null) {
  const rec = (await rows(projectId, visitId)).find((r) => r.locationId === locationId);
  if (!rec) throw new repo.NotFound("Room scan not found.");
  if (hours != null && (!Number.isFinite(hours) || hours <= 0)) throw new UserError("Enter a run time above 0 hours.");
  const durationOverrides = { ...rec.data.durationOverrides };
  if (hours == null) delete durationOverrides[lineId];
  else durationOverrides[lineId] = Math.round(hours * 100) / 100;
  await writeScan(projectId, visitId, locationId, { ...rec.data, durationOverrides });
  await persistAndSync(projectId, visitId, `Run time entered on ${lineId}.`);
  return getVisitScans(projectId, visitId);
}

/**
 * One tap: accept every suggested line that is ready — it has a quantity, a justification and a
 * source. Lines that still need a quantity (or a PM choice) stay suggested. Reconstruction only
 * when a reconstruction estimate is requested. Optionally limited to some rooms.
 */
export async function acceptReadyLines(projectId: string, visitId: string, locationIds?: string[]) {
  const view = await getVisitScans(projectId, visitId);
  let accepted = 0;
  let notReady = 0;
  for (const r of view.rooms) {
    if (r.excluded || (locationIds && !locationIds.includes(r.locationId))) continue;
    const sug = r.data.lines.filter((l) => l.status === "suggested" && (l.kind !== "reconstruction" || view.reconstructionRequested));
    const ready = sug.filter((l) => l.quantity != null && !!l.justification.trim() && !!l.source && l.activity !== "Choose");
    notReady += sug.length - ready.length;
    if (ready.length) {
      await decideLines(projectId, visitId, r.locationId, ready.map((l) => l.id), "accept");
      accepted += ready.length;
    }
  }
  return { accepted, notReady, view: await getVisitScans(projectId, visitId) };
}

/** Writes PM-review state on one room (decisions reset, line notes, change summary) and re-syncs. */
export async function setLineReview(projectId: string, visitId: string, locationId: string, review: { reset: string[]; notes: Record<string, string>; changes: string[] }) {
  const rec = (await rows(projectId, visitId)).find((r) => r.locationId === locationId);
  if (!rec) return;
  const decisions = { ...rec.data.decisions };
  for (const id of review.reset) delete decisions[id];
  await writeScan(projectId, visitId, locationId, { ...rec.data, decisions, lineNotes: { ...rec.data.lineNotes, ...review.notes }, reportChanges: review.changes });
  await persistAndSync(projectId, visitId, "Mold report changes marked for review.");
}

/** Runs the room rules on a scan without saving it (report preview). */
export async function previewRoom(projectId: string, visitId: string, locationId: string, data: RoomScanData, roomName: string | null, yearBuilt: number | null, report: ReportFindings | null) {
  const [locations, visit, rules] = await Promise.all([repo.listLocations(projectId), repo.getVisit(projectId, visitId), getRules()]);
  const l = locations.find((x) => x.id === locationId);
  const label = l ? fullLabel({ ...l, room: roomName ?? l.room }) : roomName ?? "Room";
  return analyzeRoom(data, {
    rules,
    roomLabel: label,
    run: [],
    exclusions: visit.facts.exclusions,
    locationId,
    reconstructionRequested: visit.facts.reconstructionRequested,
    yearBuilt,
    visitServiceLine: visit.serviceLine,
    report,
  });
}

export { airMoverCalc };
export const _test = { analyzeAll, syncedFacts };
export async function scanCount(projectId: string, visitId: string) {
  const r = await queryOne<{ n: string }>`SELECT COUNT(*) AS n FROM room_scans WHERE project_id = ${projectId} AND visit_id = ${visitId}`;
  return Number(r?.n ?? 0);
}
