import type { Rules } from "./defaults";
import { CASEWORK_ACTION_LABELS, type Exclusion, type RoomScanData, type ScopeLine } from "./scan";
import { baseboardLF, floodCutSF, r1, takeoff, wallPaintSF, type Takeoff } from "./takeoff";
import { reportJustifications, stillMissing } from "./report/match";
import { caseworkLines } from "./casework";
import type { ReportFindings } from "./report/types";

/**
 * Room analysis (no AI). From what the PM recorded about one room — where the
 * loss is, what is affected, the measurements — propose the scope lines that
 * go with it, each with its quantity math and justification. Nothing is
 * accepted automatically: every line starts as "suggested" unless the PM
 * already decided it. Excluded work is marked "excluded", never dropped.
 */

export interface RoomContext {
  rules: Rules;
  roomLabel: string;
  /** Other rooms in this visit that share this room's continuous flooring run. */
  run: { roomLabel: string; floorSF: number | null; replace: boolean }[];
  exclusions: Exclusion[]; // already filtered to this visit
  locationId: string;
  reconstructionRequested: boolean;
  yearBuilt: number | null;
  /** The visit's kind of work — sets the room's loss type when the PM hasn't (e.g. a mold visit → mold). */
  visitServiceLine?: string | null;
  /** Findings of the mold report applied to this room (rules analyzer output). */
  report?: ReportFindings | null;
  /** The visit's crew (for per-worker-per-day lines such as PPE). people = null until the PM confirms the crew. */
  crew?: { people: number | null; label: string | null; days: number; daysBasis: string; ppeRoom: string | null };
}

export interface RoomAnalysis {
  lines: ScopeLine[];
  questions: string[];
  notes: string[];
  takeoff: Takeoff;
  airMovers: { min: number; max: number; recommended: number; calc: string } | null;
  affectedFloorSF: number | null;
  /** Wet floor area for water-drying equipment (dehumidifier sizing). Null for mold, fire and smoke rooms. */
  dryingSF: number | null;
  /** What can't be finalized until an outside document arrives (e.g. the mold assessment report). */
  pending: string[];
}

type Draft = Omit<ScopeLine, "status" | "rate" | "total" | "evidence" | "flags" | "source" | "duration"> & { flags?: string[]; evidence?: string[]; duration?: ScopeLine["duration"] };

const isDemo = (l: Draft) => /^(Remove|Flood cut|Tear out)/i.test(l.activity);

/** Whether this room's flooring is being replaced (as the rules will see it) — used to propagate continuous runs. */
export function floorReplaceEffective(scan: RoomScanData, rules: Rules, visitServiceLine: string | null = null): boolean {
  const f = scan.materials.flooring;
  if (f.action === "replace") return true;
  if (/carpet|pad/i.test(f.type ?? "") && scan.loss.category === "3") return true;
  const mold = scan.loss.type === "mold" || (scan.loss.type == null && visitServiceLine === "mold");
  return mold && f.affected && f.action == null && !!f.type && rules.mold.removeWhenGrowth.some((k) => f.type!.toLowerCase().includes(k));
}

export function cutHeight(wetIn: number, category: "1" | "2" | "3" | null, rules: Rules): { cutIn: number; calc: string } {
  const fc = rules.floodCut;
  const low = category === "1" && wetIn <= fc.cat1LowWickingMaxWetIn;
  const margin = low ? fc.cat1LowWickingMarginIn : fc.marginAboveWetIn;
  const raw = wetIn + margin;
  const stops = [...fc.sheetStopsIn].sort((a, b) => a - b);
  const cut = fc.roundToSheetStops ? (stops.find((s) => s >= raw) ?? stops[stops.length - 1] ?? raw) : raw;
  return {
    cutIn: cut,
    calc: `wet ${wetIn}" + ${margin}" ${low ? "(Cat 1 low wicking)" : "margin"} = ${raw}"${cut !== raw ? ` → ${cut}" (sheet stop)` : ""}`,
  };
}

export function airMoverCalc(wetFloorSF: number, rules: Rules) {
  const { airMoverSqFtMin: lo, airMoverSqFtMax: hi } = rules.equipment;
  const min = Math.max(1, Math.ceil(wetFloorSF / hi));
  const max = Math.max(1, Math.ceil(wetFloorSF / lo));
  const recommended = Math.max(1, Math.ceil(wetFloorSF / ((lo + hi) / 2)));
  return { min, max, recommended, calc: `${r1(wetFloorSF)} SF wet floor ÷ ${lo}–${hi} SF per air mover = ${min}–${max} (suggest ${recommended})` };
}

export function dehuCalc(affectedSF: number, rules: Rules) {
  const { dehuSqFtMin: lo, dehuSqFtMax: hi, dehuDescription } = rules.equipment;
  const min = Math.max(1, Math.ceil(affectedSF / hi));
  const max = Math.max(1, Math.ceil(affectedSF / lo));
  return { min, max, calc: `${r1(affectedSF)} SF affected ÷ ${lo}–${hi} SF per dehumidifier = ${min}–${max} × ${dehuDescription} (per drying chamber)` };
}

export function analyzeRoom(scanIn: RoomScanData, ctx: RoomContext): RoomAnalysis {
  const R = ctx.rules;
  const inherited = scanIn.loss.type == null && ctx.visitServiceLine === "mold";
  const scan: RoomScanData = inherited ? { ...scanIn, loss: { ...scanIn.loss, type: "mold" } } : scanIn;
  const t = takeoff(scan.measurements);
  const mold = scan.loss.type === "mold";
  const MR = R.mold;
  const growthRemove = (name: string | null) => !!name && MR.removeWhenGrowth.some((k) => name.toLowerCase().includes(k));
  const assumed: string[] = [];
  // Mold defaults the PM didn't set (shown as "assumed" so they can be changed in the scan):
  // porous/semi-porous flooring with growth is removed (and later replaced); baseboard comes off with it.
  const m = structuredClone(scan.materials);
  if (mold && m.flooring.affected && m.flooring.action == null && m.flooring.choice !== "remove_or_sand" && growthRemove(m.flooring.type)) {
    m.flooring.action = "replace";
    assumed.push(`${m.flooring.type} flooring with growth is removed, not cleaned (S520) and replaced later — change "Flooring action" if the assessor says otherwise.`);
  }
  if (mold && m.framing.growth && m.framing.where === "joists" && m.subfloor == null) {
    m.subfloor = "remove";
    assumed.push("Subfloor removed — the floor joists with growth can't be reached or cleaned through it.");
  }
  const moldFloorOut = mold && m.flooring.affected && (m.flooring.action === "remove" || m.flooring.action === "replace");
  if (moldFloorOut && MR.removeBaseboardWithFlooring && !m.baseboard.affected) {
    const all = t.walls.length ? t.walls.map((w) => w.label) : ["N", "E", "S", "W"];
    m.baseboard = { affected: true, walls: (m.flooring.affectedPct ?? 100) >= 100 ? all : [], action: "remove" };
    assumed.push(`Baseboard removed${m.baseboard.walls.length ? ` on all walls (${all.join(", ")})` : ""} to take up the flooring; wood baseboard in contact with growth is discarded.`);
  }
  const cat = scan.loss.category;
  const water = scan.loss.type === "water" || scan.loss.type === "sewage" || (scan.loss.type == null && scan.source.waterSource != null);
  const fireSmoke = scan.loss.type === "fire" || scan.loss.type === "smoke";
  const drafts: Draft[] = [];
  const questions: string[] = [];
  const notes: string[] = [];
  const add = (d: Draft) => drafts.push(d);
  const room = ctx.roomLabel;

  // ---------------- measurements & basics ----------------
  // Rooms where nothing depends on the size (a vent clean, a caulk re-seal) don't ask for measurements.
  const sizeMatters = !(scan.loss.type === "mold" && scan.containmentArea?.none && !scan.materials.flooring.affected && !scan.materials.walls.affectedWalls.length && !scan.materials.ceiling.affected);
  if (!sizeMatters) {
    /* nothing to measure */
  } else if (!t.floorSF && !t.heightFt) questions.push(`${room}: measure length, width and ceiling height — quantities stay blank until measured.`);
  else if (!t.floorSF) questions.push(`${room}: enter length and width — quantities stay blank until measured.`);
  else if (!t.heightFt) questions.push(`${room}: enter ceiling height for wall and paint quantities.`);
  if (/room TBD/i.test(room)) questions.push(`${room}: which room is this? (rename it in Rooms — the scope prints the room name)`);
  if (mold && scan.source.status !== "repaired")
    questions.push(`${room}: what moisture source caused the growth, and is it corrected? Remediation without fixing the source fails clearance.`);
  else if (scan.source.status === "unknown") questions.push(`${room}: is the source stopped or repaired?`);
  if (water && !cat) questions.push(`${room}: which water category (1, 2 or 3)? It is only set from your confirmation.`);

  // ---------------- category-change flag (never changes the category itself) ----------------
  const cc = R.categoryChange;
  const src = scan.source.waterSource;
  if (water && src) {
    if (cc.alwaysCat3Sources.includes(src) && cat !== "3") notes.push(`⚑ Source "${src.replace(/_/g, " ")}" is normally Category 3 — confirm the category.`);
    else if (cc.alwaysAtLeastCat2Sources.includes(src) && cat === "1") notes.push(`⚑ Source "${src.replace(/_/g, " ")}" is normally at least Category 2 — confirm the category.`);
  }
  const hrs = scan.source.hoursSinceLoss;
  if (water && hrs != null) {
    if (cat === "1" && hrs > cc.cleanToGrayAfterHours) notes.push(`⚑ ${hrs} h since loss: clean water can degrade to Category 2 after ~${cc.cleanToGrayAfterHours} h (S500) — confirm.`);
    if ((cat === "1" || cat === "2") && hrs > cc.grayToBlackAfterHours) notes.push(`⚑ ${hrs} h since loss: may have degraded to Category 3 after ~${cc.grayToBlackAfterHours} h — confirm.`);
  }

  // ---------------- baseboard & walls (set up first: flooring rules need to know which base is replaced) ----------------
  const affectedWalls = t.walls.filter((w) => m.walls.affectedWalls.includes(w.label));
  const bbWallLabels = m.baseboard.walls.length ? m.baseboard.walls : m.walls.affectedWalls;
  const bbWalls = t.walls.filter((w) => bbWallLabels.includes(w.label));
  if (m.baseboard.affected && !bbWallLabels.length) questions.push(`${room}: which walls' baseboard is affected?`);
  const bbAction = m.baseboard.action ?? (cat === "2" || cat === "3" ? "remove" : "detach_reset");
  /** wall label → why it gets the full-wall seal/prime & paint (the paint quantity is always that wall's full SF). */
  const paintWalls = new Map<string, string[]>();
  const paintWall = (w: string, why: string) => paintWalls.set(w, [...(paintWalls.get(w) ?? []), why]);
  const bbRemovedWalls = new Set<string>(m.baseboard.affected && bbAction === "remove" ? bbWallLabels : []);

  // ---------------- flooring ----------------
  // Mold: the extent comes from the PM or the report — never assumed to be the whole floor.
  const pct: number | null = m.flooring.affectedPct ?? (m.flooring.affected ? (mold ? null : 100) : 0);
  const affFloorSF = t.floorSF != null && m.flooring.affected && pct != null ? r1((t.floorSF * pct) / 100) : null;
  const floorCalc =
    t.floorSF == null ? "floor not measured" : pct == null ? `${t.floorCalc} — extent not confirmed (whole floor or part?)` : `${t.floorCalc}${pct !== 100 ? ` × ${pct}% = ${affFloorSF} SF` : ""}`;
  const ftype = (m.flooring.type ?? "").toLowerCase();
  if (m.flooring.type && /wood|laminate|parquet/i.test(m.flooring.type) && !/floor/i.test(m.flooring.type)) m.flooring.type = `${m.flooring.type} flooring`;
  const porousFloor = /carpet|pad|rug/.test(ftype);
  if (water && m.flooring.affected) {
    add({ id: "extract", ruleId: "water.extract", kind: "mitigation", scopeCategory: "extraction", activity: "Extract", item: `water from ${m.flooring.type || "flooring"}`, quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: `Saturated ${m.flooring.type || "flooring"}${scan.source.fixture ? ` from ${scan.source.fixture}` : ""}.` });
    if (porousFloor && cat === "2")
      add({ id: "pad.remove", ruleId: "water.cat2.porous", kind: "mitigation", scopeCategory: "removal", activity: "Remove", item: "carpet pad (porous, in contact)", quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: "Category 2: porous materials in contact are removed (default rule)." });
    if (porousFloor && cat === "3")
      add({ id: "carpet.remove", ruleId: "water.cat3.porous", kind: "mitigation", scopeCategory: "removal", activity: "Remove", item: "carpet and pad (porous, in contact)", quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: "Category 3: porous materials in contact are removed (default rule)." });
    if (!porousFloor && (m.flooring.action === "remove" || m.flooring.action === "replace"))
      add({ id: "floor.remove", ruleId: "flooring.remove", kind: "mitigation", scopeCategory: "removal", activity: "Remove", item: `${m.flooring.type || "flooring"}`, quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: `${m.flooring.type || "Flooring"} not restorable in place (PM decision).` });
  }
  if (fireSmoke && m.flooring.affected)
    add({ id: "floor.clean", ruleId: "smoke.clean.floor", kind: "mitigation", scopeCategory: "cleaning", activity: "Clean", item: `${m.flooring.type || "floor"} — ${smokeMethod(scan, R)}`, quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: "Smoke/soot residue on flooring." });

  // continuous flooring run: replacement goes to the natural break
  const thisReplace = m.flooring.action === "replace" || (porousFloor && cat === "3");
  const runReplace = thisReplace || ctx.run.some((r) => r.replace);
  if (m.flooring.action === "replace" && !m.flooring.continuousRun && !m.flooring.breakNote)
    questions.push(`${room}: does this ${m.flooring.type || "flooring"} continue into other rooms without a natural break? Give the run a name (e.g. "A") in each room it covers.`);
  if (runReplace && R.whatGoesWithIt.flooringReplacement.enabled && (thisReplace || (m.flooring.continuousRun && R.whatGoesWithIt.flooringReplacement.fullContinuousRun))) {
    const others = ctx.run.filter((r) => r.roomLabel !== room);
    const runTotal = [t.floorSF, ...others.map((o) => o.floorSF)].reduce<number | null>((a, b) => (a == null || b == null ? null : a + b), 0);
    add({
      id: "floor.replace",
      ruleId: "whatGoesWithIt.flooringReplacement",
      kind: "reconstruction",
      scopeCategory: "replacement",
      activity: "Replace",
      item: `${m.flooring.type || "flooring"} — full continuous run to natural break`,
      quantity: t.floorSF,
      unit: "SF",
      calc: `${t.floorCalc}${m.flooring.continuousRun && others.length ? `; run ${m.flooring.continuousRun} total ${runTotal == null ? "(some rooms not measured)" : `${r1(runTotal)} SF`} incl. ${others.map((o) => o.roomLabel).join(", ")}` : ""}`,
      justification: thisReplace
        ? `Flooring not restorable; replaced to the natural break${m.flooring.breakNote ? ` (${m.flooring.breakNote})` : ""}.`
        : `Continuous with ${others.filter((o) => o.replace).map((o) => o.roomLabel).join(", ")} (run ${m.flooring.continuousRun}) — no natural break, so the full run is replaced.`,
    });
    if (!thisReplace && !(water && m.flooring.affected))
      add({ id: "floor.run.remove", ruleId: "whatGoesWithIt.flooringReplacement", kind: "reconstruction", scopeCategory: "removal", activity: "Remove", item: `${m.flooring.type || "flooring"} for the continuous replacement (no growth/damage in this room)`, quantity: t.floorSF, unit: "SF", calc: t.floorCalc, justification: `Continuous with ${others.filter((o) => o.replace).map((o) => o.roomLabel).join(", ") || "the replaced rooms"} — no natural break, so this room's flooring comes up for the replacement.` });
    if (R.whatGoesWithIt.flooringReplacement.reinstallBaseAndTransitions) {
      const resetWalls = t.walls.filter((w) => !bbRemovedWalls.has(w.label));
      if (resetWalls.length) {
        const parts = resetWalls.map(baseboardLF);
        if (R.whatGoesWithIt.baseboardDetachReset.sealPrimePaintFullWall) resetWalls.forEach((w) => paintWall(w.label, "baseboard detached & reset for the flooring"));
        add({ id: "floor.baseboard.reset", ruleId: "whatGoesWithIt.flooringReplacement", kind: "reconstruction", scopeCategory: "detach_reset", activity: "Detach & reset", item: `baseboard for flooring replacement (${resetWalls.map((w) => w.label).join(", ")})`, quantity: r1(parts.reduce((a, p) => a + p.lf, 0)), unit: "LF", calc: parts.map((p) => p.calc).join("; "), justification: `Baseboard comes off to replace the flooring and is reset after${bbRemovedWalls.size ? ` (walls ${[...bbRemovedWalls].join(", ")} get new baseboard instead)` : ""}. Measured in LF along the walls, not floor SF.` });
      } else if (!t.walls.length && t.floorSF) questions.push(`${room}: measure the walls — baseboard has to be detached and reset for the flooring replacement.`);
      const doors = scan.measurements.openings.filter((o) => o.kind !== "window").length;
      add({ id: "floor.transitions", ruleId: "whatGoesWithIt.flooringReplacement", kind: "reconstruction", scopeCategory: "finish", activity: "Reinstall", item: "transitions / thresholds at openings", quantity: doors || null, unit: "EA", calc: doors ? `${doors} door/opening(s) recorded` : "no openings recorded", justification: "Goes with flooring replacement." });
    }
    for (const fx of m.fixtures.filter((f) => R.whatGoesWithIt.flooringReplacement.detachResetFixtures.some((d) => f.toLowerCase().includes(d))))
      add({ id: `fixture.reset:${fx}`, ruleId: "whatGoesWithIt.flooringReplacement", kind: "reconstruction", scopeCategory: "detach_reset", activity: "Detach & reset", item: fx, quantity: 1, unit: "EA", calc: "1 per fixture on the replaced floor", justification: "Fixture sits on the flooring being replaced." });
  }

  // ---------------- walls: baseboard, flood cut, insulation ----------------
  if (m.baseboard.affected && bbWallLabels.length) {
    const parts = bbWalls.map(baseboardLF);
    const lf = bbWalls.length ? r1(parts.reduce((a, p) => a + p.lf, 0)) : null;
    const calc = parts.length ? parts.map((p) => p.calc).join("; ") : "walls not measured";
    add({ id: "baseboard", ruleId: "baseboard", kind: "mitigation", scopeCategory: bbAction === "remove" ? "removal" : "detach_reset", activity: bbAction === "remove" ? "Remove" : "Detach & reset", item: `baseboard (${bbWallLabels.join(", ")})`, quantity: lf, unit: "LF", calc, justification: bbAction === "remove" ? (moldFloorOut ? "Removed to take up the flooring with growth; wood baseboard in contact with growth is discarded (inspect the backs)." : `Category ${cat ?? "?"} contact / wet baseboard — removed for drying access.`) : "Detached for drying access behind it; reset after drying." });
    // Removing baseboard disturbs the wall finish along its whole length. What goes with it is new
    // baseboard (LF, same walls) and seal/prime + paint of the FULL continuous wall (wall SF) —
    // never a "paint baseboard" line, and never paint measured in baseboard LF or floor SF.
    if (bbAction === "detach_reset" && R.whatGoesWithIt.baseboardDetachReset.sealPrimePaintFullWall) bbWallLabels.forEach((w) => paintWall(w, "baseboard detached & reset"));
    if (bbAction === "remove" && R.whatGoesWithIt.baseboardRemoval.enabled) {
      if (R.whatGoesWithIt.baseboardRemoval.replaceBaseboard)
        add({ id: "baseboard.replace", ruleId: "whatGoesWithIt.baseboardRemoval", kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: `baseboard (${bbWallLabels.join(", ")})`, quantity: lf, unit: "LF", calc, justification: "New baseboard where it was removed (same walls, same LF). Its finish is covered by the full-wall seal/prime & paint line." });
      if (R.whatGoesWithIt.baseboardRemoval.sealPrimePaintFullWall) bbWallLabels.forEach((w) => paintWall(w, "baseboard removed"));
    }
  }

  const wet = m.walls.wetHeightIn;
  const drywall = m.walls.material === "drywall";
  if (mold && m.walls.affectedWalls.length) {
    const fcNoBase = m.walls.affectedWalls.filter((w) => !bbRemovedWalls.has(w));
    if (m.walls.material === "plaster") questions.push(`${room}: plaster walls with growth — clean in place or remove? (the assessor's plan decides)`);
    else {
      const explicit = typeof m.walls.floodCut === "number";
      const stated = m.walls.statedRemovalSF;
      if (stated != null) {
        const calc = `${stated} SF as stated by the report${m.walls.statedApproximate ? " (\"approximately\" — verify on site)" : ""}; not derived from measurements`;
        add({ id: "mold.walls.remove", ruleId: "mold.removeWhenGrowth", kind: "mitigation", scopeCategory: "removal", activity: "Remove & bag", item: `drywall with growth — ${m.walls.affectedWalls.join(", ")}`, quantity: stated, unit: "SF", calc, justification: "Drywall with growth is removed per the assessor's plan.", flags: m.walls.statedApproximate ? ["Approximate quantity in the report — verify on site."] : [] });
        add({ id: "mold.walls.cavity", ruleId: "mold.cleaningSteps", kind: "mitigation", scopeCategory: "cleaning", activity: "Clean", item: `exposed framing behind the removed drywall — wire-brush/sand, HEPA vacuum, damp-wipe`, quantity: stated, unit: "SF", calc: `same area as the drywall removed: ${stated} SF (report)`, justification: "Clean the framing exposed by the drywall removal before clearance." });
        if (m.encapsulate) add({ id: "mold.encapsulate", ruleId: "mold.encapsulant", kind: "mitigation", scopeCategory: "antimicrobial", activity: "Apply", item: "EPA-registered encapsulating paint to the exposed framing", quantity: stated, unit: "SF", calc: `same area as the drywall removed: ${stated} SF (report)`, justification: "Encapsulate the cleaned framing behind the removed drywall." });
        add({ id: "drywall.replace", ruleId: "whatGoesWithIt.drywallFloodCut", kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: "drywall — hang, tape, finish", quantity: stated, unit: "SF", calc: `same area as removed: ${stated} SF (report)`, justification: "Replaces the drywall removed (same SF). Rebuild only after clearance." });
      } else if (wet == null && !explicit) {
        add({ id: "mold.walls.remove", ruleId: "mold.removeWhenGrowth", kind: "mitigation", scopeCategory: "removal", activity: "Remove & bag", item: `drywall with growth (${m.walls.affectedWalls.join(", ")}) — height not stated`, quantity: null, unit: "SF", calc: "growth height not stated — no quantity", justification: "Drywall with growth is removed (S520)." });
        questions.push(`${room}: how high does the growth go on walls ${m.walls.affectedWalls.join(", ")}? (sets the drywall removal)`);
      } else {
        const ch = explicit ? { cutIn: m.walls.floodCut as number, calc: m.walls.cutSource ? `${m.walls.floodCut}" — ${m.walls.cutSource}` : `${m.walls.floodCut}" set by PM` } : cutHeight(wet!, "3", R);
        const parts = affectedWalls.map((w) => floodCutSF(w, ch.cutIn));
        const missingWalls = m.walls.affectedWalls.filter((w) => !affectedWalls.some((x) => x.label === w));
        const sf = parts.length === m.walls.affectedWalls.length ? r1(parts.reduce((a, p) => a + p.sf, 0)) : null;
        const calc = `${explicit ? ch.calc : `growth to ${wet}" + 24" beyond = ${wet! + 24}" → ${ch.cutIn}" (sheet stop)`}; ${[...parts.map((p) => p.calc), ...missingWalls.map((w) => `${w}: length not measured`)].join("; ") || "walls not measured"}`;
        add({ id: "mold.walls.remove", ruleId: "mold.removeWhenGrowth", kind: "mitigation", scopeCategory: "removal", activity: "Remove & bag", item: `drywall with growth to ${ch.cutIn}" (${m.walls.affectedWalls.join(", ")})`, quantity: sf, unit: "SF", calc, justification: "Drywall with growth is removed, 2 ft beyond visible growth (S520 practice)." });
        if (m.insulation) add({ id: "mold.insulation.remove", ruleId: "mold.removeWhenGrowth", kind: "mitigation", scopeCategory: "removal", activity: "Remove & bag", item: `wall insulation to ${ch.cutIn}"`, quantity: sf, unit: "SF", calc, justification: "Insulation in the opened cavity is removed with the drywall." });
        add({ id: "mold.walls.cavity", ruleId: "mold.cleaningSteps", kind: "mitigation", scopeCategory: "cleaning", activity: "Clean", item: `opened wall cavity (studs, plates) to ${ch.cutIn}" — HEPA vacuum → wire-brush → damp-wipe`, quantity: sf, unit: "SF", calc, justification: "Clean the framing exposed by the drywall removal before clearance." });
        if (m.encapsulate) add({ id: "mold.encapsulate", ruleId: "mold.encapsulant", kind: "mitigation", scopeCategory: "antimicrobial", activity: "Apply", item: `EPA-registered encapsulating paint to the exposed framing to ${ch.cutIn}"`, quantity: sf, unit: "SF", calc, justification: "Encapsulate the cleaned framing behind the removed drywall." });
        if (missingWalls.length) questions.push(`${room}: measure the ${missingWalls.join(", ")} (length) — sets the drywall removal SF at ${ch.cutIn}" high.`);
        add({ id: "drywall.replace", ruleId: "whatGoesWithIt.drywallFloodCut", kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: `drywall ${ch.cutIn}" — hang, tape, finish`, quantity: sf, unit: "SF", calc, justification: "Replaces the drywall removed (same SF)." });
        if (m.insulation) add({ id: "insulation.replace", ruleId: "whatGoesWithIt.drywallFloodCut", kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: "wall insulation", quantity: sf, unit: "SF", calc, justification: "Goes with insulation removal." });
        m.walls.affectedWalls.forEach((w) => paintWall(w, `drywall with growth removed to ${ch.cutIn}"`));
      }
      if (fcNoBase.length) questions.push(`${room}: drywall comes off on ${fcNoBase.join(", ")} — the baseboard on ${fcNoBase.length > 1 ? "those walls" : "that wall"} has to come off too. Mark baseboard (remove) for ${fcNoBase.join(", ")}?`);
    }
  } else if (affectedWalls.length || m.walls.affectedWalls.length) {
    if (m.walls.material === "plaster") questions.push(`${room}: plaster walls — dry in place or remove? (no automatic flood cut on plaster)`);
    if (wet == null) questions.push(`${room}: how high is the wet line / wicking on the walls (inches)?`);
    const explicit = typeof m.walls.floodCut === "number";
    const auto = m.walls.floodCut === "auto" && (cat === "2" || cat === "3");
    if (drywall && m.walls.floodCut === "auto" && cat !== "2" && cat !== "3")
      questions.push(`${room}: ${cat === "1" ? "Category 1 — walls are dried in place by default." : "Category not set."} Flood cut the drywall? (set a height to add it)`);
    if (drywall && wet != null && (explicit || auto) && R.whatGoesWithIt.drywallFloodCut.enabled) {
      const fcNoBase = m.walls.affectedWalls.filter((w) => !bbRemovedWalls.has(w));
      if (fcNoBase.length)
        questions.push(`${room}: flood cut on ${fcNoBase.join(", ")} — the baseboard on ${fcNoBase.length > 1 ? "those walls" : "that wall"} has to come off. Mark baseboard affected (remove) for ${fcNoBase.join(", ")}?`);
      const ch = explicit ? { cutIn: m.walls.floodCut as number, calc: `${m.walls.floodCut}" set by PM` } : cutHeight(wet, cat, R);
      const parts = affectedWalls.map((w) => floodCutSF(w, ch.cutIn));
      const sf = parts.length ? r1(parts.reduce((a, p) => a + p.sf, 0)) : null;
      const calc = `${ch.calc}; ${parts.length ? parts.map((p) => p.calc).join("; ") : "walls not measured"}`;
      add({ id: "floodcut", ruleId: "floodCut", kind: "mitigation", scopeCategory: "removal", activity: "Flood cut", item: `drywall at ${ch.cutIn}" (${m.walls.affectedWalls.join(", ")})`, quantity: sf, unit: "SF", calc, justification: `Wet drywall to ${wet}"${cat ? `, Category ${cat}` : ""} — cut ${ch.cutIn - wet}" above the wet line for drying and removal of affected material.` });
      if (m.insulation && R.whatGoesWithIt.drywallFloodCut.removeInsulationToCutLine)
        add({ id: "insulation.remove", ruleId: "whatGoesWithIt.drywallFloodCut", kind: "mitigation", scopeCategory: "removal", activity: "Remove", item: `wall insulation to cut line (${ch.cutIn}")`, quantity: sf, unit: "SF", calc, justification: "Wet insulation behind the flood cut is removed (goes with the flood cut)." });
      if (R.whatGoesWithIt.drywallFloodCut.tapeFinishPrimePaintToBreak) {
        add({ id: "drywall.replace", ruleId: "whatGoesWithIt.drywallFloodCut", kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: `drywall ${ch.cutIn}" — hang, tape, finish`, quantity: sf, unit: "SF", calc, justification: "Goes with the flood cut." });
        if (m.insulation) add({ id: "insulation.replace", ruleId: "whatGoesWithIt.drywallFloodCut", kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: "wall insulation", quantity: sf, unit: "SF", calc, justification: "Goes with insulation removal." });
        m.walls.affectedWalls.forEach((w) => paintWall(w, `drywall replaced to ${ch.cutIn}"`));
      }
    }
  }
  // cabinets & countertops (before the wall paint: cabinets that come out add the wall behind them)
  if (m.casework.length) {
    caseworkLines(m.casework, m.caseworkContents, {
      reportValues: scan.reportValues,
      sourceOf: (k) => {
        const it = m.casework.find((x) => x.kind === k);
        const rv = scan.reportValues[`casework.${k}`];
        if (!it?.action || rv !== `Affected — ${CASEWORK_ACTION_LABELS[it.action].toLowerCase()}`) return null;
        const mm = (ctx.report?.caseworkMentions ?? []).find((x) => x.value.kind === k && (x.value.room ?? "").toLowerCase() === (scan.reportRoom ?? "").toLowerCase());
        return mm ? `report p.${mm.page}: “${mm.quote}”` : "per the report";
      },
      rules: R,
      room,
      water,
      mold,
      category: cat,
      wallsWorked: m.walls.affectedWalls,
      isKitchenOrBath: /kitchen|bath|vanity|powder/i.test(room),
      add,
      question: (q) => questions.push(q),
      note: (x) => notes.push(x),
      paintWall,
    });
  }
  if (paintWalls.size) {
    const labels = [...paintWalls.keys()];
    const ws = t.walls.filter((w) => paintWalls.has(w.label));
    const parts = ws.map((w) => wallPaintSF(w, t.heightFt));
    // every painted wall must be measured: a partial sum would understate the full-wall quantity
    const sf = ws.length === labels.length && parts.every((p) => p.sf != null) ? r1(parts.reduce((a, p) => a + (p.sf ?? 0), 0)) : null;
    const missing = labels.filter((l) => !ws.some((w) => w.label === l));
    const calc = [...parts.map((p) => p.calc), ...missing.map((l) => `${/wall$/i.test(l) ? l : `${l} wall`}: not measured`)].join("; ") || "walls not measured";
    add({ id: "walls.paint", ruleId: "whatGoesWithIt.paintFullWall", kind: "reconstruction", scopeCategory: "painting", activity: "Seal/prime & paint", item: `full continuous wall to natural break (${labels.join(", ")})`, quantity: sf, unit: "SF", calc, justification: `${labels.map((l) => `${l}: ${paintWalls.get(l)!.join(" + ")}`).join("; ")} — the full continuous wall (corner to corner, floor to ceiling, openings deducted) is sealed/primed and painted to the natural break so the finish matches. Quantity is wall SF, not baseboard LF or floor SF.` });
  }

  // ---------------- ceiling ----------------
  if (m.ceiling.affected) {
    const cpct = m.ceiling.affectedPct ?? 100;
    const csf = t.ceilingSF != null ? r1((t.ceilingSF * cpct) / 100) : null;
    const ccalc = t.ceilingSF != null ? `${t.floorCalc} (ceiling)${cpct !== 100 ? ` × ${cpct}% = ${csf} SF` : ""}` : "ceiling not measured";
    if (m.ceiling.action === "remove") {
      add({ id: "ceiling.remove", ruleId: "ceiling.remove", kind: "mitigation", scopeCategory: "removal", activity: "Remove", item: `ceiling drywall${m.insulation ? " and insulation above" : ""}`, quantity: csf, unit: "SF", calc: ccalc, justification: "Wet/sagging ceiling — removed (PM decision)." });
      if (R.whatGoesWithIt.ceilingRemoval.enabled) {
        add({ id: "ceiling.replace", ruleId: "whatGoesWithIt.ceilingRemoval", kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: "ceiling drywall — hang, tape, finish", quantity: csf, unit: "SF", calc: ccalc, justification: "Replaces the ceiling drywall removed (same SF). The finish is covered by the full-ceiling seal & paint line." });
        if (m.insulation && R.whatGoesWithIt.ceilingRemoval.replaceInsulation)
          add({ id: "ceiling.insulation.replace", ruleId: "whatGoesWithIt.ceilingRemoval", kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: "ceiling insulation", quantity: csf, unit: "SF", calc: ccalc, justification: "Replaces the insulation removed with the ceiling." });
      }
    }
    if (fireSmoke)
      add({ id: "ceiling.clean", ruleId: "smoke.clean.ceiling", kind: "mitigation", scopeCategory: "cleaning", activity: "Clean", item: `ceiling — ${smokeMethod(scan, R)}`, quantity: csf, unit: "SF", calc: ccalc, justification: "Smoke/soot residue on ceiling." });
    if (R.whatGoesWithIt.ceilingStain.sealAndPaintFullCeiling && (m.ceiling.action === "seal_paint" || m.ceiling.action === "remove" || fireSmoke))
      add({ id: "ceiling.paint", ruleId: "whatGoesWithIt.ceilingStain", kind: "reconstruction", scopeCategory: "painting", activity: "Seal (stain-blocking) & paint", item: `full ceiling${m.ceiling.action === "remove" ? " after drywall replacement" : ""}`, quantity: t.ceilingSF, unit: "SF", calc: t.ceilingSF != null ? `${t.floorCalc} (full ceiling)` : "ceiling not measured", justification: `${m.ceiling.action === "remove" ? "Ceiling drywall replaced" : fireSmoke ? "Smoke/soot on the ceiling" : "Stained ceiling"}${cpct !== 100 ? ` (${cpct}% affected)` : ""} — the FULL ceiling is sealed (stain-blocking) and painted for a uniform finish. Quantity is the full ceiling SF, not the affected or removed area.` });
  }

  // ---------------- cabinets & countertops ----------------
  if (!m.casework.length && m.cabinets.affected) {
    const lf = m.cabinets.lf;
    const calc = lf != null ? `${lf} LF of base cabinets (measured)` : "cabinet length not measured";
    if (m.cabinets.detach)
      add({ id: "cabinets.detach", ruleId: "cabinets.detach", kind: "mitigation", scopeCategory: "detach_reset", activity: "Detach", item: "base cabinets for drying access", quantity: lf, unit: "LF", calc, justification: "Wet cavity/flooring under the cabinets needs drying access." });
    else if (R.whatGoesWithIt.cabinets.removeToeKickForDrying)
    {
      add({ id: "cabinets.toekick", ruleId: "whatGoesWithIt.cabinets", kind: "mitigation", scopeCategory: "cavity_access", activity: "Remove", item: "toe kick for drying access", quantity: lf, unit: "LF", calc, justification: "Dry the cavity under the cabinets without detaching them." });
      add({ id: "cabinets.toekick.reinstall", ruleId: "whatGoesWithIt.cabinets", kind: "reconstruction", scopeCategory: "detach_reset", activity: "Reinstall", item: "toe kick (replace if damaged)", quantity: lf, unit: "LF", calc, justification: "Goes back on after drying (same LF as removed)." });
    }
    if (m.cabinets.detach || (thisReplace && R.whatGoesWithIt.cabinets.detachResetWhenFlooringReplaced)) {
      add({ id: "cabinets.reset", ruleId: "whatGoesWithIt.cabinets", kind: "reconstruction", scopeCategory: "detach_reset", activity: "Reset & reattach", item: "base cabinets", quantity: lf, unit: "LF", calc, justification: m.cabinets.detach ? "Goes with cabinet detach." : "Cabinets reset when the flooring under them is replaced." });
      if (R.whatGoesWithIt.cabinets.reconnectPlumbingAndCountertop)
        add({ id: "cabinets.reconnect", ruleId: "whatGoesWithIt.cabinets", kind: "reconstruction", scopeCategory: "detach_reset", activity: "Reconnect", item: "countertop, sink plumbing and appliances as applicable", quantity: 1, unit: "EA", calc: "1 per cabinet run", justification: "Goes with cabinet reset." });
    }
  }

  // ---------------- mold remediation (S520) ----------------
  const pending: string[] = [];
  const growthHere = m.flooring.affected || m.walls.affectedWalls.length > 0 || m.ceiling.affected || m.framing.growth || m.baseboard.affected || m.cabinets.affected || m.casework.some((i) => i.affected) || m.moldSpecial.length > 0;
  const runOnlyRoom = mold && !!scan.reportDocumentId && !growthHere;
  if (runOnlyRoom) notes.push("No growth reported in this room — it is in the continuous flooring run, so only the flooring replacement applies here.");
  const group = mold ? scan.containmentGroup : null;
  const sharedOther = !!group && !group.primary;
  if (mold && !runOnlyRoom) {
    const report = scan.loss.assessmentReport;
    const hold = scan.source.status === "active" || (!!scan.source.hold && scan.source.status !== "repaired" && scan.source.status !== "stopped");
    const pendingFlag = [
      ...(report === "pending" ? ["Confirm against the mold assessment report (pending)."] : report == null || report === "none" ? ["No mold assessment on file — confirm the protocol."] : []),
      ...(hold ? ["HOLD — the moisture source is not fixed: don't start until it is repaired and the materials are dry."] : scan.source.status === "unknown" ? ["Confirm the moisture source is fixed before starting."] : []),
    ];
    const moldAdd = (d: Draft) => add({ ...d, flags: [...(d.flags ?? []), ...pendingFlag] });
    if (hold) {
      notes.push(
        scan.source.status === "active"
          ? "⚑ HOLD: the moisture source is not fixed. Remediation can't be finalized until it is repaired and the materials are dry — this scope is not final."
          : `⚑ HOLD: the report says the source still has to be addressed and nothing confirms it is fixed (“${scan.source.hold}”). Set the source status to Repaired once confirmed — this scope is not final until then.`,
      );
      pending.push(
        scan.source.status === "active"
          ? "HOLD: the moisture source is not fixed — remediation can't be finalized until it is repaired and the materials are dry"
          : `HOLD: source of water intrusion not confirmed fixed — the report says it “must be addressed”; remediation can't be finalized until it is confirmed`,
      );
    }
    notes.push(...scan.reportNotes);
    if (sharedOther) notes.push(`In one containment with ${group!.rooms.filter((n) => !room.toLowerCase().includes(n.toLowerCase())).join(", ")} — the containment, negative air and clearance lines are on the first room.`);
    const perimCalc = t.perimeterLF != null && t.heightFt ? `${t.perimeterCalc} × ${t.heightFt} ft = ${r1(t.perimeterLF * t.heightFt)} SF of poly (room as containment)` : "room not measured";
    const polySF = t.perimeterLF != null && t.heightFt ? r1(t.perimeterLF * t.heightFt) : null;
    const sharedRooms = group?.primary ? group.rooms : null;
    const area = scan.containmentArea;
    const noCont = !!area?.none;
    if (noCont) notes.push("The report lists no containment for this room — only the items named for it are scoped here.");
    if (noCont) {
      /* no containment, negative air or clearance lines in this room */
    } else if (MR.containment.enabled && area?.extent === "localized") {
      moldAdd({ id: "mold.containment", ruleId: "mold.containment", kind: "mitigation", scopeCategory: "containment", activity: "Set up", item: `localized containment (per the report) — ${ctx.report?.containment?.value.material ?? MR.containment.description}`, quantity: null, unit: "SF", calc: "localized containment — its size isn't in the report; measure the poly walls", justification: "Containment as listed in the assessor's plan." });
      questions.push(`${room}: measure the localized containment (poly SF) — the report gives no size.`);
    } else if (MR.containment.enabled && sharedRooms) {
      moldAdd({ id: "mold.containment", ruleId: "mold.containment", kind: "mitigation", scopeCategory: "containment", activity: "Set up", item: `one containment around ${sharedRooms.join(", ")} — ${MR.containment.description}`, quantity: null, unit: "SF", calc: "shared containment — measure its poly walls (room perimeters overlap at the shared openings)", justification: "S520: one containment for the connected rooms with growth." });
      questions.push(`${room}: measure the shared containment poly (SF) around ${sharedRooms.join(", ")}.`);
    } else if (MR.containment.enabled && !sharedOther && !noCont)
      moldAdd({ id: "mold.containment", ruleId: "mold.containment", kind: "mitigation", scopeCategory: "containment", activity: "Set up", item: `${area?.extent === "entire" ? "containment of the entire room (per the report)" : "containment"} — ${(area && ctx.report?.containment?.value.material) || MR.containment.description}`, quantity: polySF, unit: "SF", calc: perimCalc, justification: "S520: isolate the work area so spores and debris don't spread during removal. Size it to the assessor's plan; a smaller containment around the work area reduces this." });
    const scr = area?.scrubber;
    if (scr && !noCont && !sharedOther) {
      const vol = t.floorSF != null && t.heightFt ? r1(t.floorSF * t.heightFt) : null;
      const cfm = vol != null && scr.ach ? Math.ceil((vol * scr.ach) / 60) : null;
      moldAdd({
        id: "mold.negair",
        ruleId: "mold.negativeAir",
        kind: "equipment",
        scopeCategory: "containment",
        activity: "Set",
        item: `HEPA-filtered air scrubber${scr.hours ? ` — ${scr.hours} hours` : ""}${scr.ach ? ` at ${scr.ach} ACH` : ""} (negative pressure through a window if possible)`,
        quantity: scr.perContainment,
        unit: "EA",
        calc: `${scr.perContainment} per containment (report)${scr.hours ? `; ${scr.hours} h = ${r1(scr.hours / 24)} days` : ""}${scr.ach ? `; ${scr.ach} ACH needs ${cfm != null ? `${vol} CF × ${scr.ach} ÷ 60 = ${cfm} CFM` : "the room volume (not measured) × 8 ÷ 60 CFM"}` : ""}`,
        justification: "Air scrubber count, run time and air changes as stated in the assessor's plan.",
      });
    } else if (MR.negativeAirPerContainment > 0 && !sharedOther && !noCont)
      moldAdd({ id: "mold.negair", ruleId: "mold.negativeAir", kind: "equipment", scopeCategory: "containment", activity: "Set (calculated)", item: "HEPA negative air machine, exhausted outside the containment", quantity: MR.negativeAirPerContainment, unit: "EA", calc: `${MR.negativeAirPerContainment} per containment`, justification: "Keeps the containment under negative pressure during removal and cleaning." });
    if (MR.dehumidifierPerContainment > 0 && !sharedOther && !noCont)
      moldAdd({ id: "mold.dehu", ruleId: "mold.dehumidifier", kind: "equipment", scopeCategory: "drying", activity: "Set (calculated)", item: "dehumidifier to hold RH below 50% in the containment", quantity: MR.dehumidifierPerContainment, unit: "EA", calc: `${MR.dehumidifierPerContainment} per containment`, justification: "Growth needs moisture; dry the remaining structure before closing up." });
    {
      // PPE: 1 set per worker per day for the job — from the confirmed crew × work days, counted once (in one mold room)
      const cr = ctx.crew;
      const here = !cr?.ppeRoom || cr.ppeRoom === room;
      const qty = cr?.people != null && here ? cr.people * cr.days : here ? null : 0;
      moldAdd({
        id: "mold.ppe",
        ruleId: "mold.ppe",
        kind: "mitigation",
        scopeCategory: "containment",
        activity: "Provide",
        item: MR.ppeDescription,
        quantity: qty,
        unit: "EA/worker/day",
        calc: !here
          ? `counted once for the job in ${cr!.ppeRoom}`
          : cr?.people != null
            ? `${cr.people} on the crew (${cr.label}, PM confirmed) × ${cr.days} day${cr.days === 1 ? "" : "s"} (${cr.daysBasis}) = ${qty} sets`
            : `1 set per worker per day — confirm the crew at the top of the scan (people × ${cr?.days ?? "?"} days${cr ? `, ${cr.daysBasis}` : ""})`,
        justification: "Worker protection during mold removal (S520).",
      });
    }
    if (moldFloorOut) {
      const what = `${m.flooring.type || "flooring"} with growth`;
      moldAdd({ id: "mold.floor.remove", ruleId: "mold.removeWhenGrowth", kind: "mitigation", scopeCategory: "removal", activity: "Remove & bag", item: what, quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: `Mold under the ${m.flooring.type || "flooring"}: porous/semi-porous material with growth is removed, not cleaned (S520).` });
      moldAdd({ id: "mold.underlayment.remove", ruleId: "mold.removeWhenGrowth", kind: "mitigation", scopeCategory: "removal", activity: "Remove & bag", item: "underlayment / vapor barrier under the flooring (if present)", quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: "Sits in the growth zone between flooring and subfloor." });
      if (m.subfloor === "remove") {
        moldAdd({ id: "mold.subfloor.remove", ruleId: "mold.removeWhenGrowth", kind: "mitigation", scopeCategory: "removal", activity: "Remove & bag", item: "subfloor with growth", quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: "Subfloor with growth is removed (assessor's plan)." });
        add({ id: "mold.subfloor.replace", ruleId: "mold.removeWhenGrowth", kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: "subfloor", quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: "Replaces the subfloor removed (same SF)." });
      } else
  moldAdd({ id: "mold.subfloor.clean", ruleId: "mold.cleaningSteps", kind: "mitigation", scopeCategory: "cleaning", activity: "Clean", item: `subfloor — ${MR.cleaningSteps.map((x) => x.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())).join(" → ")}`, quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: "Remove remaining growth from the subfloor left in place (S520). If the assessor finds the subfloor itself compromised, it is removed instead." });
      if (MR.antimicrobialAfterCleaning)
        moldAdd({ id: "mold.antimicrobial", ruleId: "mold.antimicrobial", kind: "mitigation", scopeCategory: "antimicrobial", activity: "Apply", item: m.subfloor === "remove" ? "antimicrobial to the exposed joists after cleaning" : "antimicrobial to the cleaned subfloor", quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: "After physical removal and cleaning — not a substitute for it." });
      moldAdd({ id: "mold.dispose", ruleId: "mold.disposal", kind: "mitigation", scopeCategory: "removal", activity: "Bag & dispose", item: "removed materials in sealed 6 mil bags", quantity: affFloorSF, unit: "SF", calc: `same area as removed: ${floorCalc}`, justification: "Removed moldy material leaves the containment sealed." });
    } else if (m.flooring.affected && m.flooring.action === "sand") {
      moldAdd({ id: "mold.floor.sand", ruleId: "mold.floorSand", kind: "mitigation", scopeCategory: "cleaning", activity: "Sand", item: `visible discoloration of the ${m.flooring.type || "wood flooring"}`, quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: "The assessor allows sanding the discolored wood floor panels instead of removing them (PM choice)." });
    } else if (m.flooring.affected && m.flooring.choice === "remove_or_sand") {
      moldAdd({ id: "mold.floor.choice", ruleId: "mold.floorChoice", kind: "mitigation", scopeCategory: "removal", activity: "Choose", item: `remove the affected ${m.flooring.type || "wood flooring"} OR sand the discoloration (the report allows either)`, quantity: null, unit: "SF", calc: `${floorCalc}; set "Flooring action" to Remove or Sand`, justification: "The assessor's plan leaves this choice open." });
      questions.push(`${room}: the report allows removing the affected ${m.flooring.type || "wood flooring"} or sanding the discoloration — pick one (Flooring action) to set the lines.`);
    } else if (mold && m.flooring.affected) questions.push(`${room}: ${m.flooring.type || "flooring"} with growth — remove, or clean in place? (S520 removes porous/semi-porous material with growth)`);
    // items named in the report that aren't a surface removal
    if (m.moldSpecial.includes("shower_caulking"))
      moldAdd({ id: "mold.caulking", ruleId: "mold.special", kind: "mitigation", scopeCategory: "cleaning", activity: "Re-seal", item: "shower: scrape out all caulking, sanitize, new silicone seal", quantity: null, unit: "LF", calc: "caulk length not stated in the report — measure the shower perimeter", justification: "Growth on the shower caulking (assessor's plan)." });
    if (m.moldSpecial.includes("vent"))
      moldAdd({ id: "mold.vent", ruleId: "mold.special", kind: "mitigation", scopeCategory: "cleaning", activity: "Clean", item: "bathroom vent near the floor", quantity: 1, unit: "EA", calc: "1 vent named in the report", justification: "Growth at the vent (assessor's plan).", flags: m.ventHvacIfInaccessible ? ["If the vent/duct isn't accessible: HVAC company — not in our price."] : [] });
    // framing with growth: cleaned in place, or removed/replaced (structural)
    if (m.framing.growth) {
      const fr = m.framing;
      const what = fr.where === "joists" ? "floor joists" : fr.where === "studs" ? "wall studs" : "framing";
      if (fr.action === "remove")
        moldAdd({ id: "mold.framing.remove", ruleId: "mold.framing", kind: "mitigation", scopeCategory: "removal", activity: "Remove & replace", item: `${what} with growth/damage (structural)`, quantity: null, unit: "LF", calc: "per engineer / GC — not measured here", justification: "Framing the assessor calls for removing is structural work.", flags: ["Structural — needs an engineer/GC scope; not priced here."] });
      else {
        const qty = fr.where === "joists" ? affFloorSF : null;
        moldAdd({ id: "mold.framing.clean", ruleId: "mold.framing", kind: "mitigation", scopeCategory: "cleaning", activity: "Clean", item: `${what} with growth — HEPA vacuum → wire-brush/sand → HEPA vacuum → damp-wipe, then antimicrobial`, quantity: qty, unit: "SF", calc: fr.where === "joists" ? `joist bay area = removed floor area: ${floorCalc}` : "framing area not measured", justification: "Framing with surface growth is cleaned in place (S520)." });
        if (!fr.action) questions.push(`${room}: the ${what} have growth — clean in place, or remove/replace? (the assessor's plan decides)`);
      }
      if (fr.where === "joists" && scan.materials.subfloor === "clean")
        questions.push(`${room}: growth on the floor joists but the subfloor stays — the joists can't be reached through it. Confirm subfloor removal with the assessor.`);
    }
    const sc = ctx.report?.surfaceCleaning?.value;
    if (sc && !noCont && !runOnlyRoom) {
      const entire = area?.extent === "entire" || (!area && !group);
      const sf = entire && t.floorSF != null && t.wallNetSF != null && t.ceilingSF != null ? r1(t.floorSF + t.wallNetSF + t.ceilingSF) : null;
      moldAdd({
        id: "mold.sanitize",
        ruleId: "mold.cleaningSteps",
        kind: "mitigation",
        scopeCategory: "antimicrobial",
        activity: "Clean & treat",
        item: `all surfaces in the containment (walls, floors, ceiling, exposed studs) — ${[sc.hepaVacuum && "HEPA vacuum", sc.sanitize && "deep sanitization", `EPA-registered antimicrobial${sc.product ? ` (${sc.product})` : ""}`].filter(Boolean).join(", ")}`,
        quantity: sf,
        unit: "SF",
        calc: sf != null ? `floor ${t.floorSF} + walls ${t.wallNetSF} + ceiling ${t.ceilingSF} = ${sf} SF` : area?.extent === "localized" ? "localized containment — surface area not stated; measure it" : "room not measured",
        justification: "All-surface cleaning and treatment per the assessor's plan.",
      });
    }
    if (!noCont) moldAdd({ id: "mold.finalclean", ruleId: "mold.cleaningSteps", kind: "mitigation", scopeCategory: "cleaning", activity: "Final clean", item: "containment — HEPA vacuum and damp-wipe all surfaces before clearance", quantity: t.floorSF, unit: "SF", calc: t.floorSF != null ? `${t.floorCalc} (work-area floor)` : "room not measured", justification: "Final detail clean so the area can pass post-remediation verification." });
    if (MR.postRemediationVerification && !sharedOther && !noCont)
      add({ id: "mold.pcv", ruleId: "mold.postRemediationVerification", kind: "mitigation", scopeCategory: "note", activity: "Schedule", item: "post-remediation verification (clearance) by an independent licensed assessor", quantity: 1, unit: "EA", calc: "1 per containment", justification: "Containment stays up until clearance passes. Performed by a third party, not by us.", flags: ["Third party — not in our price."] });
    if (mold && m.flooring.affectedPct == null && m.flooring.affected) {
      const partial = ctx.report?.rooms.find((r) => (r.value.name || null) === (scan.reportRoom || null))?.value.coverage;
      questions.push(
        partial && !partial.whole
          ? `${room}: the report says growth covers part of the floor but gives no SF or boundary — measure the affected area (or ask the assessor). No quantity until then.`
          : `${room}: does the growth cover the whole floor or part of it? (sets the removal area)`,
      );
    }
    if (report == null || report === "none")
      questions.push(`${room}: is there a mold assessment report / protocol? NY requires one for work over ${MR.licensedThresholdSF} SF.`);
    notes.push(MR.licensingNote);
    if (inherited) notes.push("Loss type taken from the visit (Mold remediation) — change it in step 1 if this room is different.");
    if (!MR.dehumidifierPerContainment) notes.push("Equipment: HEPA negative air / air scrubber for the containment. Add a dehumidifier only if moisture readings are elevated.");
    notes.push(...assumed.map((a) => `Assumed: ${a}`));
    if (report === "received" && ctx.report) {
      const sm = stillMissing(ctx.report, { yearBuiltKnown: ctx.yearBuilt != null, runKnown: !!(m.flooring.continuousRun || m.flooring.breakNote) }, { room: scan.reportRoom, primary: scan.reportPrimary || !scan.reportRoom });
      if (sm.some((x) => x.startsWith("HOLD"))) for (let i = pending.length - 1; i >= 0; i--) if (pending[i].startsWith("HOLD")) pending.splice(i, 1);
      pending.push(...sm.map((x) => (x.startsWith("HOLD") ? x : `STILL MISSING after the mold report: ${x}`)));
    }
    else if (report !== "received")
      pending.push(
        "Affected area and extent (SF) — sets every removal and cleaning quantity",
        "Containment level and removal limits in the remediation plan",
        "Whether the subfloor is cleaned or removed, and whether walls, baseboard backs or framing also have growth",
        "Clearance criteria and who performs post-remediation verification",
      );
  }

  // ---------------- treatment / cleaning ----------------
  const wallStripSF = wet != null ? affectedWalls.reduce((a, w) => a + Math.max(0, w.lengthFt - w.doorsWidthFt) * (wet / 12), 0) : 0;
  if (water && (cat === "2" || cat === "3")) {
    const sf = affFloorSF != null ? r1(affFloorSF + wallStripSF) : null;
    add({ id: "antimicrobial", ruleId: `cleaningMethods.water_cat${cat}`, kind: "mitigation", scopeCategory: "antimicrobial", activity: "Apply", item: "antimicrobial to affected surfaces", quantity: sf, unit: "SF", calc: sf != null ? `affected floor ${affFloorSF} SF${wallStripSF ? ` + wet wall strip ${r1(wallStripSF)} SF` : ""} = ${sf} SF` : "not measured", justification: `${R.cleaningMethods[`water_cat${cat}` as "water_cat2"].label}: antimicrobial per method.` });
  }
  if (water && cat === "1" && m.flooring.affected && !porousFloor)
    add({ id: "clean.hard", ruleId: "cleaningMethods.water_cat1", kind: "mitigation", scopeCategory: "cleaning", activity: "Clean", item: "affected hard surfaces", quantity: affFloorSF, unit: "SF", calc: floorCalc, justification: "Category 1 method: extract, dry, clean affected hard surfaces." });
  if (fireSmoke && t.wallNetSF != null)
    add({ id: "walls.clean", ruleId: "smoke.clean.walls", kind: "mitigation", scopeCategory: "cleaning", activity: "Clean", item: `walls — ${smokeMethod(scan, R)}`, quantity: t.wallNetSF, unit: "SF", calc: t.wallCalc, justification: "Smoke/soot residue on walls." });

  // ---------------- equipment (calculated, never "installed") ----------------
  let am: RoomAnalysis["airMovers"] = null;
  if (water && affFloorSF) {
    am = airMoverCalc(affFloorSF, R);
    add({ id: "equip.airmovers", ruleId: "equipment.airMovers", kind: "equipment", scopeCategory: "drying", activity: "Set (calculated)", item: "air movers", quantity: am.recommended, unit: "EA", calc: am.calc, justification: "Calculated from wet floor area — confirm the count you place." });
  }
  if ((fireSmoke || cat === "3") && R.equipment.airScrubberPerAffectedArea > 0)
    add({ id: "equip.scrubber", ruleId: "equipment.airScrubber", kind: "equipment", scopeCategory: "drying", activity: "Set (calculated)", item: "HEPA air scrubber", quantity: R.equipment.airScrubberPerAffectedArea, unit: "EA", calc: `${R.equipment.airScrubberPerAffectedArea} per affected area (${fireSmoke ? "fire/smoke/odor" : "Category 3"})`, justification: "Air filtration for particulate/odor control." });
  if (water && (m.flooring.affected || m.walls.affectedWalls.length || m.ceiling.affected))
    add({ id: "monitor", ruleId: "monitoring", kind: "monitoring", scopeCategory: "monitoring", activity: "Monitor", item: "moisture daily until every point meets its dry goal", quantity: null, unit: "DA", calc: "days not set — recorded per visit", justification: scan.moisturePoints.length ? `${scan.moisturePoints.length} moisture point(s) mapped.` : "Map moisture points to track drying." });

  // ---------------- contents ----------------
  if (scan.contents.present && scan.contents.affected) {
    const what = scan.contents.items || "affected contents";
    if (scan.contents.handling === "manipulate" || scan.contents.handling === "none")
      add({ id: "contents.manip", ruleId: "contents.manipulation", kind: "contents", scopeCategory: "contents", activity: "Move / block", item: `${what} (contents manipulation to access the structure)`, quantity: 1, unit: "EA", calc: "1 room", justification: "Contents must be moved to access the affected structure." });
    if (scan.contents.handling === "clean_onsite")
      add({ id: "contents.clean", ruleId: "contents.clean", kind: "contents", scopeCategory: "contents", activity: "Clean on site", item: what, quantity: 1, unit: "EA", calc: "1 room (itemize on inventory)", justification: "Affected contents cleanable on site." });
    if (scan.contents.handling === "packout")
      add({ id: "contents.packout", ruleId: "contents.packout", kind: "contents", scopeCategory: "contents", activity: "Pack out", item: `${what} (inventory + photos)`, quantity: 1, unit: "EA", calc: "1 room (itemize on inventory)", justification: "Contents removed for cleaning/storage and to access the structure." });
    if (cat === "3")
      add({ id: "contents.evaluate", ruleId: "cleaningMethods.water_cat3", kind: "contents", scopeCategory: "contents", activity: "Evaluate", item: "porous contents for disposal (non-salvageable list, customer sign-off)", quantity: 1, unit: "EA", calc: "1 room", justification: "Category 3: affected porous contents are evaluated for disposal." });
  }

  // ---------------- hazards on demolition lines ----------------
  const hz = R.hazards;
  for (const d of drafts.filter(isDemo)) {
    d.flags = d.flags ?? [];
    if (ctx.yearBuilt == null) d.flags.push("Year built unknown — confirm lead/asbestos status before demolition.");
    else if (ctx.yearBuilt < hz.leadBeforeYear) d.flags.push(`Built ${ctx.yearBuilt} (before ${hz.leadBeforeYear}) — lead-safe (RRP) practices; pending hazard clearance.`);
    if (hz.asbestosSurveyBeforeDemo) d.flags.push(hz.asbestosNote);
  }
  if (drafts.some(isDemo) && ctx.yearBuilt == null) questions.push(`${room}: year built? (lead/asbestos check before demolition — set it on the property page)`);

  // ---------------- decisions, exclusions, reconstruction switch ----------------
  if (mold && ctx.report && scan.loss.assessmentReport === "received") {
    const rj = reportJustifications(ctx.report, { lengthFt: t.floorSF != null ? scan.measurements.lengthFt : null, widthFt: t.floorSF != null ? scan.measurements.widthFt : null }, room.replace(/^.*— /, ""), scan.reportRoom);
    for (const d of drafts) {
      const k = rj[d.id] ? d.id : d.id.startsWith("cw.") ? d.id.split(".").slice(0, 2).join(".") : "";
      if (rj[k]) d.justification = `${d.justification} ${rj[k]}`;
    }
  }
  if (mold) {
    const seq = ["mold.containment", "mold.negair", "mold.ppe", "baseboard", "mold.floor.remove", "mold.underlayment.remove", "mold.walls.remove", "mold.insulation.remove", "mold.subfloor.remove", "mold.framing.remove", "mold.floor.choice", "mold.floor.sand", "mold.subfloor.clean", "mold.walls.cavity", "mold.encapsulate", "mold.framing.clean", "mold.caulking", "mold.vent", "mold.antimicrobial", "mold.dehu", "mold.dispose", "mold.finalclean", "mold.pcv"];
    const rank = (d: Draft) => (d.kind === "reconstruction" ? 1000 : seq.indexOf(d.id) === -1 ? 500 : seq.indexOf(d.id));
    drafts.sort((a, b) => rank(a) - rank(b));
  }
  // ---------------- installed equipment (counted on site) governs ----------------
  // The calculated count is a suggestion; what the PM placed is what runs. When they differ the
  // installed count is used and the difference is flagged; installed equipment with no line gets one.
  const EQ_LABEL = { air_mover: "air movers", dehumidifier: "dehumidifier", air_scrubber: "HEPA air scrubber" } as const;
  for (const kind of ["air_mover", "dehumidifier", "air_scrubber"] as const) {
    const placed = scan.equipmentPlaced.filter((e) => e.kind === kind).reduce((a, e) => a + e.qty, 0);
    if (!placed) continue;
    const ids = kind === "air_mover" ? ["equip.airmovers"] : kind === "air_scrubber" ? ["mold.negair", "equip.scrubber"] : ["mold.dehu"];
    const di = drafts.findIndex((d) => ids.includes(d.id));
    if (di >= 0) {
      const d = drafts[di];
      if (d.quantity === placed) {
        drafts[di] = { ...d, activity: "Set (installed)", calc: `${placed} installed (counted on site) — matches the calculated count: ${d.calc}` };
      } else {
        drafts[di] = {
          ...d,
          activity: "Set (installed)",
          quantity: placed,
          calc: `${placed} installed (counted on site); calculated ${d.quantity ?? "—"}: ${d.calc}`,
          flags: [...(d.flags ?? []), `Installed count (${placed}) differs from the calculated count (${d.quantity ?? "none"}) — the installed count is used in the scope and equipment-days; confirm it.`],
        };
      }
    } else
      drafts.push({
        id: kind === "dehumidifier" ? "equip.dehu" : `equip.installed.${kind}`,
        ruleId: "equipment.installed",
        kind: "equipment",
        scopeCategory: "drying",
        activity: "Set (installed)",
        item: EQ_LABEL[kind],
        quantity: placed,
        unit: "EA",
        calc: `${placed} installed (counted on site)`,
        justification: "Equipment placed on site — counted by the PM.",
      });
  }

  // ---------------- equipment run time ----------------
  // Report-stated run time wins; otherwise the loss-type default (ESTIMATED); otherwise missing — never silently filled.
  const ED = R.equipmentDuration;
  const off = ctx.report?.equipmentOff;
  const offText = off ? ` Shut down ${off.value.hours} h after remediation is complete, before the clearance inspection (report p.${off.page}: “${off.quote}”).` : "";
  type Base = Omit<NonNullable<ScopeLine["duration"]>, "days" | "equipmentDays">;
  const missingRun = (why: string): Base => ({ hours: null, source: null, estimated: true, basis: why, startStop: null });
  const baseDuration = (d: Draft): Base | null => {
    if (d.kind !== "equipment") return null;
    if (mold && (d.id === "mold.negair" || d.id === "mold.dehu" || d.id.startsWith("equip."))) {
      const scrH = scan.containmentArea?.scrubber?.hours ?? null;
      const q = ctx.report?.airScrubber;
      if (scrH && (d.id === "mold.negair" || d.id === "equip.installed.air_scrubber"))
        return { hours: scrH, source: "report", estimated: false, basis: `stated by the report${q ? ` (p.${q.page}: “${q.quote}”)` : ""}`, startStop: `Start when the containment is set up; run ${scrH} h.${offText}` };
      if (scrH)
        return { hours: scrH, source: "report", estimated: true, basis: `runs with the containment's air scrubber (report: ${scrH} h) — the report doesn't give the dehumidifier its own run time`, startStop: `Runs with the containment.${offText}` };
      if (ED.moldContainmentHours)
        return { hours: ED.moldContainmentHours, source: "rule", estimated: true, basis: `company default for a mold containment (${ED.moldContainmentHours} h) — no run time in the report`, startStop: `Start when the containment is set up; run until remediation is complete.${offText}` };
      return missingRun("no run time in the report and no company default");
    }
    if (water && d.id.startsWith("equip.")) {
      const cls = scan.loss.waterClass;
      const days = (cls ? ED.waterDryingDaysByClass[cls] : undefined) ?? ED.waterDryingDaysClassUnknown;
      if (days == null) return missingRun("no drying-days default for this water class — enter the expected drying days");
      return {
        hours: days * 24,
        source: "rule",
        estimated: true,
        basis: `typical drying for ${cls ? `Class ${cls}` : "an unconfirmed water class"} (company default ${days} days) — estimated until moisture readings confirm dry`,
        startStop: `Start at setup; stop when every moisture point meets its dry goal (readings ${scan.moisturePoints.length ? `on ${scan.moisturePoints.length} mapped point${scan.moisturePoints.length === 1 ? "" : "s"}` : "— map moisture points"}).`,
      };
    }
    if (fireSmoke && (d.id === "equip.scrubber" || d.id === "equip.installed.air_scrubber"))
      return ED.fireSmokeScrubberDays
        ? { hours: ED.fireSmokeScrubberDays * 24, source: "rule", estimated: true, basis: `company default for fire/smoke air scrubbing (${ED.fireSmokeScrubberDays} days)`, startStop: "Start at setup; run through cleaning until odor/particulate is controlled." }
        : missingRun("no fire/smoke air-scrubbing duration in the company defaults — enter the expected run time");
    return missingRun("no run-time rule for this equipment — enter the expected run time");
  };
  const dryNow = scan.moisturePoints.length > 0 && scan.moisturePoints.every((p) => p.reading != null && p.dryGoal != null && Number(p.reading) <= Number(p.dryGoal));

  const lines: ScopeLine[] = drafts.map((d0) => {
    const ov = scan.quantityOverrides[d0.id];
    const d: Draft = ov != null ? { ...d0, quantity: ov, calc: `${ov} ${d0.unit} — entered by the PM (was: ${d0.calc})` } : d0;
    const flags = [...(d.flags ?? [])];
    let status: ScopeLine["status"] = scan.decisions[d.id] ?? "suggested";
    const ex = exclusionFor(d, ctx);
    if (ex) {
      status = "excluded";
      flags.push(`Excluded: ${ex}`);
    }
    if (d.kind === "reconstruction" && !ctx.reconstructionRequested && status !== "excluded")
      flags.push("Pending reconstruction — not estimated unless a reconstruction estimate is requested.");
    if (d.quantity == null && d.unit !== "DA" && !d.unit.includes("/")) flags.push("Quantity needs measurements.");
    if (d.unit.includes("/") && d.quantity == null) flags.push("Set crew size and days — confirm the crew at the top of the scan (or enter the quantity).");
    if (scan.lineNotes[d.id]) flags.push(scan.lineNotes[d.id]);
    if (mold && (scan.source.status === "active" || (!!scan.source.hold && scan.source.status !== "repaired" && scan.source.status !== "stopped")) && d.kind !== "reconstruction" && !flags.some((f) => f.startsWith("HOLD")))
      flags.push("HOLD — the moisture source is not fixed: don't start until it is repaired and the materials are dry.");
    const source: ScopeLine["source"] =
      d.quantity == null
        ? null
        : ov != null
          ? "pm"
          : /installed \(counted on site\)/.test(d.calc)
            ? "measured"
            : /stated by the report|\(report\)|named in the report/.test(d.calc)
            ? "report"
            : /not measured|not stated|not confirmed|no quantity/i.test(d.calc)
              ? null
              : /\d\s*(ft|LF|SF|CF)\b|×/.test(d.calc)
                ? "measured"
                : /“[^”]{3,}”/.test(d.justification)
                  ? "report"
                  : "rule";
    let duration: ScopeLine["duration"] = null;
    const b = baseDuration(d);
    if (b) {
      const dov = scan.durationOverrides[d.id];
      const run: Base = dov != null ? { ...b, hours: dov, source: "pm", estimated: false, basis: `entered by the PM${b.hours != null ? ` (was ${b.hours} h — ${b.basis})` : ""}` } : b;
      const days = run.hours != null ? Math.round((run.hours / 24) * 100) / 100 : null;
      duration = { ...run, days, equipmentDays: days != null && d.quantity != null ? Math.round(d.quantity * days * 100) / 100 : null };
      if (run.hours == null) {
        flags.push(`No run time — ${run.basis}.`);
        if (status !== "excluded" && status !== "rejected") questions.push(`${room}: how long will the ${d.item.replace(/ \(.*$/, "")} run (hours or days)? Not in the report and no company default.`);
      } else if (run.estimated) flags.push(water && !mold ? (dryNow ? "Run time estimated — readings now meet the dry goal: enter the actual drying days." : "Run time estimated — confirm with moisture readings; enter the actual days when dry.") : "Run time estimated — confirm it.");
    }
    return { ...d, rate: null, total: null, evidence: d.evidence ?? scan.moisturePoints.map((p) => p.id), status, flags, source, duration };
  });

  if (scan.reportChanges.length) notes.push(...scan.reportChanges.map((c) => `Mold report changed: ${c}`));
  return { lines, questions, notes, takeoff: t, airMovers: am, affectedFloorSF: affFloorSF, dryingSF: water ? affFloorSF : null, pending };
}

function smokeMethod(scan: RoomScanData, R: Rules): string {
  const t = scan.loss.smokeType;
  const m = t === "wet" ? R.cleaningMethods.smoke_wet : t === "protein" ? R.cleaningMethods.smoke_protein : R.cleaningMethods.smoke_dry;
  return m.steps.join(" + ").toLowerCase();
}

/** Returns the exclusion reason if this line falls under a recorded exclusion. */
function exclusionFor(d: Draft, ctx: RoomContext): string | null {
  for (const e of ctx.exclusions) {
    const why = `${e.reason} (${e.decidedBy}, ${e.date})`;
    if (e.target === "room" && e.locationId === ctx.locationId) return `room excluded — ${why}`;
    if (d.kind === "contents") {
      // moving contents to reach the structure is structural access, not contents cleaning
      if (d.id === "contents.manip" || d.id === "contents.cabinets.manip") continue;
      if (e.target === "contents_all" || (e.target === "service_line" && e.serviceLine === "contents")) return `contents work declined — ${why}`;
      if (e.target === "contents_cleaning" && (d.id === "contents.clean" || d.id === "contents.cabinets.clean" || d.id === "contents.evaluate")) return `contents cleaning declined — ${why}`;
      if (e.target === "contents_packout" && (d.id === "contents.packout" || d.id === "contents.cabinets.packout")) return `pack-out declined — ${why}`;
    }
    if (e.target === "service_line" && e.serviceLine === "reconstruction" && d.kind === "reconstruction") return `reconstruction excluded — ${why}`;
    if (e.target === "service_line" && e.serviceLine === "mitigation" && (d.kind === "mitigation" || d.kind === "equipment" || d.kind === "monitoring")) return `mitigation excluded — ${why}`;
  }
  return null;
}
