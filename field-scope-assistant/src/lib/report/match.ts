import { CASEWORK_ACTION_LABELS, CASEWORK_LABELS, CABINET_BOXES, type CaseworkKind, type RoomScanData } from "../scan";
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
  /** Needs a PM choice the report doesn't make (e.g. "remove" with no how) — offered, OFF by default, never auto-applied. */
  optional?: boolean;
}

export interface VisitRoom {
  locationId: string | null;
  label: string;
  roomName: string;
  scan: RoomScanData;
  /** Unit / floor of the room (when known) — used so a report for Unit 4D never lands in another unit. */
  unit?: string | null;
  floor?: string | null;
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
  /** The report room matches more than one scanned room — nothing is applied until the PM picks. */
  ambiguous?: string[];
  /** Matched only by a partial name (e.g. report "Bedroom" → the only "Master Bedroom") — flagged to check. */
  partial?: boolean;
}

const TBD = /room TBD/i;
const norm = (x: string) => x.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
/** Same room name (normalized: case, punctuation, "&"). */
const sameName = (a: string, b: string) => !!a && !!b && norm(a) === norm(b);
/** The scan's room name contains the report's name as whole words ("Master Bedroom" ⊃ "Bedroom"). */
const wordIn = (room: string, report: string) => !!room && !!report && new RegExp(`(^| )${norm(report).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(norm(room));
const normUnit = (u: string | null | undefined) => (u ?? "").toLowerCase().replace(/^(unit|apt\.?|apartment|suite|#)\s*/i, "").replace(/[^a-z0-9]/g, "");

/**
 * Which scanned room a report room goes to: an exact name first; a partial (whole-word) name only
 * when it is the ONLY candidate (flagged); more than one candidate → ambiguous (nothing applied).
 * With the report's unit known, rooms in another unit are never candidates.
 */
function matchRoom(name: string, rooms: VisitRoom[], used: Set<VisitRoom>, reportUnit: string | null): { room: VisitRoom | null; ambiguous: string[]; partial: boolean } {
  let pool = rooms.filter((r) => !used.has(r));
  const ru = normUnit(reportUnit);
  if (ru) pool = pool.filter((r) => !normUnit(r.unit) || normUnit(r.unit) === ru);
  const exact = pool.filter((r) => sameName(r.roomName, name));
  if (exact.length === 1) return { room: exact[0], ambiguous: [], partial: false };
  if (exact.length > 1) return { room: null, ambiguous: exact.map((r) => r.label), partial: false };
  const part = pool.filter((r) => wordIn(r.roomName, name));
  if (part.length === 1) return { room: part[0], ambiguous: [], partial: true };
  if (part.length > 1) return { room: null, ambiguous: part.map((r) => r.label), partial: false };
  return { room: null, ambiguous: [], partial: false };
}
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
  for (const m of f.caseworkMentions ?? []) {
    const n = m.value.room;
    if (n && !list.some((x) => x.name.toLowerCase() === n.toLowerCase())) list.push({ name: n, report: null, runOnly: !m.value.growth });
  }
  if (!list.length) list.push({ name: "", report: null, runOnly: false });
  const used = new Set<VisitRoom>();
  const reportUnit = f.unit?.value ?? null;
  // exact names claim their rooms first, so "Bedroom" never takes "Master Bedroom" when both exist
  const plans: RoomPlan[] = list.map((x) => ({ name: x.name, report: x.report, target: null, primary: false, runOnly: x.runOnly }));
  for (const exactPass of [true, false])
    for (const p of plans) {
      if (p.target || !p.name || p.ambiguous?.length) continue;
      const m = matchRoom(p.name, rooms, used, reportUnit);
      if (exactPass && (m.partial || m.ambiguous.length)) continue;
      if (m.room) {
        p.target = m.room;
        p.partial = m.partial;
        used.add(m.room);
      } else if (m.ambiguous.length) p.ambiguous = m.ambiguous;
    }
  for (const p of plans) {
    if (p.target || p.ambiguous?.length) continue;
    const free = rooms.filter((r) => !used.has(r));
    const ru = normUnit(reportUnit);
    const sameUnit = free.filter((r) => !ru || !normUnit(r.unit) || normUnit(r.unit) === ru);
    const t = sameUnit.find((r) => TBD.test(r.roomName)) ?? (plans.length === 1 && sameUnit.length === 1 ? sameUnit[0] : !p.name && sameUnit.length === 1 ? sameUnit[0] : undefined);
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
  optional?: boolean;
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
    const d = (key: string, label: string, current: string | null, proposed: string, src: Finding<unknown> | null, optional = false) => {
      if (!src || current === proposed) return;
      drafts.push({ key, label, current, proposed, src, manual: current != null, optional });
    };
    const anchor = (q: string | null) => (q ? { value: null, quote: q, page: p.report?.page ?? 1 } : p.report);

    if (p.ambiguous?.length) {
      // more than one scanned room fits — never guess: the change is offered but OFF, and the PM is told which rooms
      mismatches.push(`The report's ${p.name} matches more than one room here (${p.ambiguous.join(", ")}) — rename the room to match, or apply to the right room by hand. Nothing is applied for it automatically.`);
      d("room.new", "Add room", null, p.name, p.report ?? f.rooms[0] ?? null);
    } else if (!p.target) d("room.new", "Add room", null, p.name || "Affected area (room TBD)", p.report ?? f.flooringContinuous ?? f.rooms[0] ?? null);
    else if (p.partial) mismatches.push(`The report's ${p.name} was matched to "${p.target.roomName}" by a partial name — check it is the same room.`);
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
    const itemized = !!r.surfaces?.length;
    const hasFloor = itemized ? r.surfaces!.includes("floor") : true;
    if (r.growth && hasFloor && !s?.materials.flooring.affected && (itemized || r.coverage || r.areaSF != null || r.vague || !multi)) d("floor.affected", "Flooring with growth", s ? "No" : null, "Yes", p.report ?? f.floorCoverage ?? f.affectedAreaSF);
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
    if ((r.growth || p.runOnly) && hasFloor && f.flooringType && !s?.materials.flooring.type) d("flooring.type", "Flooring", null, f.flooringType.value, f.flooringType);
    if (runGroup.includes(p) && runGroup.length > 1) d("floor.run", "Continuous flooring run", s?.materials.flooring.continuousRun ?? null, existingRun, f.flooringContinuous);
    if (p.primary && f.flooringContinuous && !f.flooringContinuous.value.continues && !s?.materials.flooring.breakNote) d("floor.break", "Flooring run", null, "Stops at a break (no other rooms)", f.flooringContinuous);
    // material decisions — report-wide statements apply to the rooms with growth; room statements to their room
    const mine = (x: Finding<unknown> | null) => !!x && (x.room ? x.room.toLowerCase() === p.name.toLowerCase() : !p.runOnly && (p.primary || !multi || x === f.subfloor));
    // flooring: the assessor's remove-or-sand option for named rooms
    const ft = f.floorTreatment;
    if (ft && hasFloor && ft.value.rooms.some((n) => n.toLowerCase() === p.name.toLowerCase()) && s?.materials.flooring.choice !== "remove_or_sand" && !s?.materials.flooring.action)
      d("floor.choice", "Wood flooring treatment", null, "Remove OR sand the discoloration — the report allows either (you choose)", ft);
    // drywall removals the report states for this room
    const wr = (f.wallRemovals ?? []).find((w) => w.value.rooms.some((n) => n.toLowerCase() === p.name.toLowerCase()));
    if (wr) {
      const label = wr.value.statedSF != null ? wr.value.wallLabel : (r.wallLabel ?? wr.value.wallLabel);
      const prop = wr.value.statedSF != null ? `${label}: ${wr.value.statedSF} SF of drywall as stated${wr.value.approximate ? " (approximately)" : ""}${wr.value.entireWall ? ", entire wall" : ""}` : `${label}: remove drywall ${wr.value.heightIn}" (${(wr.value.heightIn ?? 0) / 12} ft) from the floor`;
      const sw = s?.materials.walls;
      const cur = sw && sw.affectedWalls.length ? `${sw.affectedWalls.join(", ")}${typeof sw.floodCut === "number" ? ` at ${sw.floodCut}"` : ""}${sw.statedRemovalSF ? `: ${sw.statedRemovalSF} SF` : ""}` : null;
      const same = !!sw && sw.affectedWalls.includes(label) && (wr.value.statedSF != null ? sw.statedRemovalSF === wr.value.statedSF : sw.floodCut === wr.value.heightIn);
      if (!same) d("walls.removal", "Drywall removal", cur, prop, wr);
    }
    const bbr = (f.baseboardRemovals ?? []).find((b) => b.value.room.toLowerCase() === p.name.toLowerCase());
    if (bbr && !(s?.materials.baseboard.affected && s.materials.baseboard.action === "remove")) d("baseboard.remove", "Baseboard / base moldings", s?.materials.baseboard.affected ? s.materials.baseboard.action : null, "Remove all base moldings", bbr);
    for (const sp of (f.specialItems ?? []).filter((x) => x.value.room.toLowerCase() === p.name.toLowerCase()))
      if (!s?.materials.moldSpecial.includes(sp.value.kind)) d(`special.${sp.value.kind}`, sp.value.kind === "vent" ? "Vent cleaning" : "Shower caulking", null, sp.value.kind === "vent" ? `Clean the vent${sp.value.hvacIfInaccessible ? " (HVAC company if not accessible)" : ""}` : "Scrape, sanitize, re-seal with silicone", sp);
    // containment per the report: this room's own area, or none listed
    const ca = f.containment?.value.areas;
    if (ca?.length && !p.runOnly) {
      const mineArea = ca.find((a) => a.room.toLowerCase() === p.name.toLowerCase());
      const want = mineArea ? `${mineArea.extent === "entire" ? "Entire room" : mineArea.extent === "localized" ? "Localized area" : "Containment"}${f.airScrubber ? ` + ${f.airScrubber.value.perContainment} HEPA air scrubber${f.airScrubber.value.hours ? `, ${f.airScrubber.value.hours} h` : ""}${f.airScrubber.value.ach ? ` at ${f.airScrubber.value.ach} ACH` : ""}` : ""}` : "None listed for this room";
      const cur = s?.containmentArea ? (s.containmentArea.none ? "None listed for this room" : `${s.containmentArea.extent === "entire" ? "Entire room" : s.containmentArea.extent === "localized" ? "Localized area" : "Containment"}${s.containmentArea.scrubber ? ` + ${s.containmentArea.scrubber.perContainment} HEPA air scrubber${s.containmentArea.scrubber.hours ? `, ${s.containmentArea.scrubber.hours} h` : ""}${s.containmentArea.scrubber.ach ? ` at ${s.containmentArea.scrubber.ach} ACH` : ""}` : ""}`) : null;
      if (cur !== want) d("containment.area", "Containment", cur, want, mineArea ? f.containment! : (f.containment as Finding<unknown>));
    }
    if (f.packout && ca?.some((a) => a.room.toLowerCase() === p.name.toLowerCase()) && !(s?.contents.present && s.contents.handling === "packout"))
      d("contents.packout", "Contents", s?.contents.present ? s.contents.handling : null, "Surface clean & pack out; porous items that can't be laundered are discarded", f.packout);
    if (f.sourceMustBeAddressed && !f.sourceFixed && !p.runOnly && !s?.source.hold) d("source.hold", "Moisture source", null, "HOLD — the report says it must be addressed; not confirmed fixed", f.sourceMustBeAddressed);
    if (f.subfloor && mine(f.subfloor) && hasFloor) {
      const cur = s?.materials.subfloor ?? null;
      d("subfloor", "Subfloor", cur ? (cur === "remove" ? "Remove" : "Clean and treat (stays)") : null, f.subfloor.value === "remove" ? "Remove" : "Clean and treat (stays)", f.subfloor);
      if (cur && cur !== f.subfloor.value && !prev.subfloor) mismatches.push(`${multi ? `${where}: ` : ""}Subfloor: you have "${cur === "remove" ? "remove" : "clean and keep"}", the report says "${f.subfloor.value === "remove" ? "remove" : "clean and keep"}".`);
    }
    if (f.wallsGrowth?.value.growth && mine(f.wallsGrowth) && !(f.wallRemovals ?? []).length) {
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
    // cabinets / countertops / vanity / backsplash the report names for this room (no room named → the primary room)
    for (const m of caseworkFor(f, p)) {
      const k = m.value.kind;
      const it = s?.materials.casework.find((x) => x.kind === k);
      const cur = it ? (it.affected ? (it.action ? cwText(it.action) : null) : "Not affected") : null;
      if (m.value.removeOnly) {
        if (it?.affected && it.action) continue; // the PM already chose how
        d(`casework.${k}`, CASEWORK_LABELS[k], cur, `Affected — the report says remove, not how: ${REMOVE_CHOICES}${removeHintText(m.value.removeHint)} (not picked)`, m, true);
      } else d(`casework.${k}`, CASEWORK_LABELS[k], cur, m.value.action ? cwText(m.value.action) : "Affected — action not stated in the report", m);
    }
    if (f.moistureSource && p.primary && !s?.source.fixture) d("source.fixture", "Moisture source", null, f.moistureSource.value, f.moistureSource);

    for (const x of drafts) {
      const previousReport = x.current != null && prev[x.key] === x.current ? x.current : null;
      const conflict = (x.manual && !previousReport && x.key !== "floor.affected" && x.key !== "flooring.type") || !!p.ambiguous?.length;
      changes.push({ id: `${p.name}::${x.key}`, room: p.name, key: x.key, label: x.label, current: x.current, proposed: x.proposed, quote: x.src.quote, page: x.src.page, conflict, previousReport, ...(x.optional ? { optional: true } : {}) });
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
    const floorHere = !r.surfaces?.length || r.surfaces.includes("floor");
    if (has(p, "floor.affected") || (!p.target && r.growth && floorHere)) scan.materials.flooring.affected = true;
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
    if (has(p, "floor.choice")) scan.materials.flooring.choice = "remove_or_sand";
    const wr = (f.wallRemovals ?? []).find((w) => w.value.rooms.some((n) => n.toLowerCase() === p.name.toLowerCase()));
    if (has(p, "walls.removal") && wr) {
      const label = wr.value.statedSF != null ? wr.value.wallLabel : (r.wallLabel ?? wr.value.wallLabel);
      scan.materials.walls.affectedWalls = [label];
      scan.materials.walls.material = scan.materials.walls.material ?? "drywall";
      if (wr.value.statedSF != null) {
        scan.materials.walls.statedRemovalSF = wr.value.statedSF;
        scan.materials.walls.statedApproximate = wr.value.approximate;
      } else if (wr.value.heightIn != null) {
        scan.materials.walls.floodCut = wr.value.heightIn;
        scan.materials.walls.cutSource = `report: remove drywall ${wr.value.heightIn / 12} ft from the floor along the affected wall (p.${wr.page})`;
      }
      scan.materials.encapsulate = !!f.encapsulant;
      set("walls.removal");
    }
    if (has(p, "baseboard.remove")) scan.materials.baseboard = { affected: true, walls: ["N", "E", "S", "W"], action: "remove" };
    for (const k of ["shower_caulking", "vent"] as const)
      if (has(p, `special.${k}`) && !scan.materials.moldSpecial.includes(k)) {
        scan.materials.moldSpecial = [...scan.materials.moldSpecial, k];
        if (k === "vent") scan.materials.ventHvacIfInaccessible = !!(f.specialItems ?? []).find((x) => x.value.kind === "vent")?.value.hvacIfInaccessible;
      }
    if (has(p, "containment.area") && f.containment?.value.areas) {
      const a = f.containment.value.areas.find((x) => x.room.toLowerCase() === p.name.toLowerCase());
      scan.containmentArea = a ? { extent: a.extent, none: false, scrubber: f.airScrubber ? { perContainment: f.airScrubber.value.perContainment, hours: f.airScrubber.value.hours, ach: f.airScrubber.value.ach } : null } : { extent: null, none: true, scrubber: null };
      set("containment.area");
    }
    for (const m of caseworkFor(f, p)) {
      const k = m.value.kind;
      if (!has(p, `casework.${k}`)) continue;
      const list = scan.materials.casework;
      const it = list.find((x) => x.kind === k);
      if (it) {
        it.affected = true;
        if (m.value.action) it.action = m.value.action;
      } else list.push({ kind: k, affected: true, action: m.value.action, extent: null, section: null, wall: null, lf: null, depthIn: null, count: null, material: null });
      set(`casework.${k}`);
    }
    if (has(p, "contents.packout")) scan.contents = { present: true, affected: true, items: "items in the remediation area (porous items that can't be laundered are discarded)", handling: "packout" };
    if (has(p, "source.hold") && f.sourceMustBeAddressed) scan.source.hold = f.sourceMustBeAddressed.quote.slice(0, 300);
    // report notes for this room (not scope lines)
    const notes: string[] = [];
    if (r.airElevated) notes.push(`Report: elevated mold spore counts in the air sample here${p.report ? ` (p.${p.report.page})` : ""}.`);
    for (const c of f.otherConcerns ?? []) if (findMention(c.quote, p.name)) notes.push(`Report (p.${c.page}): “${c.quote}”`);
    if (p.primary && f.hazardNote) notes.push(`Report (p.${f.hazardNote.page}): “${f.hazardNote.quote}”`);
    if (p.primary) for (const c of f.conflicts ?? []) notes.push(`⚑ The report disagrees with itself: ${c.text}.`);
    scan.reportNotes = notes;
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
    const shared = growthRooms.length > 1 && !f.containment?.value.separate && !f.containment?.value.areas?.length && (!!f.flooringContinuous?.value.continues || f.containment?.value.level === "full");
    scan.containmentGroup = shared && !p.runOnly ? { primary: p.primary, rooms: growthRooms.map((g) => g.name).filter(Boolean) } : null;
    const roomName = p.target ? (has(p, "room.name") ? p.name : null) : p.name || "Affected area (room TBD)";
    out.push({ plan: p, create: !p.target, roomName, scan });
  }
  const yearBuilt = pick.has("::yearBuilt") && f.yearBuilt ? f.yearBuilt.value : null;
  return { rooms: out, yearBuilt };
}

const cwText = (a: keyof typeof CASEWORK_ACTION_LABELS) => `Affected — ${CASEWORK_ACTION_LABELS[a].toLowerCase()}`;
const REMOVE_CHOICES = "detach & reset, remove & replace, or remove & dispose?";
export const removeHintText = (h: "access" | "damaged" | null | undefined) =>
  h === "access" ? " — “remove to access” usually means detach & reset" : h === "damaged" ? " — damaged material usually means remove & replace or remove & dispose" : "";

/** The report's cabinet / countertop mentions for one planned room (no room named → the primary room). */
function caseworkFor(f: ReportFindings, p: RoomPlan) {
  return (f.caseworkMentions ?? []).filter((m) => (m.value.room ? m.value.room.toLowerCase() === p.name.toLowerCase() : p.primary));
}

const findMention = (text: string, room: string) => {
  const t = text.toLowerCase();
  const r = room.toLowerCase();
  return t.includes(r) || (r.startsWith("washer") && /\bwasher\b/.test(t));
};

function emptyLike(): RoomScanData {
  return {
    source: { where: "unknown", fixture: null, wall: null, positionFt: null, surface: null, status: "unknown", hoursSinceLoss: null, waterSource: null, hold: null },
    loss: { type: "mold", category: null, waterClass: null, smokeType: null, assessmentReport: null },
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
    lines: [],
    decisions: {},
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
  if (docWide && f.sourceMustBeAddressed && !f.sourceFixed)
    out.push(`HOLD: source of water intrusion not confirmed fixed — the report says “${f.sourceMustBeAddressed.quote}” (p.${f.sourceMustBeAddressed.page}); remediation can't be finalized until it is confirmed`);
  if (docWide) for (const c of f.conflicts ?? []) out.push(`Report disagrees with itself — ${c.text} (${c.quotes.map((q) => `p.${q.page}: “${q.quote}”`).join(" vs ")})`);
  if (docWide && f.sourceFixed?.value === false) out.push(`HOLD: the moisture source is not fixed (report: “${f.sourceFixed.quote}”) — remediation can't be finalized until it is repaired and the materials are dry`);
  const roomsHere = f.rooms.filter((r) => !scope || (r.value.name || null) === (scope.room || null) || (!scope.room && scope.primary));
  if (!f.rooms.length) {
    if (docWide) out.push("Affected area and extent (SF) — sets every removal and cleaning quantity");
  } else
    for (const r of roomsHere) {
      if (!r.value.growth) continue;
      const n = r.value.name ? `${r.value.name}: ` : "";
      const sf = r.value.surfaces ?? [];
      const contained = !!f.containment?.value.areas?.some((a) => a.room.toLowerCase() === r.value.name.toLowerCase());
      const needsSize = !sf.length || sf.some((x) => x === "wall" || x === "floor" || x === "ceiling") || contained;
      const hasFloor = !sf.length || sf.includes("floor");
      if (needsSize && r.value.lengthFt == null) out.push(`${n}room measurements — not in the report`);
      else if (needsSize && r.value.heightFt == null) out.push(`${n}ceiling height — not in the report`);
      const wr = (f.wallRemovals ?? []).find((w) => w.value.rooms.some((x) => x.toLowerCase() === r.value.name.toLowerCase()));
      if (wr?.value.heightIn != null) out.push(`${n}length of the ${r.value.wallLabel ?? wr.value.wallLabel} — sets the drywall removal SF at ${wr.value.heightIn}" high (not in the report)`);
      if (wr?.value.statedSF != null && wr.value.approximate) out.push(`${n}drywall removal is “approximately ${wr.value.statedSF} square feet” in the report — verify on site`);
      const area = f.containment?.value.areas?.find((a) => a.room.toLowerCase() === r.value.name.toLowerCase());
      if (area?.extent === "localized") out.push(`${n}size of the localized containment (poly SF) — not in the report`);
      if (sf.includes("caulking")) out.push(`${n}shower caulk length (LF) — not in the report`);
      if (!hasFloor) continue;
      if (r.value.areaSF == null && !r.value.coverage) out.push(r.value.vague ? `${n}affected area — the report only says “${r.value.vague}” (no SF or boundary)` : `${n}affected area / whole floor or part — not in the report`);
      else if (r.value.coverage && !r.value.coverage.whole && r.value.coverage.pct == null && r.value.areaSF == null)
        out.push(`${n}growth on part of the floor with no SF or boundary — measure the affected area (clarify with the assessor)`);
    }
  // cabinets / countertops: what the report doesn't give (never guessed)
  for (const m of (f.caseworkMentions ?? []).filter((x) => !scope || (x.value.room ? (x.value.room || null)?.toLowerCase() === scope.room?.toLowerCase() : docWide))) {
    const n = m.value.room ? `${m.value.room}: ` : "";
    const k: CaseworkKind = m.value.kind;
    const lbl = CASEWORK_LABELS[k].toLowerCase();
    if (m.value.removeOnly) out.push(`${n}${lbl} — the report says “${m.quote}” (p.${m.page}): ${REMOVE_CHOICES}${removeHintText(m.value.removeHint)}. Not picked — choose it in the scan`);
    else if (!m.value.action) out.push(`${n}${lbl} — clean, detach & reset, or remove? The report names it (p.${m.page}) but doesn't say`);
    if (k === "countertop" || k === "vanity_top" || k === "backsplash") out.push(`${n}${lbl} material and length (LF) — not in the report; measure on site and pick the material`);
    else if ((CABINET_BOXES as readonly string[]).includes(k) || k === "toe_kick") out.push(`${n}${lbl} length (LF) — not in the report; measure on site`);
    else if (k === "doors_drawers") out.push(`${n}how many doors / drawer fronts — not in the report`);
  }
  if (docWide) for (const u of f.caseworkUnspecified ?? []) out.push(`Which cabinets (upper / lower / vanity)? The report says “${u.quote}” (p.${u.page}) — not assumed`);
  if (docWide) {
    const cr = [!f.containment && "containment level", !f.removalExtent && "how far removal goes"].filter(Boolean);
    if (cr.length) out.push(`Remediation plan: ${cr.join(" and ")}`);
    const gr = [!f.subfloor && "whether the subfloor is cleaned or removed", !f.wallsGrowth && "growth on walls", !f.baseboardBacksGrowth && "growth on baseboard backs", !f.framingGrowth && "growth on framing"].filter(Boolean);
    if (gr.length) out.push(`Not stated in the report: ${gr.join(", ")}`);
    const wallsCovered = !!(f.wallRemovals ?? []).length;
    if (f.wallsGrowth?.value.growth && !f.wallsGrowth.value.walls.length && !wallsCovered) out.push("Which walls have growth — the report doesn't name them");
    if (f.wallsGrowth?.value.growth && f.wallsGrowth.value.heightIn == null && !wallsCovered) out.push("How high the growth goes on the walls — sets the drywall removal");
    if (f.floorTreatment) out.push(`${f.floorTreatment.value.rooms.join(", ")}: remove the affected wood flooring or sand the discoloration — the report allows either (p.${f.floorTreatment.page}); pick one per room`);
    if (f.framingGrowth?.value.growth && !f.framingGrowth.value.action) out.push(`Whether the ${f.framingGrowth.value.where} with growth are cleaned or removed`);
    const cl = [!f.clearanceCriteria && "clearance criteria", !f.clearanceBy && "who performs the post-remediation verification"].filter(Boolean);
    if (cl.length) {
      const said = f.unanswered.find((u) => u.key === "clearanceCriteria" && u.quote)?.quote;
      out.push(`${cl.join(" and ").replace(/^./, (c) => c.toUpperCase())}${said ? ` (report: “${said}”)` : " — not in the report"}`);
    }
    if (!f.moistureSource) out.push("What the moisture source is — not identified in the report");
    if (!f.sourceFixed && !f.sourceMustBeAddressed) out.push("Whether the moisture source is fixed — not in the report; remediation can't be finalized until it is confirmed");
    if (f.labTablesMissing) out.push(`Mold species / lab results — the report refers to lab results (p.${f.labTablesMissing.page}) but no lab tables are in the file's text; not filled in`);
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
  for (const m of f.caseworkMentions ?? []) {
    const here = m.value.room ? !!reportRoom && m.value.room.toLowerCase() === reportRoom.toLowerCase() : !reportRoom || rf === f.rooms[0];
    if (here) j[`cw.${m.value.kind}`] = `Report (p.${m.page}): ${q(m)}`;
  }
  if (f.clearanceCriteria || f.clearanceBy) j["mold.pcv"] = `Report: ${q(f.clearanceCriteria ?? f.clearanceBy)}`;
  else {
    const said = f.unanswered.find((u) => u.key === "clearanceCriteria" && u.quote)?.quote;
    if (said) j["mold.pcv"] = `Report: “${said}” — criteria and who performs it still to be set.`;
  }
  return j;
}
