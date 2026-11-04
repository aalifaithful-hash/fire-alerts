import type { RoomScanData } from "../scan";
import { findingText, type Finding, type ReportFindings } from "./types";

/**
 * Report → scope. From the findings, propose changes to one room scan (each with the quote it
 * comes from). Changes that would overwrite something the PM entered are marked as conflicts,
 * shown as mismatch warnings and are OFF by default — nothing is silently overwritten. Applying
 * re-runs the room rules, so the lines come back as "suggested" for the PM to accept.
 */

export interface ReportChange {
  key: string;
  label: string;
  current: string | null;
  proposed: string;
  quote: string;
  page: number;
  /** Would replace something the PM entered with a different value. */
  conflict: boolean;
}

export interface RoomTarget {
  roomLabel: string; // e.g. "Unit 4D — Affected area (room TBD)"
  roomName: string; // location.room
  scan: RoomScanData;
  yearBuilt: number | null;
}

const ft = (n: number | null | undefined) => (n == null ? "—" : `${n}`);
const eq = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Math.abs(a - b) < 0.05;

export function proposeChanges(f: ReportFindings, t: RoomTarget): { changes: ReportChange[]; mismatches: string[] } {
  const changes: ReportChange[] = [];
  const mismatches: string[] = [];
  const s = t.scan;
  const m = s.materials;
  const add = (key: string, label: string, current: string | null, proposed: string, src: Finding<unknown>, conflict = false) =>
    changes.push({ key, label, current, proposed, quote: src.quote, page: src.page, conflict });

  if (f.room) {
    const tbd = /room TBD/i.test(t.roomName) || !t.roomName.trim();
    const same = t.roomName.toLowerCase().includes(f.room.value.toLowerCase());
    if (!same) {
      add("room.name", "Room name", t.roomName, f.room.value, f.room, !tbd);
      if (!tbd) mismatches.push(`Different room: the report is for the ${f.room.value}; this scan is "${t.roomName}".`);
    }
  }
  if (f.dims) {
    const me = s.measurements;
    const has = me.lengthFt != null || me.widthFt != null;
    const same = (eq(me.lengthFt, f.dims.value.lengthFt) && eq(me.widthFt, f.dims.value.widthFt)) || (eq(me.lengthFt, f.dims.value.widthFt) && eq(me.widthFt, f.dims.value.lengthFt));
    const hSame = f.dims.value.heightFt == null || eq(me.heightFt, f.dims.value.heightFt);
    if (!same || !hSame) {
      const conflict = has && !same;
      add(
        "measurements",
        "Room measurements",
        has || me.heightFt ? `${ft(me.lengthFt)} × ${ft(me.widthFt)} ft${me.heightFt ? `, ${me.heightFt} ft ceiling` : ""}` : null,
        findingText("dims", f)!,
        f.dims,
        conflict || (me.heightFt != null && !hSame),
      );
      if (conflict) mismatches.push(`Different area: you entered ${ft(me.lengthFt)} × ${ft(me.widthFt)} ft; the report says ${f.dims.value.lengthFt} × ${f.dims.value.widthFt} ft.`);
    }
  }
  if (f.floorCoverage || f.affectedAreaSF) {
    const dims = f.dims?.value ?? (s.measurements.lengthFt && s.measurements.widthFt ? { lengthFt: s.measurements.lengthFt, widthFt: s.measurements.widthFt } : null);
    let pct: number | null = f.floorCoverage?.value.whole ? 100 : (f.floorCoverage?.value.pct ?? null);
    if (pct == null && f.affectedAreaSF && dims) pct = Math.min(100, Math.round((f.affectedAreaSF.value / (dims.lengthFt * dims.widthFt)) * 100));
    const src = (f.floorCoverage ?? f.affectedAreaSF)!;
    if (pct != null && (m.flooring.affectedPct ?? null) !== pct) {
      const conflict = m.flooring.affectedPct != null;
      add("floor.pct", "Part of the floor with growth", m.flooring.affectedPct != null ? `${m.flooring.affectedPct}%` : null, `${pct}%${pct === 100 ? " (whole floor)" : ""}`, src, conflict);
      if (conflict) mismatches.push(`Different extent: you entered ${m.flooring.affectedPct}% of the floor; the report says ${pct === 100 ? "the whole floor" : `${pct}%`}.`);
    }
    if (!m.flooring.affected) add("floor.affected", "Flooring affected", "No", "Yes", src);
    if (f.affectedAreaSF && dims && pct != null) {
      const calc = Math.round(dims.lengthFt * dims.widthFt * (pct / 100) * 10) / 10;
      if (Math.abs(calc - f.affectedAreaSF.value) > Math.max(2, calc * 0.1))
        mismatches.push(`Affected area: the report states ${f.affectedAreaSF.value} SF but ${dims.lengthFt} × ${dims.widthFt} ft × ${pct}% = ${calc} SF — confirm which is right.`);
    }
  }
  if (f.subfloor && m.subfloor !== f.subfloor.value) {
    add("subfloor", "Subfloor", m.subfloor ? (m.subfloor === "remove" ? "Remove" : "Clean") : null, f.subfloor.value === "remove" ? "Remove" : "Clean and treat (stays)", f.subfloor, m.subfloor != null);
    if (m.subfloor) mismatches.push(`Subfloor: you have "${m.subfloor}", the report says "${f.subfloor.value}".`);
  }
  if (f.sourceFixed) {
    const want = f.sourceFixed.value ? "repaired" : "active";
    if (s.source.status !== want) {
      const conflict = s.source.status !== "unknown";
      add("source.status", "Moisture source status", s.source.status === "unknown" ? null : s.source.status, f.sourceFixed.value ? "Repaired" : "Active (not fixed)", f.sourceFixed, conflict);
      if (conflict) mismatches.push(`Source: you have "${s.source.status}", the report says it is ${f.sourceFixed.value ? "repaired" : "not fixed"}.`);
    }
  }
  if (f.moistureSource && !s.source.fixture) add("source.fixture", "Moisture source", null, f.moistureSource.value, f.moistureSource);
  if (f.yearBuilt && t.yearBuilt !== f.yearBuilt.value) {
    add("yearBuilt", "Year built", t.yearBuilt != null ? String(t.yearBuilt) : null, String(f.yearBuilt.value), f.yearBuilt, t.yearBuilt != null);
    if (t.yearBuilt != null) mismatches.push(`Year built: the property says ${t.yearBuilt}; the report says ${f.yearBuilt.value}.`);
  }
  if (f.flooringContinuous && !f.flooringContinuous.value.continues && !m.flooring.breakNote)
    add("floor.break", "Flooring run", null, "Stops at a break (no other rooms)", f.flooringContinuous);
  if (f.flooringContinuous?.value.continues && !m.flooring.continuousRun)
    mismatches.push(`The report says the flooring continues${f.flooringContinuous.value.rooms.length ? ` into ${f.flooringContinuous.value.rooms.join(", ")}` : " into other rooms"} — add those rooms with the same run name.`);
  if (f.wallsGrowth?.value.growth && !m.walls.affectedWalls.length)
    mismatches.push(`The report finds growth on walls${f.wallsGrowth.value.walls.length ? ` (${f.wallsGrowth.value.walls.join(", ")})` : ""} — not in this scan. Mark the walls and the removal height in step 3.`);
  if (f.framingGrowth?.value) mismatches.push("The report finds growth on framing — add framing cleaning/treatment; it is not in the scan rules yet.");
  return { changes, mismatches };
}

/** Applies the chosen changes (always marks the report received and links it). Returns the new scan + side changes. */
export function applyChanges(f: ReportFindings, t: RoomTarget, keys: string[], documentId: string) {
  const scan: RoomScanData = structuredClone(t.scan);
  const pick = new Set(keys);
  let roomName: string | null = null;
  let yearBuilt: number | null = null;
  if (pick.has("room.name") && f.room) roomName = f.room.value;
  if (pick.has("measurements") && f.dims) {
    scan.measurements.lengthFt = f.dims.value.lengthFt;
    scan.measurements.widthFt = f.dims.value.widthFt;
    if (f.dims.value.heightFt != null) scan.measurements.heightFt = f.dims.value.heightFt;
  }
  if (pick.has("floor.pct")) {
    const c = proposeChanges(f, t).changes.find((x) => x.key === "floor.pct");
    const n = c ? Number(c.proposed.match(/\d+/)?.[0]) : NaN;
    if (Number.isFinite(n)) scan.materials.flooring.affectedPct = n;
  }
  if (pick.has("floor.affected")) scan.materials.flooring.affected = true;
  if (pick.has("subfloor") && f.subfloor) scan.materials.subfloor = f.subfloor.value;
  if (pick.has("source.status") && f.sourceFixed) scan.source.status = f.sourceFixed.value ? "repaired" : "active";
  if (pick.has("source.fixture") && f.moistureSource) scan.source.fixture = f.moistureSource.value.slice(0, 200);
  if (pick.has("floor.break") && f.flooringContinuous) scan.materials.flooring.breakNote = `Report: ${f.flooringContinuous.quote}`.slice(0, 200);
  if (pick.has("yearBuilt") && f.yearBuilt) yearBuilt = f.yearBuilt.value;
  if (scan.loss.type == null) scan.loss.type = "mold";
  scan.loss.assessmentReport = "received";
  scan.reportDocumentId = documentId;
  return { scan, roomName, yearBuilt };
}

/** The four "pending the mold report" items: what the report answers and what is still missing. */
export function stillMissing(f: ReportFindings, ctx: { yearBuiltKnown: boolean; runKnown: boolean }): string[] {
  const out: string[] = [];
  if (!f.affectedAreaSF && !(f.floorCoverage && f.dims)) out.push("Affected area and extent (SF) — sets every removal and cleaning quantity");
  const cr = [!f.containment && "containment level", !f.removalExtent && "how far removal goes"].filter(Boolean);
  if (cr.length) out.push(`Remediation plan: ${cr.join(" and ")}`);
  const gr = [!f.subfloor && "whether the subfloor is cleaned or removed", !f.wallsGrowth && "growth on walls", !f.baseboardBacksGrowth && "growth on baseboard backs", !f.framingGrowth && "growth on framing"].filter(Boolean);
  if (gr.length) out.push(`Not stated in the report: ${gr.join(", ")}`);
  const cl = [!f.clearanceCriteria && "clearance criteria", !f.clearanceBy && "who performs the post-remediation verification"].filter(Boolean);
  if (cl.length) {
    const said = f.unanswered.find((u) => u.key === "clearanceCriteria" && u.quote)?.quote;
    out.push(`${cl.join(" and ").replace(/^./, (c) => c.toUpperCase())}${said ? ` (report: “${said}”)` : " — not in the report"}`);
  }
  if (!f.sourceFixed) out.push("Whether the moisture source is fixed — not in the report");
  if (!f.yearBuilt && !ctx.yearBuiltKnown) out.push("Year built — not in the report (lead/asbestos check before demolition)");
  if (!f.flooringContinuous && !ctx.runKnown) out.push("Whether the wood flooring runs into other rooms — not in the report");
  return out;
}

/** Report quotes appended to the justification of the lines they support. */
export function reportJustifications(f: ReportFindings, measured: { lengthFt: number | null; widthFt: number | null }, room: string): Record<string, string> {
  const j: Record<string, string> = {};
  const q = (x: Finding<unknown> | null) => (x ? `“${x.quote}”` : "");
  if (f.floorCoverage || f.affectedAreaSF) {
    const dims = measured.lengthFt && measured.widthFt ? `${measured.lengthFt} × ${measured.widthFt} ft ` : "";
    const what = f.floorCoverage?.value.whole ? `growth across the full ${dims}${room.toLowerCase()} floor` : `growth on part of the ${room.toLowerCase()} floor`;
    j["mold.floor.remove"] = `Report states ${what}${f.affectedAreaSF ? ` (${f.affectedAreaSF.value} SF)` : ""}: ${q(f.floorCoverage ?? f.affectedAreaSF)}`;
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
  if (f.baseboardBacksGrowth?.value.growth) j["baseboard"] = `Report: ${q(f.baseboardBacksGrowth)} — discard that baseboard.`;
  if (f.clearanceCriteria || f.clearanceBy) j["mold.pcv"] = `Report: ${q(f.clearanceCriteria ?? f.clearanceBy)}`;
  else {
    const said = f.unanswered.find((u) => u.key === "clearanceCriteria" && u.quote)?.quote;
    if (said) j["mold.pcv"] = `Report: “${said}” — criteria and who performs it still to be set.`;
  }
  return j;
}
