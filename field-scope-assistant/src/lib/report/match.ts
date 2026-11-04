import type { RoomScanData } from "../scan";
import type { Finding, ReportFindings, RoomFinding } from "./types";

/**
 * Report → scope. From the findings, propose changes to the visit's room scans — one plan per
 * room the report describes (multi-room reports and continuous flooring runs create or update
 * every connected room). Every change carries its quote. A change that would replace something
 * the PM entered is a conflict: shown as a mismatch and OFF by default — never silently
 * overwritten. A change that replaces a value an earlier report set is re-flagged (and ON).
 * Applying re-runs the room rules; lines come back "suggested" for the PM to accept or reject.
 */

export interface ReportChange {
  /** `${room}::${key}` — what the apply step receives. */
  id: string;
  /** Report room this change is for ("" when the report names no room). */
  room: string;
  key: string;
  label: string;
  current: string | null;
  proposed: string;
  quote: string;
  page: number;
  /** Would replace something the PM entered with a different value. */
  conflict: boolean;
  /** The value an earlier report set, when this report changes it. */
  previousReport: string | null;
}

export interface VisitRoom {
  locationId: string | null;
  label: string;
  roomName: string;
  scan: RoomScanData;
}
/** Kept for single-room callers. */
export interface RoomTarget {
  roomLabel: string;
  roomName: string;
  scan: RoomScanData;
  yearBuilt: number | null;
}

export interface RoomPlan {
  /** Report room name ("" = the report names no room). */
  name: string;
  report: Finding<RoomFinding> | null;
  /** Existing room this updates; null = a new room is added on apply. */
  target: VisitRoom | null;
  /** The first room with growth: holds the shared containment and the report-wide items. */
  primary: boolean;
  /** In the continuous flooring run without growth of its own. */
  runOnly: boolean;
}

const TBD = /room TBD/i;
const sameName = (a: string, b: string) => !!a && !!b && a.toLowerCase().includes(b.toLowerCase());
const fmtDims = (l: number | null, w: number | null, h: number | null) => `${l ?? "—"} × ${w ?? "—"} ft${h ? `, ${h} ft ceiling` : ""}`;
const fmtPct = (p: number) => `${Math.round(p * 10) / 10}%${p >= 100 ? " (whole floor)" : ""}`;
const RUN_LABEL = "Report run";

function emptyRoomFinding(name: string): RoomFinding {
  return { name, growth: false, lengthFt: null, widthFt: null, heightFt: null, areaSF: null, coverage: null, vague: null, quotes: { dims: null, area: null, coverage: null } };
}

/** Which visit room each report room goes to (existing by name, the "room TBD" room, the only room, or new). */
export function planRooms(f: ReportFindings, rooms: VisitRoom[]): RoomPlan[] {
  const list: { name: string; report: Finding<RoomFinding> | null; runOnly: boolean }[] = f.rooms.map((r) => ({ name: r.value.name, report: r, runOnly: !r.value.growth }));
  const run = f.flooringContinuous?.value.continues ? f.flooringContinuous.value.rooms : [];
  for (const n of run) if (!list.some((x) => x.name.toLowerCase() === n.toLowerCase())) list.push({ name: n, report: null, runOnly: true });
  if (!list.length) list.push({ name: "", report: null, runOnly: false });
  const used = new Set<VisitRoom>();
  const plans: RoomPlan[] = list.map((x) => {
    const t = x.name ? rooms.find((r) => !used.has(r) && sameName(r.roomName, x.name)) : undefined;
    if (t) used.add(t);
    return { name: x.name, report: x.report, target: t ?? null, primary: false, runOnly: x.runOnly };
  });
  for (const p of plans) {
    if (p.target) continue;
    const free = rooms.filter((r) => !used.has(r));
    const t = free.find((r) => TBD.test(r.roomName)) ?? (plans.length === 1 && free.length === 1 ? free[0] : !p.name && free.length === 1 ? free[0] : undefined);
    if (t) {
      p.target = t;
      used.add(t);
    }
  }
  const prim = plans.find((p) => !p.runOnly) ?? plans[0];
  prim.primary = true;
  return plans;
}

interface Draft {
  key: string;
  label: string;
  current: string | null;
  proposed: string;
  src: Finding<unknown>;
  manual: boolean; // the current value is something the PM has (not empty)
}

/** Changes and mismatch warnings for every planned room. */
export function proposeVisit(f: ReportFindings, rooms: VisitRoom[], yearBuilt: number | null): { plans: RoomPlan[]; changes: ReportChange[]; mismatches: string[]; replaced: string[] } {
  const plans = planRooms(f, rooms);
  const changes: ReportChange[] = [];
  const mismatches: string[] = [];
  const replaced: string[] = [];
  const multi = plans.length > 1;
  const runGroup = plans.filter((p) => !!f.flooringContinuous?.value.continues && (f.flooringContinuous.value.rooms.some((n) => n.toLowerCase() === p.name.toLowerCase()) || p.primary));
  const existingRun = runGroup.map((p) => p.target?.scan.materials.flooring.continuousRun).find(Boolean) ?? RUN_LABEL;

  for (const p of plans) {
    const s = p.target?.scan ?? null;
    const prev = s?.reportValues ?? {};
    const r = p.report?.value ?? emptyRoomFinding(p.name);
    const where = p.target?.label ?? p.name;
    const drafts: Draft[] = [];
    const d = (key: string, label: string, current: string | null, proposed: string, src: Finding<unknown> | null) => {
      if (!src || current === proposed) return;
      drafts.push({ key, label, current, proposed, src, manual: current != null });
    };
    const anchor = (q: string | null) => (q ? { value: null, quote: q, page: p.report?.page ?? 1 } : p.report);

    if (!p.target) d("room.new", "Add room", null, p.name || "Affected area (room TBD)", p.report ?? f.flooringContinuous ?? f.rooms[0] ?? null);
    else if (p.name && !sameName(p.target.roomName, p.name)) {
      const tbd = TBD.test(p.target.roomName) || !p.target.roomName.trim();
      d("room.name", "Room name", tbd ? null : p.target.roomName, p.name, p.report);
      if (!tbd) mismatches.push(`Different room: the report is for the ${p.name}; this scan is "${p.target.roomName}".`);
    }
    // measurements
    if (r.lengthFt != null && r.widthFt != null) {
      const me = s?.measurements;
      const has = !!me && (me.lengthFt != null || me.widthFt != null);
      const sameLW = !!me && ((me.lengthFt === r.lengthFt && me.widthFt === r.widthFt) || (me.lengthFt === r.widthFt && me.widthFt === r.lengthFt));
      const h = r.heightFt ?? me?.heightFt ?? null;
      const cur = me && (has || me.heightFt) ? fmtDims(me.lengthFt, me.widthFt, me.heightFt) : null;
      if (!sameLW || (r.heightFt != null && me?.heightFt !== r.heightFt)) {
        d("measurements", "Room measurements", cur, fmtDims(r.lengthFt, r.widthFt, h), anchor(r.quotes.dims));
        if (has && !sameLW && prev.measurements !== cur) mismatches.push(`${multi ? `${where}: ` : ""}Different area: you entered ${fmtDims(me!.lengthFt, me!.widthFt, null).replace(" ft", "")} ft; the report says ${r.lengthFt} × ${r.widthFt} ft.`);
      }
    }
    // extent
    const L = r.lengthFt ?? s?.measurements.lengthFt ?? null;
    const W = r.widthFt ?? s?.measurements.widthFt ?? null;
    let pct: number | null = r.coverage?.whole ? 100 : (r.coverage?.pct ?? null);
    if (pct == null && r.areaSF != null && L && W) pct = Math.min(100, Math.round((r.areaSF / (L * W)) * 1000) / 10);
    const curPct = s?.materials.flooring.affectedPct;
    if (pct != null) {
      d("floor.pct", "Part of the floor with growth", curPct != null ? fmtPct(curPct) : null, fmtPct(pct), anchor(r.quotes.coverage ?? r.quotes.area));
      if (curPct != null && curPct !== pct && prev["floor.pct"] !== fmtPct(curPct))
        mismatches.push(`${multi ? `${where}: ` : ""}Different extent: you entered ${curPct}% of the floor; the report says ${pct >= 100 ? "the whole floor" : `${pct}%`}.`);
    }
    if (r.growth && !s?.materials.flooring.affected && (r.coverage || r.areaSF != null || r.vague || !multi)) d("floor.affected", "Flooring with growth", s ? "No" : null, "Yes", p.report ?? f.floorCoverage ?? f.affectedAreaSF);
    if (r.areaSF != null) {
      const sL = s?.measurements.lengthFt;
      const sW = s?.measurements.widthFt;
      const sPct = curPct ?? (s?.materials.flooring.affected ? 100 : null);
      const fromReport = !!s && prev.measurements === fmtDims(s.measurements.lengthFt, s.measurements.widthFt, s.measurements.heightFt);
      if (sL && sW && sPct != null && !fromReport) {
        const mine = Math.round(sL * sW * (sPct / 100) * 10) / 10;
        if (Math.abs(mine - r.areaSF) > Math.max(2, mine * 0.1))
          mismatches.push(`${multi ? `${where}: ` : ""}Different area: the report states ${r.areaSF} SF; your scope has ${mine} SF (${sL} × ${sW} ft × ${sPct}%).`);
      }
      if (L && W && pct != null) {
        const calc = Math.round(L * W * (pct / 100) * 10) / 10;
        if (Math.abs(calc - r.areaSF) > Math.max(2, calc * 0.1)) mismatches.push(`${multi ? `${where}: ` : ""}Affected area: the report states ${r.areaSF} SF but ${L} × ${W} ft × ${pct}% = ${calc} SF — confirm which is right.`);
      }
    }
    // flooring material and continuous run
    if ((r.growth || p.runOnly) && f.flooringType && !s?.materials.flooring.type) d("flooring.type", "Flooring", null, f.flooringType.value, f.flooringType);
    if (runGroup.includes(p) && runGroup.length > 1) d("floor.run", "Continuous flooring run", s?.materials.flooring.continuousRun ?? null, existingRun, f.flooringContinuous);
    if (p.primary && f.flooringContinuous && !f.flooringContinuous.value.continues && !s?.materials.flooring.breakNote) d("floor.break", "Flooring run", null, "Stops at a break (no other rooms)", f.flooringContinuous);
    // material decisions — report-wide statements apply to the rooms with growth; room statements to their room
    const mine = (x: Finding<unknown> | null) => !!x && (x.room ? x.room.toLowerCase() === p.name.toLowerCase() : !p.runOnly && (p.primary || !multi || x === f.subfloor));
    if (f.subfloor && mine(f.subfloor)) {
      const cur = s?.materials.subfloor ?? null;
      d("subfloor", "Subfloor", cur ? (cur === "remove" ? "Remove" : "Clean and treat (stays)") : null, f.subfloor.value === "remove" ? "Remove" : "Clean and treat (stays)", f.subfloor);
      if (cur && cur !== f.subfloor.value && !prev.subfloor) mismatches.push(`${multi ? `${where}: ` : ""}Subfloor: you have "${cur === "remove" ? "remove" : "clean and keep"}", the report says "${f.subfloor.value === "remove" ? "remove" : "clean and keep"}".`);
    }
    if (f.wallsGrowth?.value.growth && mine(f.wallsGrowth)) {
      const g = f.wallsGrowth.value;
      const sw = s?.materials.walls;
      const already = !!sw && g.walls.every((w) => sw.affectedWalls.includes(w)) && (g.heightIn == null || sw.wetHeightIn === g.heightIn);
      if (already) {
        /* the scan already has it */
      } else if (g.walls.length) d("walls.growth", "Walls with growth", s?.materials.walls.affectedWalls.length ? s.materials.walls.affectedWalls.join(", ") : null, `${g.walls.join(", ")}${g.heightIn ? ` up to ${g.heightIn}"` : " (height not stated)"}`, f.wallsGrowth);
      else mismatches.push(`${where}: the report finds growth on walls but doesn't say which — mark the walls in step 3.`);
    }
    if (f.baseboardBacksGrowth?.value.growth && mine(f.baseboardBacksGrowth) && !(s?.materials.baseboard.affected && s.materials.baseboard.action === "remove" && (f.baseboardBacksGrowth.value.walls.length ? f.baseboardBacksGrowth.value.walls : ["N", "E", "S", "W"]).every((w) => s.materials.baseboard.walls.includes(w)))) {
      const g = f.baseboardBacksGrowth.value;
      d("baseboard.growth", "Baseboard with growth on the back", s?.materials.baseboard.affected ? `${s.materials.baseboard.action ?? "?"} (${s.materials.baseboard.walls.join(", ") || "walls not set"})` : null, `Remove & discard${g.walls.length ? ` (${g.walls.join(", ")})` : ""}`, f.baseboardBacksGrowth);
    }
    if (f.framingGrowth?.value.growth && mine(f.framingGrowth) && !(s?.materials.framing?.growth && s.materials.framing.where === f.framingGrowth.value.where && s.materials.framing.action === f.framingGrowth.value.action)) {
      const g = f.framingGrowth.value;
      const cur = s?.materials.framing?.growth ? `${s.materials.framing.where} — ${s.materials.framing.action ?? "?"}` : null;
      d("framing", "Framing with growth", cur, `${g.where} — ${g.action ?? "clean or remove not stated"}`, f.framingGrowth);
      if (g.where === "joists" && (f.subfloor?.value ?? s?.materials.subfloor) === "clean")
        mismatches.push(`${where}: the report finds growth on the floor joists but keeps the subfloor — the joists can't be reached through it. Confirm subfloor removal with the assessor.`);
    }
    if (f.sourceFixed && !p.runOnly) {
      const want = f.sourceFixed.value ? "repaired" : "active";
      const cur = s && s.source.status !== "unknown" ? s.source.status : null;
      d("source.status", "Moisture source status", cur, f.sourceFixed.value ? "repaired" : "active", f.sourceFixed);
      if (cur && cur !== want && !prev["source.status"]) mismatches.push(`${multi ? `${where}: ` : ""}Source: you have "${cur}", the report says it is ${f.sourceFixed.value ? "repaired" : "not fixed"}.`);
    }
    if (f.moistureSource && p.primary && !s?.source.fixture) d("source.fixture", "Moisture source", null, f.moistureSource.value, f.moistureSource);

    for (const x of drafts) {
      const previousReport = x.current != null && prev[x.key] === x.current ? x.current : null;
      const conflict = x.manual && !previousReport && x.key !== "floor.affected" && x.key !== "flooring.type";
      changes.push({ id: `${p.name}::${x.key}`, room: p.name, key: x.key, label: x.label, current: x.current, proposed: x.proposed, quote: x.src.quote, page: x.src.page, conflict, previousReport });
      if (previousReport) replaced.push(`${where}: ${x.label.toLowerCase()} — the earlier report said "${previousReport}", this one says "${x.proposed}".`);
    }
  }
  if (f.yearBuilt && yearBuilt !== f.yearBuilt.value) {
    changes.push({ id: "::yearBuilt", room: "", key: "yearBuilt", label: "Year built", current: yearBuilt != null ? String(yearBuilt) : null, proposed: String(f.yearBuilt.value), quote: f.yearBuilt.quote, page: f.yearBuilt.page, conflict: yearBuilt != null, previousReport: null });
    if (yearBuilt != null) mismatches.push(`Year built: the property says ${yearBuilt}; the report says ${f.yearBuilt.value}.`);
  }
  if (f.rooms.length > 1)
    for (const r of rooms)
      if (r.scan.loss.type === "mold" && r.scan.materials.flooring.affected && !plans.some((p) => p.target === r) && !TBD.test(r.roomName))
        mismatches.push(`Your scan has ${r.label} with growth; the report doesn't mention it.`);
  if (f.flooringContinuous?.value.continues && !runGroup.length) mismatches.push("The report says the flooring continues into other rooms but doesn't name them — add those rooms with the same run name.");
  if (f.framingGrowth?.value.growth && !plans.some((p) => p.target || p.primary)) mismatches.push("The report finds growth on framing — add a room to scope it.");
  return { plans, changes, mismatches, replaced };
}

/** Single-room compatibility wrapper. */
export function proposeChanges(f: ReportFindings, t: RoomTarget): { changes: ReportChange[]; mismatches: string[] } {
  const { changes, mismatches } = proposeVisit(f, [{ locationId: "loc", label: t.roomLabel, roomName: t.roomName, scan: t.scan }], t.yearBuilt);
  return { changes, mismatches };
}

/**
 * Applies the chosen change ids (`room::key`; a bare key means the first planned room) to the
 * planned rooms. Every planned room is linked to the report and marked "received".
 */
export function applyVisit(f: ReportFindings, plans: RoomPlan[], changes: ReportChange[], ids: string[], documentId: string) {
  const pick = new Set(ids.map((id) => (id.includes("::") ? id : `${plans[0]?.name ?? ""}::${id}`)));
  const has = (p: RoomPlan, key: string) => pick.has(`${p.name}::${key}`);
  const growthRooms = plans.filter((p) => !p.runOnly);
  const out: { plan: RoomPlan; create: boolean; roomName: string | null; scan: RoomScanData }[] = [];
  for (const p of plans) {
    if (!p.target && !has(p, "room.new")) continue;
    const base: RoomScanData = p.target ? structuredClone(p.target.scan) : emptyLike();
    const scan = base;
    const r = p.report?.value ?? emptyRoomFinding(p.name);
    const chg = (key: string) => changes.find((c) => c.room === p.name && c.key === key);
    const rv: Record<string, string> = { ...scan.reportValues };
    const set = (key: string) => {
      const c = chg(key);
      if (c) rv[key] = c.proposed;
    };
    if (has(p, "measurements") && r.lengthFt != null && r.widthFt != null) {
      scan.measurements.lengthFt = r.lengthFt;
      scan.measurements.widthFt = r.widthFt;
      if (r.heightFt != null) scan.measurements.heightFt = r.heightFt;
      set("measurements");
    }
    if (has(p, "floor.pct")) {
      const n = Number(chg("floor.pct")?.proposed.match(/[\d.]+/)?.[0]);
      if (Number.isFinite(n)) scan.materials.flooring.affectedPct = n;
      set("floor.pct");
    }
    if (has(p, "floor.affected") || (!p.target && r.growth)) scan.materials.flooring.affected = true;
    if (has(p, "flooring.type") && f.flooringType) scan.materials.flooring.type = f.flooringType.value;
    if (has(p, "floor.run")) {
      scan.materials.flooring.continuousRun = chg("floor.run")!.proposed;
      set("floor.run");
    }
    if (has(p, "floor.break") && f.flooringContinuous) scan.materials.flooring.breakNote = `Report: ${f.flooringContinuous.quote}`.slice(0, 200);
    if (has(p, "subfloor") && f.subfloor) {
      scan.materials.subfloor = f.subfloor.value;
      set("subfloor");
    }
    if (has(p, "walls.growth")) set("walls.growth");
    if (has(p, "baseboard.growth")) set("baseboard.growth");
    if (has(p, "framing")) set("framing");
    if (has(p, "walls.growth") && f.wallsGrowth) {
      scan.materials.walls.affectedWalls = [...f.wallsGrowth.value.walls];
      scan.materials.walls.wetHeightIn = f.wallsGrowth.value.heightIn;
      if (!scan.materials.walls.material) scan.materials.walls.material = "drywall";
    }
    if (has(p, "baseboard.growth") && f.baseboardBacksGrowth) {
      const listed = f.baseboardBacksGrowth.value.walls;
      const whole = (scan.materials.flooring.affectedPct ?? 0) >= 100;
      const walls = new Set([...(whole ? ["N", "E", "S", "W"] : []), ...scan.materials.baseboard.walls, ...(listed.length ? listed : ["N", "E", "S", "W"])]);
      scan.materials.baseboard = { affected: true, walls: [...walls], action: "remove" };
    }
    if (has(p, "framing") && f.framingGrowth) scan.materials.framing = { ...f.framingGrowth.value };
    if (has(p, "source.status") && f.sourceFixed) {
      scan.source.status = f.sourceFixed.value ? "repaired" : "active";
      set("source.status");
    }
    if (has(p, "source.fixture") && f.moistureSource) scan.source.fixture = f.moistureSource.value.slice(0, 200);
    if (scan.loss.type == null) scan.loss.type = "mold";
    scan.loss.assessmentReport = "received";
    scan.reportDocumentId = documentId;
    scan.reportRoom = p.name || null;
    scan.reportPrimary = p.primary;
    scan.reportValues = rv;
    // one containment for connected rooms with growth: the primary room carries it
    const shared = growthRooms.length > 1 && (!!f.flooringContinuous?.value.continues || f.containment?.value.level === "full");
    scan.containmentGroup = shared && !p.runOnly ? { primary: p.primary, rooms: growthRooms.map((g) => g.name).filter(Boolean) } : null;
    const roomName = p.target ? (has(p, "room.name") ? p.name : null) : p.name || "Affected area (room TBD)";
    out.push({ plan: p, create: !p.target, roomName, scan });
  }
  const yearBuilt = pick.has("::yearBuilt") && f.yearBuilt ? f.yearBuilt.value : null;
  return { rooms: out, yearBuilt };
}

function emptyLike(): RoomScanData {
  return {
    source: { where: "unknown", fixture: null, wall: null, positionFt: null, surface: null, status: "unknown", hoursSinceLoss: null, waterSource: null },
    loss: { type: "mold", category: null, waterClass: null, smokeType: null, assessmentReport: null },
    materials: {
      flooring: { type: null, affected: false, affectedPct: null, action: null, continuousRun: null, breakNote: null },
      baseboard: { affected: false, walls: [], action: null },
      walls: { material: null, affectedWalls: [], wetHeightIn: null, floodCut: "auto" },
      ceiling: { affected: false, affectedPct: null, action: null },
      insulation: false,
      subfloor: null,
      framing: { growth: false, where: null, action: null },
      cabinets: { affected: false, lf: null, detach: false },
      fixtures: [],
    },
    contents: { present: false, affected: false, items: null, handling: "none" },
    measurements: { lengthFt: null, widthFt: null, heightFt: null, segments: null, openings: [] },
    moisturePoints: [],
    equipmentPlaced: [],
    lines: [],
    decisions: {},
    reportDocumentId: null,
    reportRoom: null,
    reportPrimary: false,
    reportValues: {},
    containmentGroup: null,
    lineNotes: {},
    reportChanges: [],
  };
}

/** Single-room compatibility wrapper. */
export function applyChanges(f: ReportFindings, t: RoomTarget, keys: string[], documentId: string) {
  const vr: VisitRoom = { locationId: "loc", label: t.roomLabel, roomName: t.roomName, scan: t.scan };
  const { plans, changes } = proposeVisit(f, [vr], t.yearBuilt);
  const r = applyVisit(f, plans, changes, keys, documentId);
  const mine = r.rooms.find((x) => x.plan.target === vr) ?? r.rooms[0];
  return { scan: mine?.scan ?? t.scan, roomName: mine?.roomName ?? null, yearBuilt: r.yearBuilt };
}

/**
 * What the report leaves open. With `scope`, only that room's items (plus the report-wide items
 * when it is the primary room); without it, everything.
 */
export function stillMissing(f: ReportFindings, ctx: { yearBuiltKnown: boolean; runKnown: boolean }, scope?: { room: string | null; primary: boolean }): string[] {
  const out: string[] = [];
  const docWide = !scope || scope.primary;
  if (docWide && f.sourceFixed?.value === false) out.push(`HOLD: the moisture source is not fixed (report: “${f.sourceFixed.quote}”) — remediation can't be finalized until it is repaired and the materials are dry`);
  const roomsHere = f.rooms.filter((r) => !scope || (r.value.name || null) === (scope.room || null) || (!scope.room && scope.primary));
  if (!f.rooms.length) {
    if (docWide) out.push("Affected area and extent (SF) — sets every removal and cleaning quantity");
  } else
    for (const r of roomsHere) {
      if (!r.value.growth) continue;
      const n = r.value.name ? `${r.value.name}: ` : "";
      if (r.value.lengthFt == null) out.push(`${n}room measurements — not in the report`);
      else if (r.value.heightFt == null) out.push(`${n}ceiling height — not in the report`);
      if (r.value.areaSF == null && !r.value.coverage) out.push(r.value.vague ? `${n}affected area — the report only says “${r.value.vague}” (no SF or boundary)` : `${n}affected area / whole floor or part — not in the report`);
      else if (r.value.coverage && !r.value.coverage.whole && r.value.coverage.pct == null && r.value.areaSF == null)
        out.push(`${n}growth on part of the floor with no SF or boundary — measure the affected area (clarify with the assessor)`);
    }
  if (docWide) {
    const cr = [!f.containment && "containment level", !f.removalExtent && "how far removal goes"].filter(Boolean);
    if (cr.length) out.push(`Remediation plan: ${cr.join(" and ")}`);
    const gr = [!f.subfloor && "whether the subfloor is cleaned or removed", !f.wallsGrowth && "growth on walls", !f.baseboardBacksGrowth && "growth on baseboard backs", !f.framingGrowth && "growth on framing"].filter(Boolean);
    if (gr.length) out.push(`Not stated in the report: ${gr.join(", ")}`);
    if (f.wallsGrowth?.value.growth && !f.wallsGrowth.value.walls.length) out.push("Which walls have growth — the report doesn't name them");
    if (f.wallsGrowth?.value.growth && f.wallsGrowth.value.heightIn == null) out.push("How high the growth goes on the walls — sets the drywall removal");
    if (f.framingGrowth?.value.growth && !f.framingGrowth.value.action) out.push(`Whether the ${f.framingGrowth.value.where} with growth are cleaned or removed`);
    const cl = [!f.clearanceCriteria && "clearance criteria", !f.clearanceBy && "who performs the post-remediation verification"].filter(Boolean);
    if (cl.length) {
      const said = f.unanswered.find((u) => u.key === "clearanceCriteria" && u.quote)?.quote;
      out.push(`${cl.join(" and ").replace(/^./, (c) => c.toUpperCase())}${said ? ` (report: “${said}”)` : " — not in the report"}`);
    }
    if (!f.sourceFixed) out.push("Whether the moisture source is fixed — not in the report; remediation can't be finalized until it is confirmed");
    if (!f.yearBuilt && !ctx.yearBuiltKnown) out.push("Year built — not in the report (lead/asbestos check before demolition)");
    if (!f.flooringContinuous && !ctx.runKnown) out.push("Whether the wood flooring runs into other rooms — not in the report");
  }
  return out;
}

/** Report quotes appended to the justification of the lines they support (for one room). */
export function reportJustifications(f: ReportFindings, measured: { lengthFt: number | null; widthFt: number | null }, room: string, reportRoom: string | null = null): Record<string, string> {
  const j: Record<string, string> = {};
  const q = (x: { quote: string } | null | undefined) => (x ? `“${x.quote}”` : "");
  const rf = f.rooms.find((r) => r.value.name && reportRoom && r.value.name.toLowerCase() === reportRoom.toLowerCase()) ?? (reportRoom ? null : f.rooms[0]);
  const v = rf?.value;
  if (v && (v.coverage || v.areaSF != null)) {
    const dims = measured.lengthFt && measured.widthFt ? `${measured.lengthFt} × ${measured.widthFt} ft ` : "";
    const nm = (v.name || room).toLowerCase();
    const what = v.coverage?.whole ? `growth across the full ${dims}${nm} floor` : `growth on ${v.coverage?.pct != null ? `${v.coverage.pct}% of` : "part of"} the ${nm} floor`;
    const src = v.quotes.coverage ?? v.quotes.area;
    j["mold.floor.remove"] = `Report states ${what}${v.areaSF != null ? ` (${v.areaSF} SF)` : ""}: ${src ? `“${src}”` : ""}`;
  }
  if (f.removalExtent) j["mold.underlayment.remove"] = `Report removal limits: ${q(f.removalExtent)}`;
  if (f.containment) {
    j["mold.containment"] = `Report: ${q(f.containment)}`;
    if (f.containment.value.negativeAir) j["mold.negair"] = `Report calls for negative air: ${q(f.containment)}`;
  }
  if (f.subfloor) {
    j["mold.subfloor.clean"] = `Report: ${q(f.subfloor)}`;
    j["mold.subfloor.remove"] = `Report: ${q(f.subfloor)}`;
    j["mold.antimicrobial"] = `After cleaning per the report: ${q(f.subfloor)}`;
  }
  if (f.wallsGrowth?.value.growth) j["mold.walls.remove"] = `Report: ${q(f.wallsGrowth)}`;
  if (f.framingGrowth?.value.growth) {
    j["mold.framing.clean"] = `Report: ${q(f.framingGrowth)}`;
    j["mold.framing.remove"] = `Report: ${q(f.framingGrowth)}`;
  }
  if (f.baseboardBacksGrowth?.value.growth) j["baseboard"] = `Report: ${q(f.baseboardBacksGrowth)} — discard that baseboard.`;
  if (f.clearanceCriteria || f.clearanceBy) j["mold.pcv"] = `Report: ${q(f.clearanceCriteria ?? f.clearanceBy)}`;
  else {
    const said = f.unanswered.find((u) => u.key === "clearanceCriteria" && u.quote)?.quote;
    if (said) j["mold.pcv"] = `Report: “${said}” — criteria and who performs it still to be set.`;
  }
  return j;
}
