import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RULES } from "@/lib/defaults";
import { airMoverCalc, analyzeRoom, type RoomContext } from "@/lib/roomRules";
import { RoomScanData } from "@/lib/scan";
import { parseFnol } from "@/lib/fnol";
import { addressWithUnit } from "@/lib/addressUnit";
import { buildSketch, toSvg } from "@/lib/sketch";

/** Fixes from the live browser test (6 runs). Rules only, no AI. All data here is fictional. */
process.env.DATABASE_URL = "pglite://memory";
delete process.env.POSTGRES_URL;
delete process.env.APP_PASSCODE;
delete process.env.ANTHROPIC_API_KEY;
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-live-"));

const ctx = (over: Partial<RoomContext> = {}): RoomContext => ({ rules: DEFAULT_RULES, roomLabel: "Room", run: [], exclusions: [], locationId: "l", reconstructionRequested: false, yearBuilt: 1950, ...over });

const { resetLocalDbForTests } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const scans = await import("@/lib/scans");
const intake = await import("@/lib/intake");
const { quickStart } = await import("@/lib/quickstart");

const waterScan = {
  loss: { type: "water", category: "2", waterClass: "2" },
  source: { where: "in_room", status: "repaired", waterSource: "clean_supply" },
  materials: { flooring: { type: "LVP", affected: true, affectedPct: 100 } },
  measurements: { lengthFt: 12, widthFt: 10, heightFt: 8 },
  moisturePoints: [{ id: "m1", label: "MP1", surface: "floor", reading: "30", dryGoal: "12" }],
};
async function visitWith(serviceLine: string, scan: unknown, room = "Kitchen") {
  const p = await repo.createProject({ address: "1 Test Lane" });
  const l = await repo.insertLocation(p.id, { room });
  const v = await repo.createVisit(p.id, { type: "initial_mitigation", visitDate: "2026-11-06", stage: "initial_walkthrough", serviceLine: serviceLine as never });
  const view = await scans.saveRoomScan(p.id, v.id, l.id, scan);
  return { p, l, v, view };
}
const qa = (view: Awaited<ReturnType<typeof scans.getVisitScans>>, re: RegExp) => view.summary.qa.find((q) => re.test(q.text));

describe("1 + 7 — pre-send check passes only on real evidence; no-quantity lines can't be accepted", () => {
  beforeEach(() => resetLocalDbForTests());

  it("(a) nothing accepted → not passed", async () => {
    const { view } = await visitWith("mitigation", waterScan);
    expect(view.summary.presend.ok).toBe(false);
    expect(view.summary.presend.failures[0]).toMatch(/No accepted lines yet/);
    expect(qa(view, /line accepted/)?.ok).toBe(false);
    expect(qa(view, /every accepted line has a quantity/)?.ok).toBe(false);
  });

  it("(b) a Monitoring line with no days can't be accepted, and a bulk accept leaves it suggested", async () => {
    const { p, l, v } = await visitWith("mitigation", waterScan);
    await expect(scans.decideLines(p.id, v.id, l.id, ["monitor"], "accept")).rejects.toThrow(/Enter a quantity before accepting: Monitor moisture daily/);
    const view = await scans.decideLines(p.id, v.id, l.id, ["monitor", "extract"], "accept");
    const lines = view.rooms[0].data.lines;
    expect(lines.find((x) => x.id === "monitor")!.status).toBe("suggested");
    expect(lines.find((x) => x.id === "extract")!.status).toBe("accepted");
    expect(qa(view, /every accepted line has a quantity/)?.ok).toBe(true);
    // the PM enters the days → it can be accepted
    await scans.setLineQuantity(p.id, v.id, l.id, "monitor", 3);
    const after = await scans.decideLines(p.id, v.id, l.id, ["monitor"], "accept");
    expect(after.rooms[0].data.lines.find((x) => x.id === "monitor")!.status).toBe("accepted");
  });

  it("(c) mold: 'stopped' is not 'fixed' — the source check passes only when marked repaired", async () => {
    const mold = { loss: { type: "mold" }, source: { status: "stopped" }, materials: { flooring: { type: "wood", affected: true, affectedPct: 100 } }, measurements: { lengthFt: 12, widthFt: 10, heightFt: 8 } };
    const { p, l, v, view } = await visitWith("mold", mold, "Bedroom");
    expect(qa(view, /Mold: moisture source confirmed repaired/)?.ok).toBe(false);
    expect(view.rooms[0].analysis.questions.join(" ")).toMatch(/is it corrected/);
    const fixed = await scans.saveRoomScan(p.id, v.id, l.id, { ...mold, source: { status: "repaired" } });
    expect(qa(fixed, /Mold: moisture source confirmed repaired/)?.ok).toBe(true);
  });

  it("(d) water job with no category (loss type not set on the room) → category check fails until it is set", async () => {
    const noCat = { source: { where: "in_room", status: "repaired" }, materials: { flooring: { type: "LVP", affected: true } }, measurements: { lengthFt: 10, widthFt: 8, heightFt: 8 } };
    const { p, l, v, view } = await visitWith("mitigation", noCat);
    expect(qa(view, /Water category confirmed/)?.ok).toBe(false);
    expect(qa(view, /Loss type set in every room/)?.ok).toBe(false);
    const set = await scans.saveRoomScan(p.id, v.id, l.id, { ...noCat, loss: { type: "water", category: "2" } });
    expect(qa(set, /Water category confirmed/)?.ok).toBe(true);
    expect(qa(set, /Loss type set in every room/)?.ok).toBe(true);
  });

  it("no lines at all: 'every suggested line accepted or rejected' does not pass vacuously", async () => {
    const { view } = await visitWith("contents", { loss: { type: null }, source: { where: "in_room" } });
    expect(qa(view, /Every suggested line accepted or rejected/)?.ok).toBe(false);
  });
});

describe("2 — the installed equipment count governs the scope and equipment-days", () => {
  beforeEach(() => resetLocalDbForTests());

  it("water: 4 air movers placed vs calculated → 4 in the line (flagged), 1 dehumidifier placed → schedule 4×3 + 1×3 = 15 equipment-days", async () => {
    const calc = airMoverCalc(120, DEFAULT_RULES).recommended;
    const installed = calc + 1;
    const { view } = await visitWith("mitigation", { ...waterScan, equipmentPlaced: [{ kind: "air_mover", qty: installed }, { kind: "dehumidifier", qty: 1 }] });
    const lines = view.rooms[0].data.lines;
    const am = lines.find((x) => x.id === "equip.airmovers")!;
    expect(am).toMatchObject({ activity: "Set (installed)", quantity: installed, source: "measured" });
    expect(am.calc).toMatch(new RegExp(`^${installed} installed \\(counted on site\\); calculated ${calc}:`));
    expect(am.flags.join(" ")).toMatch(new RegExp(`Installed count \\(${installed}\\) differs from the calculated count \\(${calc}\\)`));
    expect(am.duration!.equipmentDays).toBe(installed * 3);
    const dh = lines.find((x) => x.id === "equip.dehu")!;
    expect(dh).toMatchObject({ quantity: 1, activity: "Set (installed)" });
    expect(dh.duration).toMatchObject({ days: 3, equipmentDays: 3, estimated: true });
    const s = view.summary.equipmentSchedule;
    expect(s.rows.find((r) => r.type === "Air movers")).toMatchObject({ count: installed, equipmentDays: installed * 3 });
    expect(s.rows.find((r) => r.type === "Dehumidifiers (water drying)")).toMatchObject({ count: 1, equipmentDays: 3 });
    expect(s.rows.find((r) => r.type === "Dehumidifiers (water drying)")!.basis.join(" ")).toMatch(/Calculated \d+–\d+ .*1 installed — the installed count is used/);
    expect(s.totalEquipmentDays).toBe(installed * 3 + 3);
    if (installed === 4) expect(s.totalEquipmentDays).toBe(15);
  });

  it("fire: 2 HEPA air scrubbers placed vs calculated 1 → 2 in the line; equipment-days follow (2 × 2 days = 4)", () => {
    const fire = RoomScanData.parse({ loss: { type: "fire", smokeType: "dry" }, source: { where: "in_room", status: "stopped" }, measurements: { lengthFt: 10, widthFt: 10, heightFt: 8 }, equipmentPlaced: [{ kind: "air_scrubber", qty: 2 }], durationOverrides: { "equip.scrubber": 48 } });
    const a = analyzeRoom(fire, ctx({ roomLabel: "Den" }));
    const s = a.lines.find((x) => x.id === "equip.scrubber")!;
    expect(s).toMatchObject({ quantity: 2, activity: "Set (installed)" });
    expect(s.flags.join(" ")).toMatch(/Installed count \(2\) differs from the calculated count \(1\)/);
    expect(s.duration).toMatchObject({ hours: 48, days: 2, equipmentDays: 4 });
  });

  it("matching counts: no warning; the sketch labels installed vs calculated", () => {
    const calc = airMoverCalc(120, DEFAULT_RULES).recommended;
    const d = RoomScanData.parse({ ...waterScan, equipmentPlaced: [{ kind: "air_mover", qty: calc }] });
    const a = analyzeRoom(d, ctx());
    const am = a.lines.find((x) => x.id === "equip.airmovers")!;
    expect(am.quantity).toBe(calc);
    expect(am.flags.join(" ")).not.toMatch(/differs/);
    const svg = toSvg(buildSketch([{ locationId: "l", label: "Kitchen", floor: null, scan: d, lines: a.lines, excluded: false }]));
    expect(svg).toContain(`AM×${calc} installed`);
  });
});

describe("3 — PPE from the confirmed crew × days", () => {
  beforeEach(() => resetLocalDbForTests());

  it("CC+0 over the mold target days (2) → 2 sets; the 'set crew size' flag goes; a second mold room doesn't double it", async () => {
    const mold = { loss: { type: "mold" }, source: { status: "repaired" }, materials: { flooring: { type: "wood", affected: true, affectedPct: 100 } }, measurements: { lengthFt: 12, widthFt: 10, heightFt: 8 } };
    const { p, v, view } = await visitWith("mold", mold, "Bedroom");
    const before = view.rooms[0].data.lines.find((x) => x.id === "mold.ppe")!;
    expect(before.quantity).toBeNull();
    expect(before.flags.join(" ")).toMatch(/confirm the crew at the top of the scan/);
    const den = await repo.insertLocation(p.id, { room: "Den" });
    await scans.saveRoomScan(p.id, v.id, den.id, mold);
    const after = await scans.setScanOptions(p.id, v.id, { crew: { crewChiefs: 1, subcontractors: 0 } });
    const bed = after.rooms.find((r) => r.label === "Bedroom")!.data.lines.find((x) => x.id === "mold.ppe")!;
    expect(bed).toMatchObject({ quantity: 2, unit: "EA/worker/day" });
    expect(bed.calc).toBe("1 on the crew (CC+0, PM confirmed) × 2 days (company target days for mold remediation — set Production days on Info if different) = 2 sets");
    expect(bed.flags.join(" ")).not.toMatch(/Set crew size/);
    const denPpe = after.rooms.find((r) => r.label === "Den")!.data.lines.find((x) => x.id === "mold.ppe")!;
    expect(denPpe).toMatchObject({ quantity: 0, calc: "counted once for the job in Bedroom" });
  });
});

describe("6 — FNOL parsing: cause, visit date-time, unit not repeated", () => {
  const FNOL = `New assignment — water mitigation
Insured: TEST Customer
Address: 777 Sample Water Lane, Unit 2B, Brooklyn, NY 11201
Unit: 2B
Type of Loss: Water - kitchen sink supply line leak
Visit: 11/06/2026 10:00 AM
Notes: TEST project, browser multi-run Run 2 water case.`;

  it("cause comes from the loss line, not Notes; the visit date and time are read", () => {
    const f = parseFnol(FNOL);
    expect(f.causeOfLoss?.value).toBe("kitchen sink supply line leak");
    expect(f.appointment?.value).toEqual({ date: "2026-11-06", time: "10:00" });
    const pm = parseFnol("Address: 1 Test Pl\nAppointment: 11/7/2026 at 2:30 pm\nCause of loss: dishwasher hose\nNotes: call first");
    expect(pm.causeOfLoss?.value).toBe("dishwasher hose");
    expect(pm.appointment?.value).toEqual({ date: "2026-11-07", time: "14:30" });
    expect(parseFnol("Address: 1 Test Pl\nNotes: pipe burst in the bathroom wall").causeOfLoss?.value).toBe("pipe burst in the bathroom wall"); // notes still used when nothing else
  });

  it("the unit is never repeated in titles", () => {
    expect(addressWithUnit("777 Sample Water Lane, Unit 2B, Brooklyn, NY 11201", "2B")).toBe("777 Sample Water Lane, Unit 2B, Brooklyn, NY 11201");
    expect(addressWithUnit("777 Sample Water Lane, Apt 2B", "Unit 2B")).toBe("777 Sample Water Lane, Apt 2B");
    expect(addressWithUnit("12 Sample Ave", "3B")).toBe("12 Sample Ave, Unit 3B");
    expect(addressWithUnit("12 Sample Ave #3B", "3B")).toBe("12 Sample Ave #3B");
  });

  it("saved assignment → the visit gets the FNOL's date and time; project name has the unit once", async () => {
    await resetLocalDbForTests();
    const input = intake.parseToInput(parseFnol(FNOL));
    expect(input).toMatchObject({ appointmentDate: "2026-11-06", appointmentTime: "10:00", causeOfLoss: "kitchen sink supply line leak" });
    const saved = await intake.createAssignmentFromFnol(FNOL, input);
    expect(saved.assignment).toMatchObject({ appointmentDate: "2026-11-06", appointmentTime: "10:00" });
    const { projectId, visitId } = await intake.openProjectForAssignment(saved.assignment.id);
    const v = await repo.getVisit(projectId, visitId);
    expect(v.visitDate).toBe("2026-11-06");
    expect(v.appointmentTime).toBe("10:00");
    const p = await repo.getProject(projectId);
    expect(p.name.match(/2B/g)).toHaveLength(1);
    expect(p.causeOfLoss).toBe("kitchen sink supply line leak");
  });
});

describe("9 — Quick Start: combined kinds of work and EMS", () => {
  beforeEach(() => resetLocalDbForTests());

  it("Water + Mold with EMS → the assignment carries all three; the visit opens as EMS", async () => {
    const r = await quickStart({ address: "5 Test Combined St", job: "water", also: ["mold"], ems: true, notes: "kitchen leak, mold behind the sink" });
    const a = (await intake.assignmentsForProject(r.projectId))[0];
    expect(a.serviceLines).toEqual(["ems", "mitigation", "mold"]);
    const v = await repo.getVisit(r.projectId, r.visitId);
    expect(v.serviceLine).toBe("ems");
    expect(v.stage).toBe("initial_walkthrough");
  });
  it("a single kind still works as before; unknown extra kinds are ignored", async () => {
    const r = await quickStart({ address: "6 Test Single St", job: "mold", also: ["nonsense" as never, "mold"] });
    expect((await intake.assignmentsForProject(r.projectId))[0].serviceLines).toEqual(["mold"]);
  });
});

describe("6b re-test — the exact FNOL pasted on the live preview: visit date/time read in every layout", () => {
  const OWN = `TEST FNOL RETEST — Water loss
Address: TEST RETEST — 999 Browser FNOL Lane, Brooklyn, NY 11201, Unit 3C
Customer: TEST FNOL Retest Customer
Phone: 555-030-7777
Claim: CLM-TEST-FNOL-R2
Date of loss: 11/05/2026
Loss type: Water — kitchen sink supply line leak, Class 2 water damage, kitchen and living room wet. Air movers and dehumidifier needed for drying.
Visit: 11/06/2026 10:00 AM
Notes: TEST retest project, FNOL parse fix check.`;
  const EMBEDDED = OWN.replace("drying.\nVisit:", "drying. Visit:");
  const CAUSE = "kitchen sink supply line leak, Class 2 water damage, kitchen and living room wet. Air movers and dehumidifier needed for drying.";
  const layouts: [string, string][] = [
    ["Visit on its own line", OWN],
    ["Visit embedded at the end of the Loss type line", EMBEDDED],
    ["one line, fields separated by spaces", OWN.split("\n").join(" ")],
    ["one line, fields separated by ' / '", OWN.split("\n").join(" / ")],
    ["one line ' / ', Visit embedded in Loss type", EMBEDDED.split("\n").join(" / ")],
    ["Windows line endings", OWN.replace(/\n/g, "\r\n")],
  ];
  for (const [name, text] of layouts)
    it(name, () => {
      const f = parseFnol(text);
      expect(f.appointment?.value).toEqual({ date: "2026-11-06", time: "10:00" });
      expect(f.causeOfLoss?.value).toBe(CAUSE); // full cause, never the Notes line, never the embedded Visit
      expect(f.lossDate?.value).toBe("2026-11-05"); // the loss date is not taken as the visit
      const i = intake.parseToInput(f);
      expect(i).toMatchObject({ appointmentDate: "2026-11-06", appointmentTime: "10:00" });
    });

  it("other ways an FNOL states the visit", () => {
    const v = (line: string) => parseFnol(OWN.replace("Visit: 11/06/2026 10:00 AM", line)).appointment?.value ?? null;
    expect(v("Visit date/time: 11/06/2026 10:00 AM")).toEqual({ date: "2026-11-06", time: "10:00" });
    expect(v("Appointment: Nov 6, 2026 at 2:30 pm")).toEqual({ date: "2026-11-06", time: "14:30" });
    expect(v("Scheduled for: Friday, 11/06/2026 @ 9:15am")).toEqual({ date: "2026-11-06", time: "09:15" });
    expect(v("Visit type: initial walk-through")).toBeNull(); // a stage, not a date
  });

  it("through the inbox route: the review form gets the date and time, and the saved visit has them", async () => {
    await resetLocalDbForTests();
    const route = await import("@/app/api/fnol/parse/route");
    const { NextRequest } = await import("next/server");
    for (const text of [OWN, EMBEDDED]) {
      const res = await (route.POST as (r: InstanceType<typeof NextRequest>, c: { params: Promise<object> }) => Promise<Response>)(new NextRequest("http://localhost/api/fnol/parse", { method: "POST", body: JSON.stringify({ text }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({}) });
      const j = (await res.json()) as { parse: { appointment: unknown }; input: Parameters<typeof intake.createAssignmentFromFnol>[1] };
      expect(j.parse.appointment).toMatchObject({ value: { date: "2026-11-06", time: "10:00" } });
      expect(j.input).toMatchObject({ appointmentDate: "2026-11-06", appointmentTime: "10:00" });
      const saved = await intake.createAssignmentFromFnol(text, j.input);
      const { projectId, visitId } = await intake.openProjectForAssignment(saved.assignment.id);
      const visit = await repo.getVisit(projectId, visitId);
      expect(visit.visitDate).toBe("2026-11-06");
      expect(visit.appointmentTime).toBe("10:00");
      expect((await repo.getProject(projectId)).name.match(/3C/g)).toHaveLength(1);
    }
  });
});

describe("re-test residual (a) — checks with nothing to check don't pass", () => {
  beforeEach(() => resetLocalDbForTests());
  it("no accepted equipment, no exclusions → shown as 'nothing to check', not a pass", async () => {
    const { view } = await visitWith("mitigation", waterScan);
    for (const re of [/every accepted equipment line states how long it runs/, /Exclusions have a signed customer declination/, /every accepted quantity has a source/]) {
      const q = qa(view, re)!;
      expect(q).toMatchObject({ ok: false, na: true });
      expect(q.text).toMatch(/nothing to check|to check yet/);
    }
  });
  it("once there is something to check, the check runs for real", async () => {
    const { p, l, v } = await visitWith("mitigation", waterScan);
    const view = await scans.decideLines(p.id, v.id, l.id, ["equip.airmovers"], "accept");
    expect(qa(view, /every accepted equipment line states how long it runs/)).toMatchObject({ ok: true });
    expect(qa(view, /every accepted equipment line/)!.na).toBeUndefined();
  });
});
