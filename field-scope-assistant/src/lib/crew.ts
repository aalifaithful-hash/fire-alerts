import type { Rules } from "./defaults";
import type { RoomAnalysis } from "./roomRules";
import type { RoomScanData, ScopeLine } from "./scan";

/**
 * Crew (crew chiefs + subs) and the equipment schedule for a visit, from its room scans.
 * Rules only. Every number shows its math; anything that can't be derived is left for the PM
 * to confirm and flagged — never invented. A sub trade is listed only when a scope line
 * indicates it or the PM picks it.
 */

export type WorkType = "ems" | "mitigation" | "mold" | "fire" | "contents" | "reconstruction";
export const WORK_TYPE_LABELS: Record<WorkType, string> = { ems: "emergency services", mitigation: "water mitigation", mold: "mold remediation", fire: "fire/smoke cleaning", contents: "contents", reconstruction: "reconstruction" };

export interface CrewRoom {
  label: string;
  data: RoomScanData;
  analysis: Pick<RoomAnalysis, "lines" | "takeoff" | "affectedFloorSF">;
}

export interface CrewPhase {
  phase: "Mitigation / remediation" | "Reconstruction";
  workTypes: WorkType[];
  workerDays: number | null;
  targetDays: number;
  workers: number | null;
  crewChiefs: number | null;
  subs: number | null;
  total: number | null;
  math: string[];
  /** Why the count couldn't be derived (rooms not measured …). */
  missing: string[];
}

export interface CrewPlan {
  phases: CrewPhase[];
  /** The proposal shown at the top of the scope: the largest phase. */
  proposed: { crewChiefs: number; subs: number; total: number; label: string } | null;
  trades: { trade: string; why: string }[];
  confirmed: { crewChiefs: number; subs: number; total: number; trades: string[]; label: string } | null;
  needsConfirmation: boolean;
  note: string;
  /** Trades the PM can pick (Settings → Rules & defaults → Crew). */
  tradeOptions: string[];
}

const live = (l: ScopeLine) => l.status !== "rejected" && l.status !== "excluded";
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
export const crewLabel = (cc: number, subs: number) => `CC${cc > 1 ? ` ×${cc}` : ""}+${subs}`;

function roomWorkType(r: CrewRoom, serviceLine: string | null): WorkType | null {
  const t = r.data.loss.type ?? (serviceLine === "mold" ? "mold" : null);
  if (t === "mold") return "mold";
  if (t === "fire" || t === "smoke") return "fire";
  if (t === "water" || t === "sewage" || r.data.source.waterSource != null) return serviceLine === "ems" ? "ems" : "mitigation";
  return null;
}

export function crewPlan(
  rooms: CrewRoom[],
  o: { rules: Rules; serviceLine: string | null; reconstructionRequested: boolean; jobInfo: { crewChiefs: number | null; subcontractors: number | null; subTrades?: string[] } },
): CrewPlan {
  const C = o.rules.crew;
  // ---- mitigation / remediation phase ----
  const mitRooms = rooms.filter((r) => r.analysis.lines.some((l) => live(l) && l.kind !== "reconstruction"));
  const types = new Set<WorkType>();
  const math: string[] = [];
  const missing: string[] = [];
  let wd = 0;
  let containments = 0;
  let contentsRooms = 0;
  for (const r of mitRooms) {
    const lines = r.analysis.lines.filter(live);
    const wt = roomWorkType(r, o.serviceLine);
    const contained = lines.some((l) => l.id === "mold.containment");
    if (contained) containments++;
    if (lines.some((l) => l.kind === "contents")) contentsRooms++;
    if (!wt) {
      if (lines.some((l) => l.kind === "contents")) types.add("contents");
      continue;
    }
    types.add(wt);
    const sf = wt === "mold" && contained ? r.analysis.takeoff.floorSF : wt === "fire" ? r.analysis.takeoff.floorSF : (r.analysis.affectedFloorSF ?? (wt === "mold" ? r.analysis.takeoff.floorSF : null));
    if (sf == null) {
      missing.push(`${r.label}: affected area not measured`);
      continue;
    }
    const rate = C.sfPerWorkerDay[wt];
    const d = sf / rate;
    wd += d;
    math.push(`${r.label}: ${r1(sf)} SF ÷ ${rate} SF per worker-day (${WORK_TYPE_LABELS[wt]}) = ${r2(d)} worker-days`);
  }
  if (containments && C.containmentWorkerDays) {
    wd += containments * C.containmentWorkerDays;
    math.push(`${containments} containment${containments === 1 ? "" : "s"} × ${C.containmentWorkerDays} worker-days (set up, negative air, teardown) = ${r2(containments * C.containmentWorkerDays)}`);
  }
  if (contentsRooms && C.contentsWorkerDaysPerRoom) {
    types.add("contents");
    wd += contentsRooms * C.contentsWorkerDaysPerRoom;
    math.push(`${contentsRooms} room${contentsRooms === 1 ? "" : "s"} with contents × ${C.contentsWorkerDaysPerRoom} worker-days = ${r2(contentsRooms * C.contentsWorkerDaysPerRoom)}`);
  }
  const phases: CrewPhase[] = [];
  const size = (phase: CrewPhase["phase"], wts: WorkType[], workerDays: number, mathL: string[], missingL: string[], areas: { containments: number; rooms: number }): CrewPhase => {
    const target = Math.max(...wts.map((w) => C.targetDays[w]), 1);
    if (missingL.length || !wts.length) return { phase, workTypes: wts, workerDays: null, targetDays: target, workers: null, crewChiefs: null, subs: null, total: null, math: mathL, missing: missingL.length ? missingL : ["no work lines"] };
    const workers = Math.max(1, Math.ceil(r2(workerDays / target)));
    const ccByArea = Math.max(areas.containments ? Math.ceil(areas.containments / C.containmentsPerCrewChief) : 0, Math.ceil(areas.rooms / C.roomsPerCrewChief));
    const cc = Math.max(1, ccByArea, Math.ceil(workers / C.maxCrewPerCrewChief));
    const multi = areas.rooms > 1 || areas.containments > 1;
    const subs = Math.max(workers - cc, multi ? C.minSubsMultiArea : 0);
    const m = [...mathL, `= ${r2(workerDays)} worker-days ÷ ${target} target day${target === 1 ? "" : "s"} (${wts.map((w) => WORK_TYPE_LABELS[w]).join(" + ")}) = ${workers} on site`];
    m.push(
      `crew chiefs: max(1, ${areas.containments ? `${areas.containments} containment${areas.containments === 1 ? "" : "s"} ÷ ${C.containmentsPerCrewChief}, ` : ""}${areas.rooms} room${areas.rooms === 1 ? "" : "s"} ÷ ${C.roomsPerCrewChief}, ${workers} people ÷ ${C.maxCrewPerCrewChief}) = ${cc}`,
    );
    m.push(`subs: ${workers} − ${cc} = ${workers - cc}${subs !== workers - cc ? ` → ${subs} (more than one room/containment: a crew chief never works it alone)` : ""}`);
    return { phase, workTypes: wts, workerDays: r2(workerDays), targetDays: target, workers, crewChiefs: cc, subs, total: cc + subs, math: m, missing: [] };
  };
  if (mitRooms.length) phases.push(size("Mitigation / remediation", [...types], wd, math, missing, { containments, rooms: mitRooms.length }));

  // ---- reconstruction phase (only when requested) ----
  if (o.reconstructionRequested) {
    const recRooms = rooms.filter((r) => r.analysis.lines.some((l) => live(l) && l.kind === "reconstruction"));
    if (recRooms.length) {
      let rwd = 0;
      const rm: string[] = [];
      const rmiss: string[] = [];
      for (const r of recRooms) {
        const sf = r.analysis.affectedFloorSF ?? r.analysis.takeoff.floorSF;
        if (sf == null) {
          rmiss.push(`${r.label}: area not measured`);
          continue;
        }
        rwd += sf / C.sfPerWorkerDay.reconstruction;
        rm.push(`${r.label}: ${r1(sf)} SF ÷ ${C.sfPerWorkerDay.reconstruction} SF per worker-day (reconstruction) = ${r2(sf / C.sfPerWorkerDay.reconstruction)} worker-days`);
      }
      phases.push(size("Reconstruction", ["reconstruction"], rwd, rm, rmiss, { containments: 0, rooms: recRooms.length }));
    }
  }

  // ---- sub trades indicated by scope lines (never guessed) ----
  const trades: { trade: string; why: string }[] = [];
  const addTrade = (trade: string, why: string) => {
    if (!trades.some((t) => t.trade === trade)) trades.push({ trade, why });
  };
  for (const r of rooms)
    for (const l of r.analysis.lines.filter(live)) {
      if (l.kind === "reconstruction" && !o.reconstructionRequested) continue;
      const text = `${l.activity} ${l.item}`;
      if (l.id.startsWith("cw.plumbing") || /\b(toilet|faucet|plumbing|water heater)\b/i.test(text)) addTrade("Plumber", `${r.label}: ${text}`);
      if (/\bHVAC\b|duct/i.test(`${text} ${l.flags.join(" ")}`)) addTrade("HVAC", `${r.label}: ${text}${/if not accessible|inaccessible/i.test(`${text} ${l.flags.join(" ")}`) ? " (only if not accessible)" : ""}`);
      if (/\b(electric\w*|outlets?|switch(es)?|wiring)\b/i.test(text)) addTrade("Electrician", `${r.label}: ${text}`);
    }

  const main = phases.filter((p) => p.total != null).sort((a, b) => b.total! - a.total!)[0] ?? null;
  const j = o.jobInfo;
  const confirmed =
    j.crewChiefs != null && j.subcontractors != null
      ? { crewChiefs: j.crewChiefs, subs: j.subcontractors, total: j.crewChiefs + j.subcontractors, trades: j.subTrades ?? [], label: crewLabel(j.crewChiefs, j.subcontractors) }
      : null;
  const proposed = main ? { crewChiefs: main.crewChiefs!, subs: main.subs!, total: main.total!, label: crewLabel(main.crewChiefs!, main.subs!) } : null;
  const derivable = !!proposed;
  return {
    phases,
    proposed,
    trades,
    confirmed,
    needsConfirmation: !confirmed,
    tradeOptions: C.trades,
    note: confirmed
      ? `Crew confirmed by the PM: ${confirmed.label}.`
      : derivable
        ? `Proposed ${proposed!.label} from the scope — accept or edit it.`
        : rooms.length
          ? `Crew can't be calculated yet (${phases.flatMap((p) => p.missing).join("; ") || "no work lines"}) — enter crew chiefs and subs (PM-confirmed).`
          : "No rooms scanned yet.",
  };
}

// ---------------------------------------------------------------------------
// Equipment schedule
// ---------------------------------------------------------------------------

export interface ScheduleRow {
  type: string;
  count: number | null;
  hoursPerUnit: number[];
  days: number[];
  equipmentDays: number | null;
  sources: string[];
  estimated: boolean;
  missing: boolean;
  basis: string[];
  startStop: string[];
}
export interface EquipmentSchedule {
  rows: ScheduleRow[];
  /** Days the equipment runs across the work (longest run), and the full span to clearance. */
  runDays: number | null;
  offBeforeClearanceHours: number | null;
  spanText: string | null;
  totalEquipmentDays: number | null;
  estimated: boolean;
  missing: boolean;
}

const TYPE_OF: Record<string, string> = {
  "mold.negair": "HEPA air scrubber / negative air",
  "equip.scrubber": "HEPA air scrubber",
  "mold.dehu": "Dehumidifier (containment)",
  "equip.airmovers": "Air movers",
};

export function equipmentSchedule(
  rooms: CrewRoom[],
  o: { waterDehu: { min: number; max: number; calc: string } | null; offBeforeClearanceHours: number | null; waterDryingDays: number | null },
): EquipmentSchedule {
  const map = new Map<string, ScheduleRow>();
  const row = (type: string) => {
    let r = map.get(type);
    if (!r) map.set(type, (r = { type, count: 0, hoursPerUnit: [], days: [], equipmentDays: 0, sources: [], estimated: false, missing: false, basis: [], startStop: [] }));
    return r;
  };
  for (const rm of rooms)
    for (const l of rm.analysis.lines) {
      if (l.kind !== "equipment" || !live(l)) continue;
      const r = row(TYPE_OF[l.id] ?? l.item);
      const d = l.duration;
      if (l.quantity == null) r.count = null;
      else if (r.count != null) r.count += l.quantity;
      if (d?.hours != null && !r.hoursPerUnit.includes(d.hours)) r.hoursPerUnit.push(d.hours);
      if (d?.days != null && !r.days.includes(d.days)) r.days.push(d.days);
      if (d?.equipmentDays == null) r.equipmentDays = null;
      else if (r.equipmentDays != null) r.equipmentDays = r2(r.equipmentDays + d.equipmentDays);
      const src = d?.source ?? "missing";
      if (!r.sources.includes(src)) r.sources.push(src);
      if (!d || d.hours == null) r.missing = true;
      if (d?.estimated) r.estimated = true;
      const b = `${rm.label}: ${l.quantity ?? "?"} × ${d?.hours ?? "?"} h${d?.days != null ? ` (${d.days} day${d.days === 1 ? "" : "s"})` : ""} = ${d?.equipmentDays ?? "?"} equipment-days — ${d?.basis ?? "no duration"}`;
      r.basis.push(b);
      if (d?.startStop && !r.startStop.includes(d.startStop)) r.startStop.push(d.startStop);
    }
  if (o.waterDehu) {
    const r = row("Dehumidifiers (water drying)");
    const days = o.waterDryingDays;
    r.count = o.waterDehu.max;
    if (days != null) {
      r.hoursPerUnit.push(days * 24);
      r.days.push(days);
      r.equipmentDays = r2(o.waterDehu.max * days);
      r.sources.push("rule");
      r.basis.push(`${o.waterDehu.calc} — up to ${o.waterDehu.max} × ${days} days = ${r.equipmentDays} equipment-days (the drying days of the wet rooms, estimated until readings confirm dry)`);
      r.startStop.push("Start at setup; stop when every moisture point meets its dry goal.");
    } else {
      r.equipmentDays = null;
      r.missing = true;
      r.sources.push("missing");
      r.basis.push(`${o.waterDehu.calc} — drying days not set`);
    }
    r.estimated = true;
  }
  const rows = [...map.values()];
  const allDays = rows.flatMap((r) => r.days);
  const runDays = allDays.length ? Math.max(...allDays) : null;
  const offDays = o.offBeforeClearanceHours != null ? r2(o.offBeforeClearanceHours / 24) : null;
  const total = rows.length && rows.every((r) => r.equipmentDays != null) ? r2(rows.reduce((a, r) => a + (r.equipmentDays ?? 0), 0)) : null;
  return {
    rows,
    runDays,
    offBeforeClearanceHours: o.offBeforeClearanceHours,
    spanText:
      runDays == null
        ? null
        : offDays != null
          ? `Equipment runs ${runDays} day${runDays === 1 ? "" : "s"}; shut down ${o.offBeforeClearanceHours} h (${offDays} day${offDays === 1 ? "" : "s"}) before the clearance inspection → ${r2(runDays + offDays)} days from setup to clearance`
          : `Equipment runs up to ${runDays} day${runDays === 1 ? "" : "s"} across the work`,
    totalEquipmentDays: total,
    estimated: rows.some((r) => r.estimated),
    missing: rows.some((r) => r.missing),
  };
}

export function scheduleText(s: EquipmentSchedule): string[] {
  if (!s.rows.length) return [];
  const out = ["EQUIPMENT SCHEDULE (how long equipment runs)"];
  for (const r of s.rows) {
    const h = r.hoursPerUnit.length ? r.hoursPerUnit.map((x) => `${x} h`).join(" / ") : "run time not set";
    const d = r.days.length ? r.days.map((x) => `${x} day${x === 1 ? "" : "s"}`).join(" / ") : "—";
    out.push(`• ${r.type}: ${r.count ?? "?"} unit${r.count === 1 ? "" : "s"} × ${h} (${d}) = ${r.equipmentDays ?? "?"} equipment-days${r.missing ? " ⚑ duration missing" : r.estimated ? " (estimated)" : ""}`);
    for (const ss of r.startStop) out.push(`   ${ss}`);
  }
  if (s.spanText) out.push(s.spanText + ".");
  if (s.totalEquipmentDays != null) out.push(`Total: ${s.totalEquipmentDays} equipment-days.`);
  return out;
}

export function crewText(c: CrewPlan): string[] {
  const out = ["CREW"];
  if (c.confirmed) {
    out.push(`Crew chiefs: ${c.confirmed.crewChiefs} · Subs: ${c.confirmed.subs}${c.confirmed.trades.length ? ` (${c.confirmed.trades.join(", ")})` : ""} · Total: ${c.confirmed.total} (${c.confirmed.label}) — confirmed by the PM`);
  } else if (c.proposed) {
    out.push(`Crew chiefs: ${c.proposed.crewChiefs} · Subs: ${c.proposed.subs} · Total: ${c.proposed.total} (${c.proposed.label}) — PROPOSED, needs PM confirmation`);
  } else out.push(`⚑ ${c.note}`);
  for (const p of c.phases) out.push(`${p.phase}: ${p.total != null ? `${p.crewChiefs} CC + ${p.subs} subs over ${p.targetDays} day${p.targetDays === 1 ? "" : "s"}` : `not calculated (${p.missing.join("; ")})`}`);
  if (c.trades.length) out.push(`Sub trades indicated by the scope: ${c.trades.map((t) => t.trade).join(", ")}`);
  return out;
}
