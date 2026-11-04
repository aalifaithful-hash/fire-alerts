import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { rulesAnalyze } from "@/lib/report/rules";
import { stillMissing } from "@/lib/report/match";
import { analyzeRoom, type RoomContext } from "@/lib/roomRules";
import { DEFAULT_RULES } from "@/lib/defaults";
import { RoomScanData, type ScopeLine } from "@/lib/scan";
import { uploadRoute, SERVER_UPLOAD_LIMIT_BYTES } from "@/components/api";

/**
 * HARD mold-report set (beyond the basic 308 / 429 samples). Each case states the expected
 * behaviour. Fixtures: tests/fixtures/hard/*.pdf from scripts/make-hard-mold-reports.mjs — all
 * fictional SAMPLE reports. Rules only, no AI. Test 1 context: 308 E 72nd St Unit 4D, Carol Vinelli.
 */
process.env.DATABASE_URL = "pglite://memory";
delete process.env.POSTGRES_URL;
delete process.env.APP_PASSCODE;
delete process.env.AI_PROVIDER;
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-hard-"));

const { resetLocalDbForTests } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const scans = await import("@/lib/scans");
const { extractPageTexts } = await import("@/lib/pdf");
const { quickStart } = await import("@/lib/quickstart");
const { ingestReport, reportView, applyReport, confirmReport } = await import("@/lib/report/service");
const docRoute = await import("@/app/api/projects/[pid]/documents/[did]/route");
const blobTokenRoute = await import("@/app/api/projects/[pid]/documents/blob/route");
// @ts-expect-error — plain .mjs generator script, no types
const { HARD, buildPdf } = await import("../scripts/make-hard-mold-reports.mjs");

const H = (f: string) => new Uint8Array(readFileSync(`tests/fixtures/hard/${f}`));
const SAMPLE_A = new Uint8Array(readFileSync("tests/fixtures/sample-mold-report-308-E-72nd-St-4D.pdf"));
const TEST1 = { address: "308 E 72nd St, New York, NY 10021", unit: "4D", customer: "Carol Vinelli", job: "mold" as const, appointmentTime: "11:00", notes: "Mold under wood flooring. Has Mold report she will send over." };

type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;
async function call<P>(h: Handler<P>, method: string, params: P, body?: unknown) {
  const req = new NextRequest("http://localhost/api/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await h(req, { params: Promise.resolve(params) });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function setup() {
  const q = await quickStart(TEST1);
  return q;
}
async function upload(q: { projectId: string }, file: string, bytes?: Uint8Array) {
  return ingestReport(q.projectId, { name: file, bytes: bytes ?? H(file) });
}
async function applyDefaults(q: { projectId: string; visitId: string }, docId: string) {
  const v = (await reportView(q.projectId, q.visitId)).active!;
  return applyReport(q.projectId, q.visitId, docId, v.changes.filter((c) => !c.conflict).map((c) => c.id));
}
const rooms = async (q: { projectId: string; visitId: string }) => (await scans.getVisitScans(q.projectId, q.visitId)).rooms;
const byLabel = async (q: { projectId: string; visitId: string }, name: string) => (await rooms(q)).find((r) => r.label.endsWith(name))!;
const L = (ls: ScopeLine[], id: string) => ls.find((l) => l.id === id);
const editable = (d: RoomScanData) => {
  const { lines: _l, decisions: _d, ...rest } = d;
  void _l;
  void _d;
  return rest;
};

beforeEach(() => resetLocalDbForTests());

// ---------------------------------------------------------------------------------------------
describe("1. multi-room report, wood flooring continuous into other rooms", () => {
  it("each room gets its own quantities; the run propagates to the connected rooms; one shared containment", async () => {
    const q = await setup();
    const d = await upload(q, "H01-multi-room-continuous-1925.pdf");
    expect(d.status).toBe("ready");
    const v = (await reportView(q.projectId, q.visitId)).active!;
    expect(v.rooms.map((r) => [r.name, r.isNew, r.runOnly])).toEqual([
      ["Bedroom", false, false], // goes to the quick-start "room TBD" room
      ["Hallway", true, false],
      ["Closet", true, false],
      ["Living room", true, true],
    ]);
    expect(v.changes.every((c) => !c.conflict)).toBe(true);
    await applyDefaults(q, d.id);
    const rs = await rooms(q);
    expect(rs.map((r) => r.label).sort()).toEqual(["Unit 4D — Bedroom", "Unit 4D — Closet", "Unit 4D — Hallway", "Unit 4D — Living room"]);
    const bed = await byLabel(q, "Bedroom");
    const hall = await byLabel(q, "Hallway");
    const clo = await byLabel(q, "Closet");
    const liv = await byLabel(q, "Living room");
    // removal quantities per room — not just the first room
    expect(L(bed.data.lines, "mold.floor.remove")).toMatchObject({ quantity: 96, unit: "SF" });
    expect(L(hall.data.lines, "mold.floor.remove")).toMatchObject({ quantity: 20, unit: "SF", calc: "10 ft × 4 ft = 40 SF × 50% = 20 SF" });
    expect(L(clo.data.lines, "mold.floor.remove")).toMatchObject({ quantity: 12, unit: "SF" });
    expect(L(hall.data.lines, "mold.floor.remove")!.justification).toMatch(/Report states growth on 50% of the hallway floor \(20 SF\)/);
    // the living room has no growth: no mold lines, but the continuous run comes up and is replaced there too
    expect(liv.data.lines.filter((l) => l.id.startsWith("mold."))).toEqual([]);
    expect(L(liv.data.lines, "floor.run.remove")).toMatchObject({ quantity: 168, unit: "SF" });
    expect(L(liv.data.lines, "floor.replace")).toMatchObject({ quantity: 168, unit: "SF" });
    for (const r of [bed, hall, clo, liv]) {
      expect(r.data.materials.flooring.continuousRun, r.label).toBe("Report run");
      expect(L(r.data.lines, "floor.replace")!.calc, r.label).toMatch(/run Report run total 316 SF/); // 96 + 40 + 12 + 168
    }
    // one containment for the connected rooms: on the bedroom, none in hallway/closet
    expect(L(bed.data.lines, "mold.containment")!.item).toMatch(/one containment around Bedroom, Hallway, Closet/);
    expect(L(bed.data.lines, "mold.containment")!.quantity).toBeNull(); // poly of a shared containment is measured, not guessed
    for (const r of [hall, clo]) for (const id of ["mold.containment", "mold.negair", "mold.pcv"]) expect(L(r.data.lines, id), `${r.label} ${id}`).toBeUndefined();
    const negAir = rs.flatMap((r) => r.data.lines).filter((l) => l.id === "mold.negair");
    expect(negAir.map((l) => l.quantity)).toEqual([1]);
    // applying again does not duplicate rooms or lines
    await applyDefaults(q, d.id);
    const again = await rooms(q);
    expect(again).toHaveLength(4);
    for (const r of again) expect(new Set(r.data.lines.map((l) => l.id)).size, r.label).toBe(r.data.lines.length);
  });

  it("a multi-page report keeps the right page for each finding", async () => {
    const f = rulesAnalyze(await extractPageTexts(H("H01-multi-room-continuous-1925.pdf")));
    expect(f.rooms.map((r) => [r.value.name, r.page])).toEqual([
      ["Bedroom", 1],
      ["Hallway", 2],
      ["Closet", 2],
      ["Living room", 2],
    ]);
    expect(f.rooms[3].value.growth).toBe(false);
    expect(f.clearanceCriteria?.page).toBe(3);
    expect(f.flooringContinuous?.value).toEqual({ continues: true, rooms: ["Bedroom", "Hallway", "Closet", "Living room"] });
  });
});

// ---------------------------------------------------------------------------------------------
describe("2. report conflicts with the manually entered scope", () => {
  it("flags 64 SF vs 48 SF and subfloor removed vs kept; keeps the PM's scope; changed lines need accept/reject again", async () => {
    const q = await setup();
    const room0 = (await rooms(q))[0];
    const manual = editable(room0.data);
    await scans.saveRoomScan(q.projectId, q.visitId, room0.locationId, {
      ...manual,
      materials: { ...manual.materials, subfloor: "clean", flooring: { ...manual.materials.flooring, affectedPct: 100 } },
      measurements: { ...manual.measurements, lengthFt: 8, widthFt: 6, heightFt: 8 },
    });
    await scans.decideLines(q.projectId, q.visitId, room0.locationId, ["mold.floor.remove", "mold.subfloor.clean"], "accept");
    expect(L((await rooms(q))[0].data.lines, "mold.floor.remove")).toMatchObject({ quantity: 48, status: "accepted" });

    const d = await upload(q, "H02-conflict-64sf-subfloor-removed.pdf");
    const v = (await reportView(q.projectId, q.visitId)).active!;
    const mm = v.mismatches.join("\n");
    expect(mm).toMatch(/Different area: you entered 8 × 6 ft; the report says 8 × 8 ft/);
    expect(mm).toMatch(/Different area: the report states 64 SF; your scope has 48 SF \(8 × 6 ft × 100%\)/);
    expect(mm).toMatch(/Subfloor: you have "clean and keep", the report says "remove"/);
    expect(v.changes.find((c) => c.key === "measurements")).toMatchObject({ conflict: true });
    expect(v.changes.find((c) => c.key === "subfloor")).toMatchObject({ conflict: true });
    // default apply: the PM's 48 SF and "clean" stay; accepted lines untouched
    await applyDefaults(q, d.id);
    let r = (await rooms(q))[0];
    expect(r.data.measurements.widthFt).toBe(6);
    expect(r.data.materials.subfloor).toBe("clean");
    expect(L(r.data.lines, "mold.floor.remove")).toMatchObject({ quantity: 48, status: "accepted" });
    // the PM explicitly takes the report's numbers → those lines go back to "suggested", marked
    await applyReport(q.projectId, q.visitId, d.id, ["Bedroom::measurements", "Bedroom::subfloor"]);
    r = (await rooms(q))[0];
    const fl = L(r.data.lines, "mold.floor.remove")!;
    expect(fl).toMatchObject({ quantity: 64, status: "suggested" });
    expect(fl.flags).toContain("Changed by the mold report: was 48 SF — accept or reject again.");
    expect(L(r.data.lines, "mold.subfloor.clean")).toBeUndefined();
    expect(L(r.data.lines, "mold.subfloor.remove")!.flags).toContain("New from the mold report — accept or reject.");
    expect(r.analysis.notes.join("\n")).toMatch(/Mold report changed: "Clean subfloor .*" \(48 SF, accepted before\) is no longer proposed/);
    const visit = await repo.getVisit(q.projectId, q.visitId);
    expect(visit.text).not.toMatch(/wood flooring with growth — (48|64) SF/); // nothing silently in the scope
    // accept → it prints
    await scans.decideLines(q.projectId, q.visitId, r.locationId, ["mold.floor.remove"], "accept");
    expect(L((await rooms(q))[0].data.lines, "mold.floor.remove")!.flags.join(" ")).not.toMatch(/Changed by the mold report/);
    expect((await repo.getVisit(q.projectId, q.visitId)).text).toMatch(/wood flooring with growth — 64 SF/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("3. missing and vague fields", () => {
  it("'widespread' with no SF, no measurements, no clearance/who, no year built, no source-fixed → still missing; no quantity guessed", async () => {
    const q = await setup();
    const d = await upload(q, "H03-missing-vague-widespread.pdf");
    const v = (await reportView(q.projectId, q.visitId)).active!;
    const sm = v.stillMissing.join("\n");
    expect(sm).toMatch(/Bedroom: room measurements — not in the report/);
    expect(sm).toMatch(/Bedroom: affected area — the report only says “Widespread mold growth was observed beneath the wood flooring in the bedroom\.” \(no SF or boundary\)/);
    expect(sm).toMatch(/Clearance criteria and who performs the post-remediation verification — not in the report/);
    expect(sm).toMatch(/Whether the moisture source is fixed — not in the report; remediation can't be finalized/);
    expect(sm).toMatch(/Year built — not in the report/);
    expect(sm).toMatch(/Remediation plan: how far removal goes/);
    expect(v.changes.map((c) => c.key)).not.toEqual(expect.arrayContaining(["measurements"]));
    expect(v.changes.find((c) => c.key === "floor.pct")).toBeUndefined();
    await applyDefaults(q, d.id);
    const r = (await rooms(q))[0];
    for (const id of ["mold.floor.remove", "mold.subfloor.clean", "mold.containment", "mold.finalclean"]) expect(L(r.data.lines, id)?.quantity, id).toBeNull();
    expect(r.data.materials.flooring.affectedPct).toBeNull();
    expect(L(r.data.lines, "mold.floor.remove")!.flags).toContain("Confirm the moisture source is fixed before starting.");
    expect((await repo.getVisit(q.projectId, q.visitId)).text).toMatch(/STILL MISSING after the mold report: Bedroom: affected area — the report only says/);
    const qa = (await scans.getVisitScans(q.projectId, q.visitId)).summary.qa.find((x) => x.text.startsWith("Mold: moisture source"));
    expect(qa?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe("4. growth beyond the floor", () => {
  it("walls N,E to 18\" + baseboard backs S + joists cleaned → drywall, cavity, joist and subfloor lines with the math", async () => {
    const q = await setup();
    const d = await upload(q, "H04-walls-baseboard-joists.pdf");
    await applyDefaults(q, d.id);
    const r = (await rooms(q))[0];
    const ls = r.data.lines;
    // 18" growth + 24" beyond = 42" → 48" sheet stop; N 12 LF × 4 ft + E 8 LF × 4 ft = 80 SF
    expect(L(ls, "mold.walls.remove")).toMatchObject({ quantity: 80, unit: "SF", item: 'drywall with growth to 48" (N, E)' });
    expect(L(ls, "mold.walls.remove")!.calc).toMatch(/growth to 18" \+ 24" beyond = 42" → 48"/);
    expect(L(ls, "mold.walls.cavity")).toMatchObject({ quantity: 80 });
    expect(L(ls, "drywall.replace")).toMatchObject({ quantity: 80, kind: "reconstruction" });
    // baseboard comes off all round (whole floor out) and the backs with growth are discarded
    expect(L(ls, "baseboard")).toMatchObject({ activity: "Remove", quantity: 40, unit: "LF" });
    expect(L(ls, "baseboard")!.justification).toMatch(/along the south wall.*discard/);
    // joists with growth: the subfloor has to come off (report silent on the subfloor), joists cleaned in place
    expect(r.analysis.notes.join(" ")).toMatch(/Assumed: Subfloor removed — the floor joists with growth can't be reached/);
    expect(L(ls, "mold.subfloor.remove")).toMatchObject({ quantity: 96 });
    expect(L(ls, "mold.subfloor.clean")).toBeUndefined();
    expect(L(ls, "mold.framing.clean")).toMatchObject({ quantity: 96, unit: "SF" });
    expect(L(ls, "mold.framing.clean")!.justification).toMatch(/surface growth on the floor joists/);
    // full-wall paint on every wall whose drywall or baseboard came off: 40 LF × 8 ft = 320 SF
    expect(L(ls, "walls.paint")).toMatchObject({ quantity: 320, unit: "SF" });
  });

  const ctx = (over: Partial<RoomContext> = {}): RoomContext => ({ rules: DEFAULT_RULES, roomLabel: "Unit 4D — Bedroom", run: [], exclusions: [], locationId: "l", reconstructionRequested: false, yearBuilt: 1925, ...over });
  const base = (materials: object) =>
    RoomScanData.parse({ loss: { type: "mold", assessmentReport: "received" }, source: { status: "repaired" }, materials: { flooring: { type: "wood", affected: true, affectedPct: 100 }, ...materials }, measurements: { lengthFt: 12, widthFt: 8, heightFt: 8 } });

  it("framing to be removed (rot) → structural line with no quantity, flagged for engineer/GC; subfloor comes off", () => {
    const f = rulesAnalyze(["Framing: the floor joists show rot and growth; remove and sister the affected joists."]);
    expect(f.framingGrowth?.value).toEqual({ growth: true, where: "joists", action: "remove" });
    const a = analyzeRoom(base({ framing: f.framingGrowth!.value }), ctx());
    expect(L(a.lines, "mold.framing.remove")).toMatchObject({ quantity: null, activity: "Remove & replace" });
    expect(L(a.lines, "mold.framing.remove")!.flags).toContain("Structural — needs an engineer/GC scope; not priced here.");
    expect(L(a.lines, "mold.subfloor.remove")).toBeDefined();
    expect(L(a.lines, "mold.framing.clean")).toBeUndefined();
  });
  it("joist growth but the report keeps the subfloor → access question, not a silent choice", () => {
    const a = analyzeRoom(base({ subfloor: "clean", framing: { growth: true, where: "joists", action: "clean" } }), ctx());
    expect(a.questions.join(" ")).toMatch(/growth on the floor joists but the subfloor stays/);
    expect(L(a.lines, "mold.subfloor.clean")).toBeDefined();
  });
  it("framing growth with no clean/remove decision → question and still missing", () => {
    const f = rulesAnalyze(["Framing: visible growth on the wall studs behind the vanity."]);
    expect(f.framingGrowth?.value).toEqual({ growth: true, where: "studs", action: null });
    expect(stillMissing(f, { yearBuiltKnown: true, runKnown: true }).join("\n")).toMatch(/Whether the studs with growth are cleaned or removed/);
    const a = analyzeRoom(base({ framing: f.framingGrowth!.value }), ctx());
    expect(a.questions.join(" ")).toMatch(/the wall studs have growth — clean in place, or remove/);
    expect(L(a.lines, "mold.framing.clean")).toMatchObject({ quantity: null });
  });
  it("walls with growth but no height → removal line with no quantity + question; walls not named → still missing", () => {
    const a = analyzeRoom(base({ walls: { material: "drywall", affectedWalls: ["W"], wetHeightIn: null } }), ctx());
    expect(L(a.lines, "mold.walls.remove")).toMatchObject({ quantity: null });
    expect(a.questions.join(" ")).toMatch(/how high does the growth go on walls W/);
    const f = rulesAnalyze(["Walls: visible growth on the drywall."]);
    const sm = stillMissing(f, { yearBuiltKnown: true, runKnown: true }).join("\n");
    expect(sm).toMatch(/Which walls have growth — the report doesn't name them/);
    expect(sm).toMatch(/How high the growth goes on the walls/);
  });
  it("baseboard backs only, floor partial → baseboard removed on that wall and discarded; no wall drywall lines", () => {
    const a = analyzeRoom(base({ flooring: { type: "wood", affected: true, affectedPct: 25 }, baseboard: { affected: true, walls: ["S"], action: "remove" } }), ctx());
    expect(L(a.lines, "baseboard")).toMatchObject({ quantity: 12, unit: "LF" });
    expect(L(a.lines, "mold.walls.remove")).toBeUndefined();
    expect(L(a.lines, "mold.floor.remove")).toMatchObject({ quantity: 24 }); // 96 × 25%
  });
});

// ---------------------------------------------------------------------------------------------
describe("5. moisture source not fixed / unknown", () => {
  it("ongoing leak → HOLD on every mitigation line, in the scope and in the checks; never a clean final scope", async () => {
    const q = await setup();
    const d = await upload(q, "H05-source-active.pdf");
    await applyDefaults(q, d.id);
    const view = await scans.getVisitScans(q.projectId, q.visitId);
    const r = view.rooms[0];
    expect(r.data.source.status).toBe("active");
    const mit = r.data.lines.filter((l) => l.kind !== "reconstruction");
    expect(mit.length).toBeGreaterThan(5);
    for (const l of mit) expect(l.flags.some((f) => f.startsWith("HOLD")), l.id).toBe(true);
    expect(r.analysis.pending[0]).toMatch(/^HOLD: the moisture source is not fixed \(report: “Moisture source: active roof leak/);
    expect(r.analysis.notes.join(" ")).toMatch(/HOLD.*this scope is not final/);
    expect(view.summary.qa.find((x) => x.text.startsWith("Mold: moisture source"))?.ok).toBe(false);
    expect((await repo.getVisit(q.projectId, q.visitId)).text).toMatch(/HOLD: the moisture source is not fixed/);
  });
  it("source not identified → not treated as fixed; listed as missing; lines say confirm first", () => {
    const f = rulesAnalyze(["Visible growth across the entire bedroom floor.", "Moisture source: the source has not been identified."]);
    expect(f.sourceFixed).toBeNull();
    expect(stillMissing(f, { yearBuiltKnown: true, runKnown: true }).join("\n")).toMatch(/moisture source is fixed — not in the report; remediation can't be finalized/);
    const a = analyzeRoom(RoomScanData.parse({ loss: { type: "mold", assessmentReport: "received" }, materials: { flooring: { type: "wood", affected: true, affectedPct: 100 } }, measurements: { lengthFt: 12, widthFt: 8, heightFt: 8 } }), {
      rules: DEFAULT_RULES, roomLabel: "Bedroom", run: [], exclusions: [], locationId: "l", reconstructionRequested: false, yearBuilt: 1925,
    });
    expect(L(a.lines, "mold.floor.remove")!.flags).toContain("Confirm the moisture source is fixed before starting.");
  });
});

// ---------------------------------------------------------------------------------------------
describe("6. pre-1978 building: hazard flag on every demolition line, every time", () => {
  const demo = (ls: ScopeLine[]) => ls.filter((l) => /^(Remove|Flood cut|Tear out)/i.test(l.activity));
  it("multi-room 1925 report: every removal line in every room carries the lead-safe flag; the scope prints it before demolition", async () => {
    const q = await setup();
    const d = await upload(q, "H01-multi-room-continuous-1925.pdf");
    await applyDefaults(q, d.id);
    const rs = await rooms(q);
    const all = rs.flatMap((r) => demo(r.data.lines));
    // bedroom: baseboard, flooring, underlayment · hallway (partial, walls not named): flooring, underlayment ·
    // closet: baseboard, flooring, underlayment · living room: flooring tear-out for the continuous run
    expect(all.length).toBe(9);
    for (const l of all) expect(l.flags.join(" "), l.id).toMatch(/Built 1925 \(before 1978\) — lead-safe \(RRP\)/);
    const bed = rs.find((r) => r.label.endsWith("Bedroom"))!;
    await scans.decideLines(q.projectId, q.visitId, bed.locationId, ["mold.floor.remove"], "accept");
    const text = (await repo.getVisit(q.projectId, q.visitId)).text;
    const hz = text.indexOf("⚠ Before demolition: Built 1925 (before 1978)");
    expect(hz).toBeGreaterThan(-1);
    expect(hz).toBeLessThan(text.indexOf("Remove & bag wood flooring with growth"));
  });
  it("walls/joists report (1925) and a report with no year built both flag demolition", async () => {
    for (const [file, re] of [["H04-walls-baseboard-joists.pdf", /Built 1925/], ["H02-conflict-64sf-subfloor-removed.pdf", /Year built unknown — confirm lead\/asbestos/]] as const) {
      await resetLocalDbForTests();
      const q = await setup();
      const d = await upload(q, file);
      await applyDefaults(q, d.id);
      const ls = (await rooms(q))[0].data.lines;
      expect(demo(ls).length, file).toBeGreaterThan(2);
      for (const l of demo(ls)) expect(l.flags.join(" "), `${file} ${l.id}`).toMatch(re);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("7. whole floor vs partial, and partial with no boundary", () => {
  it("30% of a 12 × 8 floor is priced at 28.8 SF, not 96", async () => {
    const q = await setup();
    const d = await upload(q, "H07a-partial-30pct.pdf");
    await applyDefaults(q, d.id);
    const ls = (await rooms(q))[0].data.lines;
    expect(L(ls, "mold.floor.remove")).toMatchObject({ quantity: 28.8, calc: "12 ft × 8 ft = 96 SF × 30% = 28.8 SF" });
    expect(L(ls, "mold.subfloor.clean")?.quantity).toBe(28.8);
  });
  it("'a portion of the floor' with no SF or boundary → no quantity, a clarification question, and still missing", async () => {
    const q = await setup();
    const d = await upload(q, "H07b-partial-no-boundary.pdf");
    const v = (await reportView(q.projectId, q.visitId)).active!;
    expect(v.changes.find((c) => c.key === "floor.pct")).toBeUndefined();
    expect(v.stillMissing.join("\n")).toMatch(/Bedroom: growth on part of the floor with no SF or boundary — measure the affected area/);
    await applyDefaults(q, d.id);
    const r = (await rooms(q))[0];
    expect(L(r.data.lines, "mold.floor.remove")).toMatchObject({ quantity: null });
    expect(r.analysis.questions.join(" ")).toMatch(/the report says growth covers part of the floor but gives no SF or boundary/);
  });
  it("manual entry without an extent is never priced as the whole floor", async () => {
    const q = await setup();
    const r0 = (await rooms(q))[0];
    await scans.saveRoomScan(q.projectId, q.visitId, r0.locationId, { ...editable(r0.data), measurements: { ...r0.data.measurements, lengthFt: 12, widthFt: 8, heightFt: 8 } });
    const ls = (await rooms(q))[0].data.lines;
    expect(L(ls, "mold.floor.remove")).toMatchObject({ quantity: null, calc: "12 ft × 8 ft = 96 SF — extent not confirmed (whole floor or part?)" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("8. wrong-report variants", () => {
  it.each([
    ["H08a-unit-mismatch-4B.pdf", /This report states unit 4B, but this project is 308 E 72nd St/],
    ["H08b-name-mismatch.pdf", /This report states name "Robert Smith"/],
    ["H08c-street-west-not-east.pdf", /This report states address "308 W 72nd St/],
    ["H08d-street-avenue-not-street.pdf", /This report states address "308 E 72nd Ave/],
  ])("%s → Wrong report?, and Cancel leaves nothing attached", async (file, re) => {
    const q = await setup();
    const before = (await rooms(q))[0].data;
    const d = await upload(q, file);
    expect(d.status).toBe("needs_confirmation");
    expect(d.wrongReport).toMatch(/^Wrong report\? /);
    expect(d.wrongReport).toMatch(re);
    await expect(applyReport(q.projectId, q.visitId, d.id, [])).rejects.toThrow(/Confirm the report/);
    const del = await call(docRoute.DELETE as Handler<{ pid: string; did: string }>, "DELETE", { pid: q.projectId, did: d.id });
    expect(del.status).toBe(200);
    expect((await repo.listDocuments(q.projectId)).filter((x) => x.kind === "mold_report")).toEqual([]);
    const v = await reportView(q.projectId, q.visitId);
    expect([v.active, v.reports.length]).toEqual([null, 0]);
    const after = (await rooms(q))[0].data;
    expect(after.reportDocumentId).toBeNull();
    expect(after.lines.map((l) => [l.id, l.quantity])).toEqual(before.lines.map((l) => [l.id, l.quantity]));
  });
  it("the same address spelled out (308 East 72nd Street, Apt. 4D, 'Vinelli, Carol A.') is NOT a wrong report", async () => {
    const q = await setup();
    const d = await upload(q, "H08e-same-address-spelled-out.pdf");
    expect([d.status, d.wrongReport]).toEqual(["ready", null]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("9. bad input", () => {
  it("scanned PDF with no selectable text → unreadable, no findings faked, AI-not-enabled shown", async () => {
    const q = await setup();
    const d = await upload(q, "H09a-scanned-no-text.pdf");
    expect([d.status, d.readable]).toEqual(["unreadable", false]);
    const stored = await repo.getDocument(q.projectId, d.id);
    const f = stored.findings as ReturnType<typeof rulesAnalyze>;
    expect(f.rooms).toEqual([]);
    expect([f.address, f.dims, f.subfloor, f.containment, f.sourceFixed]).toEqual([null, null, null, null, null]);
    const v = await reportView(q.projectId, q.visitId);
    expect(v.active).toBeNull();
    expect(v.reports[0].status).toBe("unreadable");
    expect(v.ai.message).toMatch(/^AI analysis not enabled/);
    await expect(applyReport(q.projectId, q.visitId, d.id, [])).rejects.toThrow(/could not be read/);
  });
  it("report in table form → one room per row with its own size, area and extent", async () => {
    const f = rulesAnalyze(await extractPageTexts(H("H09b-table-form.pdf")));
    expect(f.rooms.map((r) => [r.value.name, r.value.lengthFt, r.value.widthFt, r.value.areaSF, r.value.coverage])).toEqual([
      ["Bedroom", 12, 8, 96, { whole: true, pct: 100 }],
      ["Hallway", 10, 4, 20, { whole: false, pct: 50 }],
    ]);
    const sm = stillMissing(f, { yearBuiltKnown: false, runKnown: false }).join("\n");
    expect(sm).toMatch(/Bedroom: ceiling height — not in the report/);
    expect(sm).toMatch(/Hallway: ceiling height — not in the report/);
  });
  it("a water-damage report (not mold) → 'Not a mold report?', never applied, cannot be confirmed into use", async () => {
    const q = await setup();
    const d = await upload(q, "H09c-water-damage-report.pdf");
    expect(d.status).toBe("wrong_type");
    expect(d.wrongType).toMatch(/^Not a mold report\? This file reads like a water-damage report/);
    expect((await reportView(q.projectId, q.visitId)).active).toBeNull();
    await expect(applyReport(q.projectId, q.visitId, d.id, [])).rejects.toThrow(/isn't a mold report/);
    await expect(confirmReport(q.projectId, d.id)).rejects.toThrow(/isn't a mold report/);
    expect((await rooms(q))[0].data.reportDocumentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe("10. a second report replaces the first", () => {
  it("first is superseded; changes are re-flagged; no duplicated rooms, lines or scope items", async () => {
    const q = await setup();
    const a = await upload(q, "sample-mold-report-308-E-72nd-St-4D.pdf", SAMPLE_A);
    await applyDefaults(q, a.id);
    let r = (await rooms(q))[0];
    await scans.decideLines(q.projectId, q.visitId, r.locationId, ["mold.floor.remove", "mold.subfloor.clean"], "accept");
    const b = await upload(q, "H10-revised-report.pdf");
    expect((await repo.getDocument(q.projectId, a.id)).status).toBe("superseded");
    const v = (await reportView(q.projectId, q.visitId)).active!;
    expect(v.id).toBe(b.id);
    const meas = v.changes.find((c) => c.key === "measurements")!;
    expect(meas).toMatchObject({ conflict: false, previousReport: "12 × 8 ft, 8 ft ceiling", proposed: "12 × 10 ft, 8 ft ceiling" });
    expect(v.changes.find((c) => c.key === "subfloor")).toMatchObject({ conflict: false, previousReport: "Clean and treat (stays)", proposed: "Remove" });
    expect(v.replaced.join("\n")).toMatch(/room measurements — the earlier report said "12 × 8 ft, 8 ft ceiling", this one says "12 × 10 ft, 8 ft ceiling"/);
    expect(v.mismatches.filter((m) => /Different area|Subfloor/.test(m))).toEqual([]); // earlier-report values are not "your entries"
    await applyDefaults(q, b.id);
    const rs = await rooms(q);
    expect(rs).toHaveLength(1);
    r = rs[0];
    expect(r.data.reportDocumentId).toBe(b.id);
    expect(new Set(r.data.lines.map((l) => l.id)).size).toBe(r.data.lines.length);
    expect(L(r.data.lines, "mold.floor.remove")).toMatchObject({ quantity: 120, status: "suggested" });
    expect(L(r.data.lines, "mold.floor.remove")!.flags).toContain("Changed by the mold report: was 96 SF — accept or reject again.");
    expect(r.analysis.notes.join("\n")).toMatch(/Mold report changed: Room measurements: was "12 × 8 ft, 8 ft ceiling" \(earlier report\), now "12 × 10 ft, 8 ft ceiling"/);
    const visit = await repo.getVisit(q.projectId, q.visitId);
    const ids = visit.facts.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(visit.text.match(/Clearance criteria/g) ?? []).toHaveLength(0); // the revised report answers clearance
    const reports = (await reportView(q.projectId, q.visitId)).reports.map((x) => x.status).sort();
    expect(reports).toEqual(["ready", "superseded"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("11. large multi-page report on the Blob path", () => {
  it("a > 4.5 MB, 9-page report gets a Blob token, is ingested from Blob, extracted and analyzed", async () => {
    const pages = [...HARD["H01-multi-room-continuous-1925.pdf"], ...HARD["H01-multi-room-continuous-1925.pdf"], ...HARD["H01-multi-room-continuous-1925.pdf"]];
    const { randomBytes } = await import("node:crypto");
    const pad = new Uint8Array(randomBytes(5 * 1024 * 1024)); // incompressible, like photo data
    const bytes: Uint8Array = await buildPdf(pages, { padBytes: pad });
    expect(bytes.length).toBeGreaterThan(4.5 * 1024 * 1024);
    // the client never sends it through the 4.5 MB serverless route
    expect(uploadRoute(bytes.length, true)).toBe("blob");
    expect(uploadRoute(bytes.length, false)).toBe("too_large");
    expect(uploadRoute(1024, false)).toBe("server");
    expect(SERVER_UPLOAD_LIMIT_BYTES).toBeLessThan(4.5 * 1024 * 1024);
    const q = await setup();
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_teststore123_" + "s".repeat(24);
    const tok = await call(blobTokenRoute.POST as Handler<{ pid: string }>, "POST", { pid: q.projectId }, { type: "blob.generate-client-token", payload: { pathname: `projects/${q.projectId}/big-mold-report.pdf`, multipart: true, clientPayload: null } });
    expect(tok.status).toBe(200);
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const url = `https://teststore123.private.blob.vercel-storage.com/projects/${q.projectId}/big-mold-report-x1.pdf`;
    const d = await ingestReport(q.projectId, { name: "big-mold-report.pdf", bytes, blobUrl: url });
    expect(d.status).toBe("ready");
    const doc = await repo.getDocument(q.projectId, d.id);
    expect([doc.pageCount, doc.storedPath]).toEqual([9, `blob:${url}`]);
    const f = doc.findings as ReturnType<typeof rulesAnalyze>;
    expect(f.rooms.map((r) => r.value.name)).toEqual(["Bedroom", "Hallway", "Closet", "Living room"]);
    expect(f.yearBuilt?.value).toBe(1925);
  });
});
