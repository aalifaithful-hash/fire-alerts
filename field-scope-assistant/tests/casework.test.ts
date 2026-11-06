import { describe, expect, it } from "vitest";
import { analyzeRoom, type RoomContext } from "@/lib/roomRules";
import { DEFAULT_RULES, mergeRules } from "@/lib/defaults";
import { Exclusion, RoomScanData, type ScopeLine } from "@/lib/scan";
import { rulesAnalyze } from "@/lib/report/rules";
import { applyVisit, proposeVisit, stillMissing } from "@/lib/report/match";

/** Cabinets, countertops, vanity, backsplash — rules only, no AI. Every quantity shows its math; nothing is guessed. */

const ctx = (over: Partial<RoomContext> = {}): RoomContext => ({ rules: DEFAULT_RULES, roomLabel: "Unit 4D — Kitchen", run: [], exclusions: [], locationId: "l", reconstructionRequested: false, yearBuilt: 1925, ...over });
const scan = (materials: Record<string, unknown>, loss: Record<string, unknown> = { type: "water", category: "2" }) =>
  RoomScanData.parse({ loss, source: { status: "repaired" }, materials, measurements: { lengthFt: 12, widthFt: 10, heightFt: 8 } });
const line = (ls: ScopeLine[], id: string) => {
  const l = ls.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}; have: ${ls.map((x) => x.id).join(", ")}`);
  return l;
};
const KITCHEN = [
  { kind: "lower", action: "remove_replace", lf: 7, wall: "N" },
  { kind: "sink_base", action: "remove_replace", lf: 3, wall: "N" },
  { kind: "upper", action: "detach_reset", lf: 8, wall: "N" },
  { kind: "countertop", action: null, lf: 10, material: "granite" },
];

describe("Kitchen: upper + lower + sink base + countertop", () => {
  const a = analyzeRoom(scan({ casework: KITCHEN, caseworkContents: "packout" }), ctx());
  const ids = a.lines.map((l) => l.id);

  it("cabinet lines in LF with the measured math", () => {
    expect(line(a.lines, "cw.lower.remove")).toMatchObject({ kind: "mitigation", quantity: 7, unit: "LF" });
    expect(line(a.lines, "cw.lower.replace")).toMatchObject({ kind: "reconstruction", quantity: 7, unit: "LF" });
    expect(line(a.lines, "cw.sink_base.remove")).toMatchObject({ quantity: 3, unit: "LF" });
    expect(line(a.lines, "cw.upper.detach")).toMatchObject({ kind: "mitigation", quantity: 8, unit: "LF" });
    expect(line(a.lines, "cw.upper.reset")).toMatchObject({ kind: "reconstruction", quantity: 8, unit: "LF" });
  });

  it("countertop follows the base cabinets out — removal in LF, new top in SF (10 LF × 25.5\" = 21.3 SF, company default named)", () => {
    const r = line(a.lines, "cw.countertop.remove");
    expect(r).toMatchObject({ quantity: 10, unit: "LF" });
    expect(r.item).toContain("10 LF / 21.3 SF");
    const n = line(a.lines, "cw.countertop.replace");
    expect(n).toMatchObject({ kind: "reconstruction", quantity: 21.3, unit: "SF" });
    expect(n.calc).toContain('10 LF × 25.5" depth (company default');
    expect(n.calc).toContain("= 21.3 SF");
    expect(a.questions.join(" ")).not.toMatch(/Countertop — clean, detach/);
  });

  it("toe kick = base LF (7 + 3), sink plumbing 1 EA each way", () => {
    const t = line(a.lines, "cw.toe_kick.with_base");
    expect(t).toMatchObject({ quantity: 10, unit: "LF" });
    expect(t.calc).toMatch(/7 LF \+ .*3 LF = 10 LF/);
    expect(line(a.lines, "cw.plumbing.disconnect")).toMatchObject({ quantity: 1, unit: "EA" });
    expect(line(a.lines, "cw.plumbing.reconnect")).toMatchObject({ quantity: 1, unit: "EA" });
  });

  it("wall behind the upper cabinets in wall SF (12 × 8 = 96), not cabinet LF", () => {
    const paint = a.lines.find((l) => /seal|prime|paint/i.test(l.activity + l.item) && l.unit === "SF");
    expect(paint?.quantity).toBe(96);
  });

  it("cabinet contents packed out; backsplash asked about, never assumed", () => {
    expect(ids).toContain("contents.cabinets.packout");
    expect(a.questions.join(" ")).toMatch(/backsplash/i);
  });

  it("water behind/under base cabinets is flagged, uppers aren't (water)", () => {
    expect(line(a.lines, "cw.lower.remove").flags.join(" ")).toMatch(/behind or under cabinets/);
    expect(line(a.lines, "cw.upper.detach").flags.join(" ")).not.toMatch(/behind or under cabinets/);
  });

  it("stone countertop reset is warned; replacement is pending reconstruction", () => {
    const b = analyzeRoom(scan({ casework: [{ kind: "lower", action: "detach_reset", lf: 6 }, { kind: "countertop", action: null, lf: 6, material: "quartz" }] }), ctx());
    expect(line(b.lines, "cw.countertop.detach").flags.join(" ")).toMatch(/Stone top/);
    expect(line(b.lines, "cw.countertop.detach")).toMatchObject({ quantity: 6, unit: "LF" });
    expect(line(b.lines, "cw.countertop.reset")).toMatchObject({ quantity: 6, unit: "LF" });
    expect(line(a.lines, "cw.countertop.replace").status).not.toBe("accepted");
  });
});

describe("never guessed", () => {
  it("no LF → no quantity, and a measure question", () => {
    const a = analyzeRoom(scan({ casework: [{ kind: "lower", action: "remove_dispose", lf: null }] }), ctx());
    const r = line(a.lines, "cw.lower.dispose");
    expect(r.quantity).toBeNull();
    expect(a.questions.join(" ")).toMatch(/LF|length/i);
  });
  it("no material → flagged on the countertop", () => {
    const a = analyzeRoom(scan({ casework: [{ kind: "lower", action: "remove_replace", lf: 5 }, { kind: "countertop", action: null, lf: 5 }] }), ctx());
    expect(line(a.lines, "cw.countertop.remove").flags.join(" ")).toMatch(/Material not selected/);
  });
  it("base cabinets out with no countertop listed → the countertop is still addressed (never left floating)", () => {
    const a = analyzeRoom(scan({ casework: [{ kind: "lower", action: "remove_replace", lf: 9 }] }), ctx());
    expect(a.lines.some((l) => l.id.startsWith("cw.countertop"))).toBe(true);
  });
  it("countertop off with no cabinets listed → asks about the cabinets below", () => {
    const a = analyzeRoom(scan({ casework: [{ kind: "countertop", action: "remove_replace", lf: 8, material: "laminate" }] }), ctx());
    expect(a.questions.join(" ")).toMatch(/cabinets below/i);
  });
  it("water/mold with no action → inspect line (not assumed clean) + a question; mold adds a remove-if-found line", () => {
    const w = analyzeRoom(scan({ casework: [{ kind: "lower", action: null, lf: 6 }] }), ctx());
    expect(line(w.lines, "cw.lower.inspect").activity).toBe("Inspect");
    expect(w.questions.join(" ")).toMatch(/Lower cabinets/);
    const m = analyzeRoom(scan({ casework: [{ kind: "lower", action: null, lf: 6 }] }, { type: "mold" }), ctx());
    expect(line(m.lines, "cw.lower.mold").item).toMatch(/if found/);
  });
  it("doors / drawer fronts in EA from the count only", () => {
    const a = analyzeRoom(scan({ casework: [{ kind: "doors_drawers", action: "remove_replace", count: 6 }, { kind: "hardware", action: "detach_reset", count: null }] }), ctx());
    expect(line(a.lines, "cw.doors_drawers.remove")).toMatchObject({ quantity: 6, unit: "EA" });
    expect(line(a.lines, "cw.hardware.detach").quantity).toBeNull();
  });
});

describe("rules and exclusions", () => {
  it("company depth from Settings → Rules & defaults", () => {
    const rules = mergeRules({ casework: { ...DEFAULT_RULES.casework, countertopDepthIn: 24 } });
    const a = analyzeRoom(scan({ casework: KITCHEN }), ctx({ rules }));
    expect(line(a.lines, "cw.countertop.replace")).toMatchObject({ quantity: 20, unit: "SF" }); // 10 × 24/12
    expect(line(a.lines, "cw.countertop.remove")).toMatchObject({ quantity: 10, unit: "LF" });
  });
  it("customer declines pack-out → cabinet contents pack-out excluded with the wording", () => {
    const ex = Exclusion.parse({ id: "x", target: "contents_packout", reason: "customer declined", decidedBy: "customer", date: "2026-11-06", signature: "verbal" });
    const a = analyzeRoom(scan({ casework: KITCHEN, caseworkContents: "packout" }), ctx({ exclusions: [ex] }));
    expect(line(a.lines, "contents.cabinets.packout").status).toBe("excluded");
  });
});

// A FICTIONAL kitchen mold report (no real customer content).
const KITCHEN_REPORT = [
  `MOLD ASSESSMENT REPORT — SAMPLE
Property: 12 Sample Ave, New York, NY 10001. Prepared for: Test Customer. Date: 2026-10-01.
Kitchen: Visible mold growth was observed on the back panel and floor of the sink base cabinet. The lower cabinets on the sink wall show water staining.
Remediation: Remove and dispose of the sink base cabinet. The lower cabinets adjacent to the sink must be detached for inspection. The countertop must be removed to access the cabinets.
Living Room: The cabinets were inspected.`,
];

describe("mold report naming cabinets", () => {
  const f = rulesAnalyze(KITCHEN_REPORT);
  const kinds = (f.caseworkMentions ?? []).map((m) => `${m.value.room}:${m.value.kind}:${m.value.action}`);

  it("surfaces each item with its quoted source, room and action — generic 'cabinets' never assumed", () => {
    expect(kinds).toEqual(expect.arrayContaining(["Kitchen:sink_base:remove_dispose", "Kitchen:lower:detach_reset", "Kitchen:countertop:null"]));
    const sb = f.caseworkMentions!.find((m) => m.value.kind === "sink_base")!;
    expect(sb.quote).toMatch(/sink base cabinet/);
    expect(sb.page).toBe(1);
    expect(f.caseworkMentions!.find((m) => m.value.kind === "lower")!.value.growth).toBe(true); // "water staining", kept when merged with the detach statement
    // "removed to access the cabinets" — remove with no how: a question, never read as dispose
    expect(f.caseworkMentions!.find((m) => m.value.kind === "countertop")!.value).toMatchObject({ action: null, removeOnly: true, removeHint: "access" });
    expect((f.caseworkUnspecified ?? []).map((u) => u.quote).join(" ")).toMatch(/The cabinets were inspected/);
  });

  it("proposes the matching changes, applies them, and the lines carry the quote", () => {
    const empty = RoomScanData.parse({ loss: { type: "mold" }, measurements: { lengthFt: 12, widthFt: 10, heightFt: 8 } });
    const { plans, changes } = proposeVisit(f, [{ locationId: "k", label: "Kitchen", roomName: "Kitchen", scan: empty }], 1925);
    const cw = changes.filter((c) => c.key.startsWith("casework."));
    expect(cw.map((c) => c.key)).toEqual(expect.arrayContaining(["casework.sink_base", "casework.lower", "casework.countertop"]));
    expect(cw.every((c) => c.quote && !c.conflict)).toBe(true);
    const ct = cw.find((c) => c.key === "casework.countertop")!;
    expect(ct).toMatchObject({ optional: true, quote: "The countertop must be removed to access the cabinets." });
    expect(ct.proposed).toMatch(/detach & reset, remove & replace, or remove & dispose\?.*usually means detach & reset.*not picked/);
    expect(cw.filter((c) => c.key !== "casework.countertop").every((c) => !c.optional)).toBe(true);
    const r = applyVisit(f, plans, changes, cw.map((c) => c.id), "doc1");
    const k = r.rooms.find((x) => x.plan.target?.locationId === "k")!.scan;
    expect(k.materials.casework.map((i) => `${i.kind}:${i.action}`)).toEqual(expect.arrayContaining(["sink_base:remove_dispose", "lower:detach_reset", "countertop:null"]));
    expect(k.materials.casework.every((i) => i.lf == null)).toBe(true); // LF not in the report → not guessed
    const a = analyzeRoom(k, ctx({ report: f, roomLabel: "Kitchen" }));
    expect(line(a.lines, "cw.sink_base.dispose").justification).toMatch(/Report \(p\.1\): “.*sink base cabinet/);
    expect(line(a.lines, "cw.sink_base.dispose").quantity).toBeNull();
    expect(line(a.lines, "cw.sink_base.dispose").justification).toMatch(/as the mold report states/);
  });

  it("PM already chose a different action → conflict, off by default", () => {
    const pm = RoomScanData.parse({ loss: { type: "mold" }, materials: { casework: [{ kind: "sink_base", action: "clean", lf: 3 }] } });
    const { changes } = proposeVisit(f, [{ locationId: "k", label: "Kitchen", roomName: "Kitchen", scan: pm }], 1925);
    expect(changes.find((c) => c.key === "casework.sink_base")).toMatchObject({ conflict: true, current: "Affected — clean" });
  });

  it("still missing: LF and material, the remove-how question with its quote, and which generic cabinets — no floor area for cabinet-only growth", () => {
    const miss = stillMissing(f, { yearBuiltKnown: true, runKnown: true }).join("\n");
    expect(miss).toMatch(/Kitchen: countertop — the report says “The countertop must be removed to access the cabinets\.” \(p\.1\): detach & reset, remove & replace, or remove & dispose\?/);
    expect(miss).not.toMatch(/Kitchen: affected area/);
    expect(miss).not.toMatch(/Kitchen: room measurements/);
    expect(f.rooms.find((r) => r.value.name === "Kitchen")!.value.surfaces).toEqual(["cabinet"]);
    expect(miss).toMatch(/Kitchen: sink base cabinet length \(LF\) — not in the report/);
    expect(miss).toMatch(/Kitchen: countertop material and length/);
    expect(miss).toMatch(/Which cabinets \(upper \/ lower \/ vanity\)\?/);
  });
});

describe("a report without cabinets invents none", () => {
  it("Kitchen 'wall by the A/C' report structure → no casework mentions or lines", () => {
    const f = rulesAnalyze([
      `MOLD ASSESSMENT REPORT — SAMPLE
Kitchen: Visible mold growth was observed on the drywall of the wall by the A/C unit. Den: Mold growth was observed on the wood flooring.
Remediation: Remove drywall 2 feet from the floor along the affected wall in the Kitchen.`,
    ]);
    expect(f.caseworkMentions ?? []).toHaveLength(0);
    expect(f.caseworkUnspecified ?? []).toHaveLength(0);
    const { changes } = proposeVisit(f, [{ locationId: "k", label: "Kitchen", roomName: "Kitchen", scan: RoomScanData.parse({ loss: { type: "mold" } }) }], 1925);
    expect(changes.some((c) => c.key.startsWith("casework."))).toBe(false);
  });
});

describe("Adam's defaults", () => {
  it("plain 'remove' is never read as dispose; damaged wording hints replace/dispose; explicit dispose/replace still read", () => {
    const f = rulesAnalyze([`SAMPLE REPORT\nKitchen: The lower cabinets are water damaged and must be removed. Remove and replace the countertop. Discard the upper cabinets.`]);
    const v = (k: string) => f.caseworkMentions!.find((m) => m.value.kind === k)!.value;
    expect(v("lower")).toMatchObject({ action: null, removeOnly: true, removeHint: "damaged" });
    expect(v("countertop")).toMatchObject({ action: "remove_replace", removeOnly: false });
    expect(v("upper")).toMatchObject({ action: "remove_dispose" });
  });
  it("the remove-only change stays off when the report is applied with the defaults", () => {
    const f = rulesAnalyze(KITCHEN_REPORT);
    const empty = RoomScanData.parse({ loss: { type: "mold" } });
    const { plans, changes } = proposeVisit(f, [{ locationId: "k", label: "Kitchen", roomName: "Kitchen", scan: empty }], 1925);
    const r = applyVisit(f, plans, changes, changes.filter((c) => !c.conflict && !c.optional).map((c) => c.id), "doc1");
    const k = r.rooms[0].scan;
    expect(k.materials.casework.some((i) => i.kind === "countertop")).toBe(false);
    expect(k.materials.flooring.affected).toBe(false); // cabinet-only growth: no floor
  });
  it("backsplash height has no default — blank stays blank", () => {
    const a = analyzeRoom(scan({ casework: [{ kind: "backsplash", action: "remove_replace", lf: 8, material: "tile" }] }), ctx());
    const l = line(a.lines, "cw.backsplash.remove");
    expect(l.quantity).toBeNull();
    expect(l.calc).toMatch(/height not measured.*no default height/);
    expect(DEFAULT_RULES.casework).not.toHaveProperty("backsplashHeightIn");
  });
  it("cabinet growth with floor growth stated still asks for the floor area", () => {
    const f = rulesAnalyze([`SAMPLE REPORT\nKitchen: Visible mold growth was observed on the sink base cabinet and on the kitchen floor.`]);
    expect(f.rooms[0].value.surfaces ?? []).not.toEqual(["cabinet"]);
    expect(stillMissing(f, { yearBuiltKnown: true, runKnown: true }).join("\n")).toMatch(/Kitchen: affected area/);
  });
});
