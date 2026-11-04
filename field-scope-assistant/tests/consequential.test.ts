import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, mergeRules } from "@/lib/defaults";
import { analyzeRoom, type RoomContext } from "@/lib/roomRules";
import { RoomScanData, type ScopeLine } from "@/lib/scan";
import { baseboardLF, takeoff, wallPaintSF } from "@/lib/takeoff";

/**
 * Regression lock for "what goes with it" (consequential work). The class of mistake:
 *  - painting / replacing the REMOVED item itself instead of the adjacent continuous surface
 *    ("remove baseboard → paint baseboard");
 *  - quantity/unit mismatches (wall paint in baseboard LF or floor SF, full-ceiling paint
 *    measured as the affected patch, baseboard reset measured in floor SF).
 */

const ctx = (over: Partial<RoomContext> = {}): RoomContext => ({
  rules: DEFAULT_RULES,
  roomLabel: "Test room",
  run: [],
  exclusions: [],
  locationId: "loc_t",
  reconstructionRequested: true,
  yearBuilt: 1995,
  ...over,
});
const MEAS = { lengthFt: 12, widthFt: 10, heightFt: 8, openings: [{ id: "d1", kind: "door", wall: "S", widthIn: 36, heightIn: 80, offsetFt: 2 }] };
const line = (ls: ScopeLine[], id: string) => ls.find((l) => l.id === id);
const labelsIn = (item: string) => (item.match(/\(([^)]*)\)\s*$/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

describe("baseboard removal (reported case)", () => {
  const scan = RoomScanData.parse({
    loss: { type: "water", category: "2" },
    source: { status: "repaired" },
    materials: { baseboard: { affected: true, walls: ["E", "S"], action: "remove" }, flooring: { type: "LVP", affected: true, action: "dry_in_place" } },
    measurements: MEAS,
  });
  const a = analyzeRoom(scan, ctx());

  it("removal → new baseboard (LF) + seal/prime & paint the FULL continuous wall (wall SF)", () => {
    // baseboard: E 10 + S (12 − 3 door) = 19 LF
    expect(line(a.lines, "baseboard")).toMatchObject({ activity: "Remove", quantity: 19, unit: "LF" });
    expect(line(a.lines, "baseboard.replace")).toMatchObject({ activity: "Replace", quantity: 19, unit: "LF" });
    // full walls: E 10×8 = 80 SF; S 12×8 = 96 − door 20 = 76 SF → 156 SF
    const paint = line(a.lines, "walls.paint")!;
    expect(paint).toMatchObject({ activity: "Seal/prime & paint", quantity: 156, unit: "SF", scopeCategory: "painting" });
    expect(labelsIn(paint.item)).toEqual(["E", "S"]);
    expect(paint.justification).toMatch(/E: baseboard removed/);
    expect(paint.justification).toMatch(/full continuous wall/);
  });

  it("never repaints the baseboard and never sizes wall paint from baseboard LF or floor SF", () => {
    expect(line(a.lines, "baseboard.paint")).toBeUndefined();
    for (const l of a.lines.filter((x) => x.scopeCategory === "painting")) {
      expect(l.item).not.toMatch(/baseboard|base board|trim|toe kick/i);
      expect(l.unit).toBe("SF");
    }
    const paint = line(a.lines, "walls.paint")!;
    expect(paint.quantity).not.toBe(19); // baseboard LF
    expect(paint.quantity).not.toBe(120); // floor SF
  });

  it("a stored legacy rule override with paintBaseboard:true cannot bring the line back", () => {
    const rules = mergeRules({ whatGoesWithIt: { ...DEFAULT_RULES.whatGoesWithIt, baseboardRemoval: { enabled: true, sealPrimePaintFullWall: true, replaceBaseboard: true, paintBaseboard: true } } });
    expect("paintBaseboard" in rules.whatGoesWithIt.baseboardRemoval).toBe(false);
    const b = analyzeRoom(scan, ctx({ rules }));
    expect(b.lines.some((l) => l.scopeCategory === "painting" && /baseboard/i.test(l.item))).toBe(false);
    expect(line(b.lines, "walls.paint")?.quantity).toBe(156);
  });

  it("an unmeasured painted wall leaves the quantity blank instead of a partial sum", () => {
    const s = RoomScanData.parse({ ...scan, measurements: { segments: [{ label: "E", lengthFt: 10 }], heightFt: 8, openings: [] } });
    const p = line(analyzeRoom(s, ctx()).lines, "walls.paint")!;
    expect(p.quantity).toBeNull();
    expect(p.calc).toMatch(/S wall: not measured/);
  });
});

describe("other consequential rules (same class)", () => {
  it("flooring replacement: baseboard detach & reset in LF on walls whose base is not replaced — never floor SF", () => {
    const s = RoomScanData.parse({
      loss: { type: "water", category: "1" },
      source: { status: "repaired" },
      materials: { flooring: { type: "LVP", affected: true, action: "replace", continuousRun: "A" }, baseboard: { affected: true, walls: ["E"], action: "remove" } },
      measurements: MEAS,
    });
    const a = analyzeRoom(s, ctx());
    const reset = line(a.lines, "floor.baseboard.reset")!;
    // N 12 + S (12 − 3) + W 10 = 31 LF (E gets new baseboard instead)
    expect(reset).toMatchObject({ unit: "LF", quantity: 31, activity: "Detach & reset" });
    expect(labelsIn(reset.item)).toEqual(["N", "S", "W"]);
    expect(reset.quantity).not.toBe(120);
    expect(line(a.lines, "floor.replace")).toMatchObject({ unit: "SF", quantity: 120 });
    // flooring replacement alone does not paint walls; only the removed-baseboard wall is painted
    expect(labelsIn(line(a.lines, "walls.paint")!.item)).toEqual(["E"]);
  });

  it("ceiling removal: the removed drywall is replaced (same SF) and the FULL ceiling is painted", () => {
    const s = RoomScanData.parse({
      loss: { type: "water", category: "1" },
      source: { status: "repaired" },
      materials: { ceiling: { affected: true, affectedPct: 25, action: "remove" }, insulation: true },
      measurements: MEAS,
    });
    const a = analyzeRoom(s, ctx());
    expect(line(a.lines, "ceiling.remove")).toMatchObject({ quantity: 30, unit: "SF" });
    expect(line(a.lines, "ceiling.replace")).toMatchObject({ quantity: 30, unit: "SF", kind: "reconstruction" });
    expect(line(a.lines, "ceiling.insulation.replace")).toMatchObject({ quantity: 30, unit: "SF" });
    expect(line(a.lines, "ceiling.paint")).toMatchObject({ quantity: 120, unit: "SF" }); // full ceiling, not the 25% patch
  });

  it("stained ceiling (seal/paint): full ceiling SF regardless of the affected %", () => {
    const s = RoomScanData.parse({ loss: { type: "water", category: "1" }, materials: { ceiling: { affected: true, affectedPct: 10, action: "seal_paint" } }, measurements: MEAS });
    expect(line(analyzeRoom(s, ctx()).lines, "ceiling.paint")).toMatchObject({ quantity: 120, unit: "SF" });
  });

  it("toe kick removed for drying goes back on (same LF)", () => {
    const s = RoomScanData.parse({ loss: { type: "water", category: "1" }, materials: { cabinets: { affected: true, lf: 9, detach: false } }, measurements: MEAS });
    const a = analyzeRoom(s, ctx());
    expect(line(a.lines, "cabinets.toekick")).toMatchObject({ quantity: 9, unit: "LF" });
    expect(line(a.lines, "cabinets.toekick.reinstall")).toMatchObject({ quantity: 9, unit: "LF", activity: "Reinstall" });
  });

  it("flood cut without the baseboard marked asks about the baseboard", () => {
    const s = RoomScanData.parse({
      loss: { type: "water", category: "2" },
      materials: { walls: { material: "drywall", affectedWalls: ["N"], wetHeightIn: 6, floodCut: "auto" } },
      measurements: MEAS,
    });
    expect(analyzeRoom(s, ctx()).questions.join(" ")).toMatch(/flood cut on N — the baseboard/);
  });
});

// ---------------------------------------------------------------------------
// Sweep: every combination below must satisfy the invariants.
// ---------------------------------------------------------------------------
const CATS = ["1", "2", "3", null] as const;
const LOSS = ["water", "fire"] as const;
const FLOOR = [null, "dry_in_place", "remove", "replace"] as const;
const FTYPE = ["LVP", "carpet"] as const;
const BB = [null, "remove", "detach_reset"] as const;
const FC = ["auto", 24] as const;
const CEIL = [null, "seal_paint", "remove"] as const;
const CAB = [null, "toekick", "detach"] as const;

function* combos() {
  for (const cat of CATS)
    for (const loss of LOSS)
      for (const fl of FLOOR)
        for (const ft of FTYPE)
          for (const bb of BB)
            for (const fc of FC)
              for (const ce of CEIL)
                for (const cab of CAB)
                  yield RoomScanData.parse({
                    loss: { type: loss, category: loss === "water" ? cat : null },
                    source: { status: "repaired" },
                    materials: {
                      flooring: { type: ft, affected: true, affectedPct: 50, action: fl, continuousRun: fl === "replace" ? "A" : null },
                      baseboard: { affected: bb != null, walls: bb ? ["E", "S"] : [], action: bb },
                      walls: { material: "drywall", affectedWalls: ["E", "N"], wetHeightIn: 10, floodCut: fc },
                      ceiling: { affected: ce != null, affectedPct: 40, action: ce },
                      insulation: true,
                      cabinets: { affected: cab != null, lf: 8, detach: cab === "detach" },
                      fixtures: ["toilet"],
                    },
                    measurements: MEAS,
                  });
}

describe("invariant sweep over consequential rules", () => {
  it("holds for every combination", () => {
    let n = 0;
    for (const scan of combos()) {
      n++;
      const a = analyzeRoom(scan, ctx());
      const t = takeoff(scan.measurements);
      const L = a.lines;
      const where = () => JSON.stringify({ loss: scan.loss, m: scan.materials });

      // 1. Painting is always area-based and always on a surface — never on the removed trim/flooring item.
      for (const l of L.filter((x) => x.scopeCategory === "painting")) {
        expect(l.unit, where()).toBe("SF");
        expect(l.item, where()).not.toMatch(/baseboard|base board|trim|toe kick|carpet|pad|LVP|flooring|cabinet/i);
      }
      // 2. No "Paint"/"Replace" line repeats a removed linear item in SF, and no removed item is repainted.
      const removed = L.filter((l) => /^(Remove|Flood cut|Detach)/.test(l.activity));
      for (const r of removed) {
        const noun = r.item.split(/[ (—]/)[0].toLowerCase();
        expect(L.some((l) => l.scopeCategory === "painting" && l.item.toLowerCase().startsWith(noun)), `${noun} repainted ${where()}`).toBe(false);
      }
      // 3. Full-wall paint = the full SF of exactly the walls it names, and covers every wall whose base was removed or drywall replaced.
      const wp = line(L, "walls.paint");
      if (wp) {
        const labs = labelsIn(wp.item);
        const expected = labs.reduce((s, lab) => s + (wallPaintSF(t.walls.find((w) => w.label === lab)!, t.heightFt).sf ?? 0), 0);
        expect(wp.quantity, where()).toBeCloseTo(expected, 1);
        const bbLF = t.walls.filter((w) => labs.includes(w.label)).reduce((s, w) => s + baseboardLF(w).lf, 0);
        expect(wp.quantity, where()).not.toBe(bbLF);
        if (line(L, "baseboard.replace")) for (const w of ["E", "S"]) expect(labs, where()).toContain(w);
        if (line(L, "drywall.replace")) for (const w of ["E", "N"]) expect(labs, where()).toContain(w);
      }
      if (line(L, "baseboard.replace") || line(L, "drywall.replace")) expect(wp, `missing full-wall paint ${where()}`).toBeDefined();
      // 4. Ceiling paint is the full ceiling, never the affected patch.
      const cp = line(L, "ceiling.paint");
      if (cp) expect(cp.quantity, where()).toBe(t.ceilingSF);
      // 5. Every removal that needs to go back has its put-back line, same quantity and unit.
      const pairs: [string, string][] = [
        ["ceiling.remove", "ceiling.replace"],
        ["cabinets.toekick", "cabinets.toekick.reinstall"],
        ["cabinets.detach", "cabinets.reset"],
        ["floodcut", "drywall.replace"],
      ];
      if (scan.materials.baseboard.action === "remove") pairs.push(["baseboard", "baseboard.replace"]);
      for (const [rm, back] of pairs) {
        const r = line(L, rm);
        if (!r) continue;
        const b = line(L, back);
        expect(b, `${rm} without ${back} ${where()}`).toBeDefined();
        expect([b!.quantity, b!.unit], where()).toEqual([r.quantity, r.unit]);
      }
      // 6. Linear items are measured in LF; baseboard reset for flooring is never floor SF.
      for (const id of ["baseboard", "baseboard.replace", "floor.baseboard.reset", "cabinets.toekick", "cabinets.toekick.reinstall", "cabinets.reset"]) {
        const l = line(L, id);
        if (l) expect(l.unit, `${id} ${where()}`).toBe("LF");
      }
      const reset = line(L, "floor.baseboard.reset");
      if (reset) {
        const labs = labelsIn(reset.item);
        expect(reset.quantity).toBeCloseTo(t.walls.filter((w) => labs.includes(w.label)).reduce((s, w) => s + baseboardLF(w).lf, 0), 1);
        if (line(L, "baseboard.replace")) for (const w of ["E", "S"]) expect(labs).not.toContain(w); // replaced, not reset
      }
      if (line(L, "floor.replace")) expect(reset, `flooring replaced without baseboard reset ${where()}`).toBeDefined();
    }
    expect(n).toBe(4 * 2 * 4 * 2 * 3 * 2 * 3 * 3);
  });
});
