import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { DEFAULT_RULES, mergeRules } from "@/lib/defaults";
import { analyzeRoom, type RoomContext } from "@/lib/roomRules";
import { RoomScanData, type ScopeLine } from "@/lib/scan";
import { crewPlan, equipmentSchedule, crewText, scheduleText, type CrewRoom } from "@/lib/crew";
import { rulesAnalyze } from "@/lib/report/rules";
import { applyVisit, proposeVisit, type VisitRoom } from "@/lib/report/match";

/**
 * Crew (crew chiefs + subs) and equipment run time. Rules only, no AI. Reports here are FICTIONAL,
 * written in the structure of the Test 1 report (4 containments, 1 scrubber each, 72 h at 8 ACH,
 * equipment off 24 h before clearance) — no real report text.
 */
process.env.DATABASE_URL = "pglite://memory";
delete process.env.POSTGRES_URL;
delete process.env.APP_PASSCODE;
delete process.env.ANTHROPIC_API_KEY;
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-crew-"));

const ctx = (over: Partial<RoomContext> = {}): RoomContext => ({ rules: DEFAULT_RULES, roomLabel: "Room", run: [], exclusions: [], locationId: "l", reconstructionRequested: false, yearBuilt: 1950, ...over });
const water = (l: number, w: number, extra: Record<string, unknown> = {}) =>
  RoomScanData.parse({
    loss: { type: "water", category: "2", ...((extra.loss as object) ?? {}) },
    source: { where: "in_room", status: "repaired" },
    materials: { flooring: { type: "LVP", affected: true, affectedPct: 100 } },
    measurements: { lengthFt: l, widthFt: w, heightFt: 8 },
    ...extra,
  });
const line = (ls: ScopeLine[], id: string) => {
  const x = ls.find((l) => l.id === id);
  if (!x) throw new Error(`no ${id}: ${ls.map((l) => l.id).join(", ")}`);
  return x;
};
const room = (label: string, data: RoomScanData, c: Partial<RoomContext> = {}): CrewRoom => {
  const a = analyzeRoom(data, ctx({ roomLabel: label, ...c }));
  return { label, data: { ...data, lines: a.lines }, analysis: a };
};
const plan = (rooms: CrewRoom[], over: Partial<Parameters<typeof crewPlan>[1]> = {}) =>
  crewPlan(rooms, { rules: DEFAULT_RULES, serviceLine: null, reconstructionRequested: false, jobInfo: { crewChiefs: null, subcontractors: null, subTrades: [] }, ...over });

// A FICTIONAL report in the Test 1 structure.
const FOUR_CONTAINMENTS = [
  `MOLD ASSESSMENT REPORT — SAMPLE (fictional test fixture)
Property: 1 Sample Pl, Unit 2A, New York, NY 10001. Prepared for: Test Customer.
Bedroom: Visible mold growth across the entire bedroom floor. Room dimensions: 12 ft x 10 ft, ceiling height 8 ft.
Den: Visible mold growth across the entire den floor. Room dimensions: 14 ft x 12 ft, ceiling height 8 ft.
Kitchen: Visible mold growth across the entire kitchen floor. Room dimensions: 10 ft x 8 ft, ceiling height 8 ft.
Washer Closet: Visible mold growth across the entire washer closet floor. Room dimensions: 5 ft x 4 ft, ceiling height 8 ft.
Contain (a) the entire Bedroom, (b) the entire Den, (c) the entire Kitchen, (d) the entire Washer Closet, each under negative pressure.
Install 1 HEPA air scrubber for 72 hours at 8 ACH in each containment area – Bedroom, Den, Kitchen, and Washer Closet.
Shut down all AFDs, dehumidifiers and fans 24 hours before the post-remediation clearance inspection.
Moisture source: plumbing leak, repaired.`,
];

describe("equipment run time on each line", () => {
  it("water Class 3: air movers run the company drying days (4), estimated until readings confirm dry", () => {
    const r = room("Living room", water(12, 10, { loss: { type: "water", category: "2", waterClass: "3" } }));
    const am = line(r.analysis.lines, "equip.airmovers");
    expect(am.duration).toMatchObject({ hours: 96, days: 4, source: "rule", estimated: true });
    expect(am.duration!.equipmentDays).toBe(am.quantity! * 4);
    expect(am.duration!.basis).toMatch(/Class 3 \(company default 4 days\) — estimated until moisture readings confirm dry/);
    expect(am.duration!.startStop).toMatch(/stop when every moisture point meets its dry goal/);
    expect(am.flags.join(" ")).toMatch(/Run time estimated — confirm with moisture readings/);
  });
  it("water class not confirmed: the class-unknown default, still estimated", () => {
    const am = line(room("Hall", water(10, 6)).analysis.lines, "equip.airmovers");
    expect(am.duration).toMatchObject({ days: 3, estimated: true });
    expect(am.duration!.basis).toMatch(/unconfirmed water class/);
  });
  it("readings at the dry goal: asks for the actual days (still estimated until the PM enters them)", () => {
    const d = water(10, 6, { moisturePoints: [{ id: "m", label: "MP1", surface: "floor", reading: "10", dryGoal: "12" }] });
    expect(line(room("Hall", d).analysis.lines, "equip.airmovers").flags.join(" ")).toMatch(/readings now meet the dry goal: enter the actual drying days/);
  });
  it("PM run time replaces the default: source PM, not estimated, equipment-days recalculated", () => {
    const d = water(12, 10, { durationOverrides: { "equip.airmovers": 120 } });
    const am = line(room("Living room", d).analysis.lines, "equip.airmovers");
    expect(am.duration).toMatchObject({ hours: 120, days: 5, source: "pm", estimated: false });
    expect(am.duration!.equipmentDays).toBe(am.quantity! * 5);
    expect(am.duration!.basis).toMatch(/entered by the PM \(was 72 h/);
  });
  it("no report run time and no default → missing, flagged and asked — never filled silently", () => {
    const fire = RoomScanData.parse({ loss: { type: "fire" }, source: { where: "in_room", status: "stopped" }, measurements: { lengthFt: 10, widthFt: 10, heightFt: 8 } });
    const a = analyzeRoom(fire, ctx({ roomLabel: "Den" }));
    const s = line(a.lines, "equip.scrubber");
    expect(s.duration).toMatchObject({ hours: null, days: null, equipmentDays: null, source: null });
    expect(s.flags.join(" ")).toMatch(/No run time/);
    expect(a.questions.join(" ")).toMatch(/Den: how long will the HEPA air scrubber run/);
  });
  it("mold without a stated run time: the company containment default (72 h), estimated", () => {
    const m = RoomScanData.parse({ loss: { type: "mold" }, source: { status: "repaired" }, materials: { flooring: { type: "wood", affected: true, affectedPct: 100 } }, measurements: { lengthFt: 12, widthFt: 10, heightFt: 8 } });
    const n = line(analyzeRoom(m, ctx()).lines, "mold.negair");
    expect(n.duration).toMatchObject({ hours: 72, days: 3, source: "rule", estimated: true });
  });
  it("the default is editable in Settings → Rules & defaults", () => {
    const rules = mergeRules({ equipmentDuration: { ...DEFAULT_RULES.equipmentDuration, waterDryingDaysClassUnknown: 5 } });
    expect(line(analyzeRoom(water(10, 6), ctx({ rules })).lines, "equip.airmovers").duration!.days).toBe(5);
  });
});

describe("mold report (Test 1 structure): 4 containments, 4 scrubbers, 72 h, off 24 h before clearance", () => {
  const f = rulesAnalyze(FOUR_CONTAINMENTS);
  it("the analyzer extracts the run time and the shut-down rule with quote and page", () => {
    expect(f.airScrubber?.value).toMatchObject({ perContainment: 1, hours: 72, ach: 8 });
    expect(f.equipmentOff?.value.hours).toBe(24);
    expect(f.equipmentOff?.quote).toMatch(/24 hours before the post-remediation clearance inspection/);
    expect(f.equipmentOff?.page).toBe(1);
  });

  const visitRooms: VisitRoom[] = ["Bedroom", "Den", "Kitchen", "Washer Closet"].map((n, i) => ({ locationId: `l${i}`, label: n, roomName: n, scan: RoomScanData.parse({ loss: { type: "mold" }, source: { status: "repaired" } }) }));
  const { plans, changes } = proposeVisit(f, visitRooms, 1950);
  const applied = applyVisit(f, plans, changes, changes.filter((c) => !c.conflict && !c.optional).map((c) => c.id), "doc");
  const rooms = applied.rooms.map((x) => room(x.plan.name, x.scan, { report: f }));

  it("each containment's scrubber: 1 × 72 h (3 days) = 3 equipment-days, from the report, with the stop rule", () => {
    for (const r of rooms) {
      const n = line(r.analysis.lines, "mold.negair");
      expect(n.quantity).toBe(1);
      expect(n.duration).toMatchObject({ hours: 72, days: 3, equipmentDays: 3, source: "report", estimated: false });
      expect(n.duration!.basis).toMatch(/stated by the report \(p\.1: “Install 1 HEPA air scrubber for 72 hours at 8 ACH/);
      expect(n.duration!.startStop).toMatch(/run 72 h\. Shut down 24 h after remediation is complete, before the clearance inspection \(report p\.1/);
      expect(n.source).toBe("report");
    }
  });

  it("equipment schedule: 4 scrubbers × 72 h = 12 equipment-days; 3 days running + 1 day off → 4 days to clearance", () => {
    const s = equipmentSchedule(rooms, { waterDehu: null, offBeforeClearanceHours: f.equipmentOff!.value.hours, waterDryingDays: null });
    const scr = s.rows.find((r) => r.type === "HEPA air scrubber / negative air")!;
    expect(scr).toMatchObject({ count: 4, hoursPerUnit: [72], days: [3], equipmentDays: 12, estimated: false, missing: false });
    expect(s.totalEquipmentDays).toBe(12);
    expect(s.spanText).toBe("Equipment runs 3 days; shut down 24 h (1 day) before the clearance inspection → 4 days from setup to clearance");
    expect(scheduleText(s).join("\n")).toMatch(/HEPA air scrubber \/ negative air: 4 units × 72 h \(3 days\) = 12 equipment-days/);
  });

  it("crew: 388 SF of mold + 4 containments → CC+2, with the math", () => {
    const c = plan(rooms, { serviceLine: "mold" });
    const p = c.phases[0];
    // 120 + 168 + 80 + 20 = 388 SF ÷ 150 = 2.59 worker-days; + 4 × 0.5 = 2 → 4.59 ÷ 2 days = 2.3 → 3 on site
    expect(p.workerDays).toBe(4.59);
    expect(p.workers).toBe(3);
    expect(c.proposed).toEqual({ crewChiefs: 1, subs: 2, total: 3, label: "CC+2" });
    expect(p.math.join("\n")).toMatch(/Den: 168 SF ÷ 150 SF per worker-day \(mold remediation\)/);
    expect(p.math.join("\n")).toMatch(/4 containments × 0\.5 worker-days/);
    expect(c.trades).toEqual([]); // no line indicates a trade → none invented
    expect(c.needsConfirmation).toBe(true);
    expect(crewText(c).join("\n")).toMatch(/Crew chiefs: 1 · Subs: 2 · Total: 3 \(CC\+2\) — PROPOSED, needs PM confirmation/);
  });
});

describe("crew size", () => {
  it("a small job does not default to a large crew: one 8 × 10 water room → CC+0", () => {
    const c = plan([room("Bath", water(8, 10))]);
    expect(c.proposed).toEqual({ crewChiefs: 1, subs: 0, total: 1, label: "CC+0" });
  });
  it("more than one room never defaults to a crew chief alone", () => {
    const c = plan([room("Bath", water(6, 5)), room("Hall", water(6, 4))]);
    expect(c.proposed).toMatchObject({ crewChiefs: 1, subs: 1, label: "CC+1" });
    expect(c.phases[0].math.join(" ")).toMatch(/a crew chief never works it alone/);
  });
  it("a large water job scales: 6 rooms × 300 SF → 6 on site → CC+5", () => {
    const c = plan(["A", "B", "C", "D", "E", "F"].map((n) => room(n, water(20, 15))));
    expect(c.proposed).toMatchObject({ crewChiefs: 1, subs: 5, total: 6 });
  });
  it("many containments add crew chiefs (1 per 4 containments)", () => {
    const rules = DEFAULT_RULES;
    const mold = (n: string) => RoomScanData.parse({ loss: { type: "mold" }, source: { status: "repaired" }, materials: { flooring: { type: "wood", affected: true, affectedPct: 100 } }, measurements: { lengthFt: 10, widthFt: 10, heightFt: 8 }, reportRoom: n });
    const c = plan(["A", "B", "C", "D", "E"].map((n) => room(n, mold(n))), { rules });
    expect(c.proposed!.crewChiefs).toBe(2);
    expect(c.proposed!.subs).toBeGreaterThanOrEqual(1);
  });
  it("can't be derived (not measured) → no number invented; PM-confirmed number needed", () => {
    const d = RoomScanData.parse({ loss: { type: "water", category: "2" }, source: { where: "in_room", status: "repaired" }, materials: { flooring: { type: "LVP", affected: true } } });
    const c = plan([room("Kitchen", d)]);
    expect(c.proposed).toBeNull();
    expect(c.note).toMatch(/Crew can't be calculated yet \(Kitchen: affected area not measured\) — enter crew chiefs and subs \(PM-confirmed\)/);
    const pm = plan([room("Kitchen", d)], { jobInfo: { crewChiefs: 1, subcontractors: 3, subTrades: ["Plumber"] } });
    expect(pm.confirmed).toMatchObject({ label: "CC+3", trades: ["Plumber"], total: 4 });
    expect(pm.needsConfirmation).toBe(false);
  });
  it("reconstruction on adds its own phase; off removes it", () => {
    const d = water(12, 10, { materials: { flooring: { type: "LVP", affected: true, affectedPct: 100, action: "replace" } } });
    expect(plan([room("Kitchen", d)]).phases.map((p) => p.phase)).toEqual(["Mitigation / remediation"]);
    const on = plan([room("Kitchen", d, { reconstructionRequested: true })], { reconstructionRequested: true });
    expect(on.phases.map((p) => p.phase)).toEqual(["Mitigation / remediation", "Reconstruction"]);
    expect(on.phases[1].math[0]).toMatch(/120 SF ÷ 120 SF per worker-day \(reconstruction\)/);
  });
  it("a sub trade appears only when a scope line indicates it (sink disconnect → Plumber)", () => {
    const d = water(12, 10, { materials: { flooring: { type: "LVP", affected: true, affectedPct: 100 }, casework: [{ kind: "sink_base", action: "remove_replace", lf: 3 }] } });
    const c = plan([room("Kitchen", d)]);
    expect(c.trades.map((t) => t.trade)).toEqual(["Plumber"]);
    expect(c.trades[0].why).toMatch(/Kitchen: Disconnect sink/);
  });
  it("production rates and crew ratios come from Settings → Rules & defaults", () => {
    const rules = mergeRules({ crew: { ...DEFAULT_RULES.crew, sfPerWorkerDay: { ...DEFAULT_RULES.crew.sfPerWorkerDay, mitigation: 50 } } });
    const c = plan([room("Bath", water(8, 10))], { rules });
    expect(c.proposed!.total).toBe(2); // 80 SF ÷ 50 = 1.6 worker-days in 1 day → 2 on site
  });
});

const { resetLocalDbForTests } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const scans = await import("@/lib/scans");
const exportRoute = await import("@/app/api/projects/[pid]/visits/[vid]/export/route");

describe("visit level: summary, pre-send check, crew accept, export", () => {
  beforeEach(() => resetLocalDbForTests());

  it("water job: schedule shows drying as estimated; accepted equipment without a run time fails pre-send; crew accept + PM run time pass", async () => {
    const p = await repo.createProject({ address: "1 Test Water Pl" });
    const k = await repo.insertLocation(p.id, { room: "Kitchen" });
    const v = await repo.createVisit(p.id, { type: "initial_mitigation", visitDate: "2026-11-06", stage: "initial_walkthrough", serviceLine: "mitigation" });
    let view = await scans.saveRoomScan(p.id, v.id, k.id, {
      loss: { type: "water", category: "2" },
      source: { where: "in_room", status: "repaired", waterSource: "clean_supply" },
      materials: { flooring: { type: "LVP", affected: true, affectedPct: 100 } },
      measurements: { lengthFt: 12, widthFt: 10, heightFt: 8 },
      moisturePoints: [{ id: "m1", label: "MP1", surface: "floor", reading: "30", dryGoal: "12" }],
    });
    const s = view.summary.equipmentSchedule;
    expect(s.rows.find((r) => r.type === "Air movers")).toMatchObject({ days: [3], estimated: true });
    expect(s.rows.find((r) => r.type === "Dehumidifiers (water drying)")).toMatchObject({ days: [3], estimated: true });
    expect(view.summary.qa.find((q) => /run times confirmed/.test(q.text))?.ok).toBe(false);
    expect(view.summary.crew.proposed?.label).toBe("CC+0");

    // a hand-made equipment line with no duration can't be sent: simulate by clearing the duration via a line the rules can't time
    await scans.decideLines(p.id, v.id, k.id, ["equip.airmovers"], "accept");
    view = await scans.getVisitScans(p.id, v.id);
    expect(view.summary.presend.failures.some((x) => /no run time/.test(x))).toBe(false); // estimated run time is still a run time

    await scans.setLineDuration(p.id, v.id, k.id, "equip.airmovers", 96);
    view = await scans.setScanOptions(p.id, v.id, { crew: { crewChiefs: 1, subcontractors: 1, trades: ["Plumber", "Not a trade"] } });
    const am = view.rooms[0].data.lines.find((l) => l.id === "equip.airmovers")!;
    expect(am.duration).toMatchObject({ hours: 96, days: 4, source: "pm", estimated: false });
    expect(view.summary.crew.confirmed).toMatchObject({ label: "CC+1", trades: ["Plumber"] });
    expect((await repo.getVisit(p.id, v.id)).facts.jobInfo).toMatchObject({ crewChiefs: 1, subcontractors: 1, crewRaw: "CC+1", subTrades: ["Plumber"] });

    const res = await (exportRoute.GET as (r: NextRequest, c: { params: Promise<{ pid: string; vid: string }> }) => Promise<Response>)(new NextRequest("http://localhost/x?format=pdf"), { params: Promise.resolve({ pid: p.id, vid: v.id }) });
    expect(res.status).toBe(200);
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(await res.arrayBuffer())), { mergePages: true });
    expect(text).toMatch(/CREW/);
    expect(text).toMatch(/Crew chiefs: 1 · Subs: 1 \(Plumber\) · Total: 2 \(CC\+1\) — confirmed by the PM/);
    expect(text).toMatch(/EQUIPMENT SCHEDULE/);
    expect(text).toMatch(/Air movers: \d+ units? × 96 h \(4 days\)/);
  });

  it("an accepted equipment line with no run time fails the pre-send check (DRAFT)", async () => {
    const p = await repo.createProject({ address: "2 Test Fire Pl" });
    const d = await repo.insertLocation(p.id, { room: "Den" });
    const v = await repo.createVisit(p.id, { type: "initial_mitigation", visitDate: "2026-11-06", stage: "initial_walkthrough", serviceLine: "mitigation" });
    await scans.saveRoomScan(p.id, v.id, d.id, { loss: { type: "fire", smokeType: "dry" }, source: { where: "in_room", status: "stopped" }, measurements: { lengthFt: 10, widthFt: 10, heightFt: 8 } });
    await scans.decideLines(p.id, v.id, d.id, ["equip.scrubber"], "accept");
    let view = await scans.getVisitScans(p.id, v.id);
    expect(view.summary.presend.ok).toBe(false);
    expect(view.summary.presend.failures.join("\n")).toMatch(/Den: Set \(calculated\) HEPA air scrubber — no run time \(hours \/ days\)/);
    view = await scans.setLineDuration(p.id, v.id, d.id, "equip.scrubber", 48);
    expect(view.summary.presend.failures.join("\n")).not.toMatch(/no run time/);
  });

  it("crew that can't be derived (room not measured) fails pre-send until the PM enters it", async () => {
    const p = await repo.createProject({ address: "3 Test Pl" });
    const k = await repo.insertLocation(p.id, { room: "Kitchen" });
    const v = await repo.createVisit(p.id, { type: "initial_mitigation", visitDate: "2026-11-06", stage: "initial_walkthrough", serviceLine: "mitigation" });
    let view = await scans.saveRoomScan(p.id, v.id, k.id, { loss: { type: "water", category: "2" }, source: { where: "in_room", status: "repaired" }, materials: { flooring: { type: "LVP", affected: true } } });
    expect(view.summary.presend.failures.join("\n")).toMatch(/Crew: Crew can't be calculated yet/);
    view = await scans.setScanOptions(p.id, v.id, { crew: { crewChiefs: 1, subcontractors: 2 } });
    expect(view.summary.presend.failures.join("\n")).not.toMatch(/Crew:/);
    await expect(scans.setScanOptions(p.id, v.id, { crew: { crewChiefs: 0, subcontractors: 2 } })).rejects.toThrow(/At least one crew chief/);
  });
});
