import { query, queryOne } from "./db";
import { newId } from "./ids";
import { assignmentsForProject, getProperty, getRules } from "./intake";
import { fullLabel } from "./locations";
import * as repo from "./repo";
import { airMoverCalc, analyzeRoom, dehuCalc, type RoomAnalysis } from "./roomRules";
import { emptyScan, Exclusion, RoomScanData, type ScopeLine } from "./scan";
import type { Category, Location, ScopeItem, VisitFacts } from "./schemas";
import { CATEGORIES } from "./schemas";
import { commit, UserError } from "./service";
import { buildSketch, type SketchModel } from "./sketch";
import { nowIso, todayNY } from "./time";
import type { Rules } from "./defaults";
import type { ReportFindings } from "./report/types";

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
    qa: { ok: boolean; text: string }[];
    pendingReconstruction: ScopeLine[];
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
  return recs.map((rec) => {
    const runLabel = rec.data.materials.flooring.continuousRun?.trim().toLowerCase();
    const run = runLabel
      ? quick
          .filter((q) => q.r.data.materials.flooring.continuousRun?.trim().toLowerCase() === runLabel)
          .map((q) => ({
            roomLabel: label(q.r.locationId),
            floorSF: q.floorSF,
            replace: q.r.data.materials.flooring.action === "replace" || (/carpet|pad/i.test(q.r.data.materials.flooring.type ?? "") && q.r.data.loss.category === "3"),
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
    });
    return { rec, analysis };
  });
}

const CATEGORY_SET = new Set<string>(CATEGORIES);
const fmtQty = (l: ScopeLine) => (l.quantity == null ? "quantity to measure" : `${l.quantity} ${l.unit}`);

/** Accepted lines become scope bullets (id "ln_…"); pending reconstruction becomes notes ("lnp_…"). */
function syncedFacts(facts: VisitFacts, analyzed: ReturnType<typeof analyzeAll>): VisitFacts {
  const items: ScopeItem[] = facts.items.filter((i) => !i.id.startsWith("ln_") && !i.id.startsWith("lnp_") && !i.id.startsWith("lnq_"));
  for (const { rec, analysis } of analyzed) {
    // what can't be finalized yet (e.g. pending the mold assessment report) prints in the scope
    analysis.pending.forEach((p, i) => items.push(scopeItem(`lnq_${rec.locationId}_${i}`, rec.locationId, "note", `Pending the mold assessment report: ${p}.`, "proposed")));
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
  const analyzed = analyzeAll(recs, locations, visit.facts, rules, yearBuilt, visit.serviceLine, await reportsFor(projectId, recs));
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
  const decided = allLines.filter((l) => l.status === "accepted" || l.status === "rejected").length;
  const qa = [
    { ok: analyzed.length > 0, text: "At least one room scanned" },
    { ok: analyzed.every((a) => a.rec.data.source.where !== "unknown"), text: "Every room has a source or migration path" },
    { ok: analyzed.every((a) => a.analysis.takeoff.floorSF != null), text: "Every room is measured" },
    { ok: analyzed.every((a) => a.rec.data.loss.type !== "water" || a.rec.data.loss.category != null), text: "Water category confirmed in every water room" },
    { ok: allLines.filter((l) => l.status === "accepted" && /^(Remove|Flood cut)/.test(l.activity)).every((l) => !!l.justification), text: "Every accepted removal has a justification" },
    { ok: allLines.length === 0 || decided === allLines.filter((l) => l.status !== "excluded").length, text: "Every suggested line accepted or rejected" },
    { ok: visit.facts.exclusions.every((e) => e.signature === "signed"), text: "Exclusions have a signed customer declination" },
    { ok: analyzed.every((a) => a.rec.data.moisturePoints.length > 0 || a.rec.data.loss.type !== "water"), text: "Moisture points mapped in water rooms" },
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
      pendingReconstruction: pending,
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
        notes: `${line.justification} [${line.calc}]${line.flags.length ? ` ⚑ ${line.flags.join(" ")}` : ""}`,
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
  for (const id of lineIds) {
    if (action === "reset") delete decisions[id];
    else decisions[id] = action === "accept" ? "accepted" : "rejected";
  }
  await writeScan(projectId, visitId, locationId, { ...rec.data, decisions });
  await persistAndSync(projectId, visitId, `${action === "accept" ? "Accepted" : action === "reject" ? "Rejected" : "Reset"} ${lineIds.length} line(s).`);
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
  opts: { exclusions?: unknown[]; reconstructionRequested?: boolean },
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
  await commit(projectId, visitId, facts, { trigger: "manual_edit", input: null, changes }, visit.manualText);
  await persistAndSync(projectId, visitId, changes.join(" ").startsWith("Exclusions") ? "Exclusions applied." : "Reconstruction setting applied.");
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
