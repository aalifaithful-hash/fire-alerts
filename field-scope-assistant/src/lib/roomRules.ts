import type { Rules } from "./defaults";
import type { Exclusion, RoomScanData, ScopeLine } from "./scan";
import { baseboardLF, floodCutSF, r1, takeoff, wallPaintSF, type Takeoff } from "./takeoff";

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
}

export interface RoomAnalysis {
  lines: ScopeLine[];
  questions: string[];
  notes: string[];
  takeoff: Takeoff;
  airMovers: { min: number; max: number; recommended: number; calc: string } | null;
  affectedFloorSF: number | null;
}

type Draft = Omit<ScopeLine, "status" | "rate" | "total" | "evidence" | "flags"> & { flags?: string[]; evidence?: string[] };

const isDemo = (l: Draft) => /^(Remove|Flood cut|Tear out)/i.test(l.activity);

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

export function analyzeRoom(scan: RoomScanData, ctx: RoomContext): RoomAnalysis {
  const R = ctx.rules;
  const t = takeoff(scan.measurements);
  const m = scan.materials;
  const cat = scan.loss.category;
  const water = scan.loss.type === "water" || scan.loss.type === "sewage" || (scan.loss.type == null && scan.source.waterSource != null);
  const fireSmoke = scan.loss.type === "fire" || scan.loss.type === "smoke";
  const drafts: Draft[] = [];
  const questions: string[] = [];
  const notes: string[] = [];
  const add = (d: Draft) => drafts.push(d);
  const room = ctx.roomLabel;

  // ---------------- measurements & basics ----------------
  if (!t.floorSF) questions.push(`${room}: enter length and width — quantities stay blank until measured.`);
  if (!t.heightFt) questions.push(`${room}: enter ceiling height for wall and paint quantities.`);
  if (scan.source.status === "unknown") questions.push(`${room}: is the source stopped or repaired?`);
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

  // ---------------- flooring ----------------
  const pct = m.flooring.affectedPct ?? (m.flooring.affected ? 100 : 0);
  const affFloorSF = t.floorSF != null && m.flooring.affected ? r1((t.floorSF * pct) / 100) : null;
  const floorCalc = t.floorSF != null ? `${t.floorCalc}${pct !== 100 ? ` × ${pct}% = ${affFloorSF} SF` : ""}` : "floor not measured";
  const ftype = (m.flooring.type ?? "").toLowerCase();
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
  if (m.flooring.action === "replace" && !m.flooring.continuousRun)
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
    if (R.whatGoesWithIt.flooringReplacement.reinstallBaseAndTransitions) {
      const doors = scan.measurements.openings.filter((o) => o.kind !== "window").length;
      add({ id: "floor.transitions", ruleId: "whatGoesWithIt.flooringReplacement", kind: "reconstruction", scopeCategory: "finish", activity: "Reinstall", item: "transitions / thresholds at openings", quantity: doors || null, unit: "EA", calc: doors ? `${doors} door/opening(s) recorded` : "no openings recorded", justification: "Goes with flooring replacement." });
    }
    for (const fx of m.fixtures.filter((f) => R.whatGoesWithIt.flooringReplacement.detachResetFixtures.some((d) => f.toLowerCase().includes(d))))
      add({ id: `fixture.reset:${fx}`, ruleId: "whatGoesWithIt.flooringReplacement", kind: "reconstruction", scopeCategory: "detach_reset", activity: "Detach & reset", item: fx, quantity: 1, unit: "EA", calc: "1 per fixture on the replaced floor", justification: "Fixture sits on the flooring being replaced." });
  }

  // ---------------- walls: baseboard, flood cut, insulation ----------------
  const affectedWalls = t.walls.filter((w) => m.walls.affectedWalls.includes(w.label));
  const bbWallLabels = m.baseboard.walls.length ? m.baseboard.walls : m.walls.affectedWalls;
  const bbWalls = t.walls.filter((w) => bbWallLabels.includes(w.label));
  if (m.baseboard.affected && !bbWallLabels.length) questions.push(`${room}: which walls' baseboard is affected?`);
  const bbAction = m.baseboard.action ?? (cat === "2" || cat === "3" ? "remove" : "detach_reset");
  const paintWalls = new Set<string>();
  if (m.baseboard.affected && bbWallLabels.length) {
    const parts = bbWalls.map(baseboardLF);
    const lf = bbWalls.length ? r1(parts.reduce((a, p) => a + p.lf, 0)) : null;
    const calc = parts.length ? parts.map((p) => p.calc).join("; ") : "walls not measured";
    add({ id: "baseboard", ruleId: "baseboard", kind: "mitigation", scopeCategory: bbAction === "remove" ? "removal" : "detach_reset", activity: bbAction === "remove" ? "Remove" : "Detach & reset", item: `baseboard (${bbWallLabels.join(", ")})`, quantity: lf, unit: "LF", calc, justification: bbAction === "remove" ? `Category ${cat ?? "?"} contact / wet baseboard — removed for drying access.` : "Detached for drying access behind it; reset after drying." });
    if (bbAction === "remove" && R.whatGoesWithIt.baseboardRemoval.enabled) {
      if (R.whatGoesWithIt.baseboardRemoval.replaceBaseboard)
        add({ id: "baseboard.replace", ruleId: "whatGoesWithIt.baseboardRemoval", kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: `baseboard (${bbWallLabels.join(", ")})`, quantity: lf, unit: "LF", calc, justification: "Goes with baseboard removal." });
      if (R.whatGoesWithIt.baseboardRemoval.paintBaseboard)
        add({ id: "baseboard.paint", ruleId: "whatGoesWithIt.baseboardRemoval", kind: "reconstruction", scopeCategory: "painting", activity: "Paint", item: "baseboard", quantity: lf, unit: "LF", calc, justification: "Goes with baseboard replacement." });
      if (R.whatGoesWithIt.baseboardRemoval.sealPrimePaintFullWall) bbWallLabels.forEach((w) => paintWalls.add(w));
    }
  }

  const wet = m.walls.wetHeightIn;
  const drywall = m.walls.material === "drywall";
  if (affectedWalls.length || m.walls.affectedWalls.length) {
    if (m.walls.material === "plaster") questions.push(`${room}: plaster walls — dry in place or remove? (no automatic flood cut on plaster)`);
    if (wet == null) questions.push(`${room}: how high is the wet line / wicking on the walls (inches)?`);
    const explicit = typeof m.walls.floodCut === "number";
    const auto = m.walls.floodCut === "auto" && (cat === "2" || cat === "3");
    if (drywall && m.walls.floodCut === "auto" && cat !== "2" && cat !== "3")
      questions.push(`${room}: ${cat === "1" ? "Category 1 — walls are dried in place by default." : "Category not set."} Flood cut the drywall? (set a height to add it)`);
    if (drywall && wet != null && (explicit || auto) && R.whatGoesWithIt.drywallFloodCut.enabled) {
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
        m.walls.affectedWalls.forEach((w) => paintWalls.add(w));
      }
    }
  }
  if (paintWalls.size) {
    const ws = t.walls.filter((w) => paintWalls.has(w.label));
    const parts = ws.map((w) => wallPaintSF(w, t.heightFt));
    const sf = parts.length && parts.every((p) => p.sf != null) ? r1(parts.reduce((a, p) => a + (p.sf ?? 0), 0)) : null;
    add({ id: "walls.paint", ruleId: "whatGoesWithIt.paintFullWall", kind: "reconstruction", scopeCategory: "painting", activity: "Seal/prime & paint", item: `full continuous wall to natural break (${[...paintWalls].join(", ")})`, quantity: sf, unit: "SF", calc: parts.length ? parts.map((p) => p.calc).join("; ") : "walls not measured", justification: "Baseboard/drywall repair on these walls — the full continuous wall is painted to the natural break so the finish matches." });
  }

  // ---------------- ceiling ----------------
  if (m.ceiling.affected) {
    const cpct = m.ceiling.affectedPct ?? 100;
    const csf = t.ceilingSF != null ? r1((t.ceilingSF * cpct) / 100) : null;
    const ccalc = t.ceilingSF != null ? `${t.floorCalc} (ceiling)${cpct !== 100 ? ` × ${cpct}% = ${csf} SF` : ""}` : "ceiling not measured";
    if (m.ceiling.action === "remove")
      add({ id: "ceiling.remove", ruleId: "ceiling.remove", kind: "mitigation", scopeCategory: "removal", activity: "Remove", item: `ceiling drywall${m.insulation ? " and insulation above" : ""}`, quantity: csf, unit: "SF", calc: ccalc, justification: "Wet/sagging ceiling — removed (PM decision)." });
    if (fireSmoke)
      add({ id: "ceiling.clean", ruleId: "smoke.clean.ceiling", kind: "mitigation", scopeCategory: "cleaning", activity: "Clean", item: `ceiling — ${smokeMethod(scan, R)}`, quantity: csf, unit: "SF", calc: ccalc, justification: "Smoke/soot residue on ceiling." });
    if (R.whatGoesWithIt.ceilingStain.sealAndPaintFullCeiling && (m.ceiling.action === "seal_paint" || m.ceiling.action === "remove" || fireSmoke))
      add({ id: "ceiling.paint", ruleId: "whatGoesWithIt.ceilingStain", kind: "reconstruction", scopeCategory: "painting", activity: "Seal (stain-blocking) & paint", item: `full ceiling${m.ceiling.action === "remove" ? " after drywall replacement" : ""}`, quantity: t.ceilingSF, unit: "SF", calc: t.ceilingSF != null ? `${t.floorCalc} (full ceiling)` : "ceiling not measured", justification: "Stained/repaired area — the full ceiling is sealed and painted for a uniform finish." });
  }

  // ---------------- cabinets ----------------
  if (m.cabinets.affected) {
    const lf = m.cabinets.lf;
    const calc = lf != null ? `${lf} LF of base cabinets (measured)` : "cabinet length not measured";
    if (m.cabinets.detach)
      add({ id: "cabinets.detach", ruleId: "cabinets.detach", kind: "mitigation", scopeCategory: "detach_reset", activity: "Detach", item: "base cabinets for drying access", quantity: lf, unit: "LF", calc, justification: "Wet cavity/flooring under the cabinets needs drying access." });
    else if (R.whatGoesWithIt.cabinets.removeToeKickForDrying)
      add({ id: "cabinets.toekick", ruleId: "whatGoesWithIt.cabinets", kind: "mitigation", scopeCategory: "cavity_access", activity: "Remove", item: "toe kick for drying access", quantity: lf, unit: "LF", calc, justification: "Dry the cavity under the cabinets without detaching them." });
    if (m.cabinets.detach || (thisReplace && R.whatGoesWithIt.cabinets.detachResetWhenFlooringReplaced)) {
      add({ id: "cabinets.reset", ruleId: "whatGoesWithIt.cabinets", kind: "reconstruction", scopeCategory: "detach_reset", activity: "Reset & reattach", item: "base cabinets", quantity: lf, unit: "LF", calc, justification: m.cabinets.detach ? "Goes with cabinet detach." : "Cabinets reset when the flooring under them is replaced." });
      if (R.whatGoesWithIt.cabinets.reconnectPlumbingAndCountertop)
        add({ id: "cabinets.reconnect", ruleId: "whatGoesWithIt.cabinets", kind: "reconstruction", scopeCategory: "detach_reset", activity: "Reconnect", item: "countertop, sink plumbing and appliances as applicable", quantity: 1, unit: "EA", calc: "1 per cabinet run", justification: "Goes with cabinet reset." });
    }
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
  const lines: ScopeLine[] = drafts.map((d) => {
    const flags = [...(d.flags ?? [])];
    let status: ScopeLine["status"] = scan.decisions[d.id] ?? "suggested";
    const ex = exclusionFor(d, ctx);
    if (ex) {
      status = "excluded";
      flags.push(`Excluded: ${ex}`);
    }
    if (d.kind === "reconstruction" && !ctx.reconstructionRequested && status !== "excluded")
      flags.push("Pending reconstruction — not estimated unless a reconstruction estimate is requested.");
    if (d.quantity == null && d.unit !== "DA") flags.push("Quantity needs measurements.");
    return { ...d, rate: null, total: null, evidence: d.evidence ?? scan.moisturePoints.map((p) => p.id), status, flags };
  });

  return { lines, questions, notes, takeoff: t, airMovers: am, affectedFloorSF: affFloorSF };
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
      if (d.id === "contents.manip") continue;
      if (e.target === "contents_all" || (e.target === "service_line" && e.serviceLine === "contents")) return `contents work declined — ${why}`;
      if (e.target === "contents_cleaning" && (d.id === "contents.clean" || d.id === "contents.evaluate")) return `contents cleaning declined — ${why}`;
      if (e.target === "contents_packout" && d.id === "contents.packout") return `pack-out declined — ${why}`;
    }
    if (e.target === "service_line" && e.serviceLine === "reconstruction" && d.kind === "reconstruction") return `reconstruction excluded — ${why}`;
    if (e.target === "service_line" && e.serviceLine === "mitigation" && (d.kind === "mitigation" || d.kind === "equipment" || d.kind === "monitoring")) return `mitigation excluded — ${why}`;
  }
  return null;
}
