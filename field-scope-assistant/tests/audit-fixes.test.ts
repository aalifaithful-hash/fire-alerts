import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { DEFAULT_RULES } from "@/lib/defaults";
import { airMoverCalc, analyzeRoom, type RoomContext } from "@/lib/roomRules";
import { RoomScanData } from "@/lib/scan";
import { floodCutSF, takeoff } from "@/lib/takeoff";
import { sameStreet } from "@/lib/fnol";
import { planRooms, proposeVisit, type VisitRoom } from "@/lib/report/match";
import { rulesAnalyze } from "@/lib/report/rules";

/** Independent audit findings (4 partials + 10 issues). Rules only, no AI. Fictional data only. */
process.env.DATABASE_URL = "pglite://memory";
delete process.env.POSTGRES_URL;
delete process.env.APP_PASSCODE;
delete process.env.ANTHROPIC_API_KEY;
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-audit-"));

const ctx = (over: Partial<RoomContext> = {}): RoomContext => ({ rules: DEFAULT_RULES, roomLabel: "Room", run: [], exclusions: [], locationId: "l", reconstructionRequested: false, yearBuilt: 1990, ...over });

const { resetLocalDbForTests } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const scans = await import("@/lib/scans");
const exportRoute = await import("@/app/api/projects/[pid]/visits/[vid]/export/route");

const water = {
  loss: { type: "water", category: "2", waterClass: "2" },
  source: { where: "in_room", status: "repaired", waterSource: "clean_supply" },
  materials: { flooring: { type: "LVP", affected: true, affectedPct: 100 } },
  measurements: { lengthFt: 12, widthFt: 10, heightFt: 8 },
  moisturePoints: [{ id: "m1", label: "MP1", surface: "floor", reading: "30", dryGoal: "12" }],
};
const mold = { loss: { type: "mold" }, source: { status: "repaired" }, materials: { flooring: { type: "wood", affected: true, affectedPct: 100 } }, measurements: { lengthFt: 12, widthFt: 10, heightFt: 8 } };

async function visit(serviceLine: string, rooms: [string, unknown][]) {
  const p = await repo.createProject({ address: "1 Audit Test Lane", customer: "Test Customer", claimNumber: "CLM-TEST-1" });
  const v = await repo.createVisit(p.id, { type: "initial_mitigation", visitDate: "2026-11-07", stage: "initial_walkthrough", serviceLine: serviceLine as never });
  const locs = [];
  for (const [room, scan] of rooms) {
    const l = await repo.insertLocation(p.id, { room });
    await scans.saveRoomScan(p.id, v.id, l.id, scan);
    locs.push(l);
  }
  return { p, v, locs };
}
const acceptAllWithQty = async (pid: string, vid: string, lid: string) => {
  const view = await scans.getVisitScans(pid, vid);
  const ids = view.rooms.find((r) => r.locationId === lid)!.data.lines.filter((l) => l.quantity != null && l.status === "suggested").map((l) => l.id);
  return scans.decideLines(pid, vid, lid, ids, "accept");
};
const exportText = async (pid: string, vid: string) => {
  const res = await (exportRoute.GET as (r: NextRequest, c: { params: Promise<{ pid: string; vid: string }> }) => Promise<Response>)(new NextRequest("http://localhost/x?format=pdf"), { params: Promise.resolve({ pid, vid }) });
  const { extractText, getDocumentProxy } = await import("unpdf");
  return (await extractText(await getDocumentProxy(new Uint8Array(await res.arrayBuffer())), { mergePages: true })).text as string;
};

describe("(a) + 1 — one readiness rule: pre-send can't pass while an important check fails; export says DRAFT", () => {
  beforeEach(() => resetLocalDbForTests());

  it("incomplete mold scope (report still pending) → pre-send fails and the export is DRAFT", async () => {
    const { p, v, locs } = await visit("mold", [["Bedroom", { ...mold, loss: { type: "mold", assessmentReport: "pending" } }]]);
    await acceptAllWithQty(p.id, v.id, locs[0].id);
    const view = await scans.setScanOptions(p.id, v.id, { crew: { crewChiefs: 1, subcontractors: 1 } });
    expect(view.summary.presend.ok).toBe(false);
    expect(view.summary.presend.failures.join("\n")).toMatch(/Bedroom: Affected area and extent \(SF\)/);
    expect(await exportText(p.id, v.id)).toMatch(/DRAFT — NOT READY TO SEND/);
  });

  it("an important checklist failure (moisture points not mapped) blocks pre-send", async () => {
    const { p, v, locs } = await visit("mitigation", [["Kitchen", { ...water, moisturePoints: [] }]]);
    await acceptAllWithQty(p.id, v.id, locs[0].id);
    const view = await scans.setScanOptions(p.id, v.id, { crew: { crewChiefs: 1, subcontractors: 0 } });
    expect(view.summary.qa.find((q) => /Moisture points mapped/.test(q.text))?.ok).toBe(false);
    expect(view.summary.presend.failures).toContain("Check failed: Moisture points mapped in water rooms");
    expect(view.summary.presend.ok).toBe(false);
  });

  it("a complete scope can pass; advisory items (estimated run times, undecided lines) don't block", async () => {
    const { p, v, locs } = await visit("mitigation", [["Kitchen", water]]);
    await acceptAllWithQty(p.id, v.id, locs[0].id);
    const view = await scans.setScanOptions(p.id, v.id, { crew: { crewChiefs: 1, subcontractors: 0 } });
    const blocking = view.summary.qa.filter((q) => !q.ok && !q.na && !q.advisory);
    expect(blocking).toEqual([]);
    expect(view.summary.presend.ok).toBe(true);
    expect(await exportText(p.id, v.id)).not.toMatch(/DRAFT — NOT READY TO SEND/);
  });
});

describe("2 — partial project updates never erase unrelated info", () => {
  beforeEach(() => resetLocalDbForTests());
  it("{category} only → address, customer and claim number stay", async () => {
    const p = await repo.createProject({ address: "9 Merge Test St", customer: "Test Customer", claimNumber: "CLM-TEST-9" });
    const u = await repo.updateProject(p.id, { category: "Cat 2" });
    expect(u).toMatchObject({ address: "9 Merge Test St", customer: "Test Customer", claimNumber: "CLM-TEST-9", category: "Cat 2" });
    // a field sent empty on purpose is cleared; others untouched
    const c = await repo.updateProject(p.id, { customer: "" });
    expect(c).toMatchObject({ customer: null, address: "9 Merge Test St", claimNumber: "CLM-TEST-9", category: "Cat 2" });
  });
});

describe("3 — mold findings never land in the wrong room", () => {
  const vr = (roomName: string, unit: string | null = null, i = 0): VisitRoom => ({ locationId: `l${roomName}${i}`, label: `${unit ? `Unit ${unit} — ` : ""}${roomName}`, roomName, unit, scan: RoomScanData.parse({ loss: { type: "mold" } }) });
  const f = rulesAnalyze(["SAMPLE REPORT\nBedroom: Visible mold growth across the entire bedroom floor. Room dimensions: 12 ft x 10 ft, ceiling height 8 ft."]);

  it("'Bedroom' goes to Bedroom, not Master Bedroom (whatever the order)", () => {
    const plans = planRooms(f, [vr("Master Bedroom"), vr("Bedroom")]);
    expect(plans[0].target?.roomName).toBe("Bedroom");
  });
  it("only a partial match → matched but flagged to check", () => {
    const { plans, mismatches } = proposeVisit(f, [vr("Master Bedroom"), vr("Kitchen")], 1990);
    expect(plans[0].target?.roomName).toBe("Master Bedroom");
    expect(mismatches.join(" ")).toMatch(/matched to "Master Bedroom" by a partial name — check/);
  });
  it("two candidates → ambiguous: nothing applied automatically, the PM is told which rooms", () => {
    const { plans, changes, mismatches } = proposeVisit(f, [vr("Master Bedroom"), vr("Guest Bedroom")], 1990);
    expect(plans[0].target).toBeNull();
    expect(plans[0].ambiguous).toEqual(["Master Bedroom", "Guest Bedroom"]);
    expect(mismatches.join(" ")).toMatch(/matches more than one room here \(Master Bedroom, Guest Bedroom\)/);
    expect(changes.filter((c) => c.room === "Bedroom").every((c) => c.conflict)).toBe(true);
  });
  it("two exact 'Bedroom's in different units → the report's unit decides; another unit is never a target", () => {
    const fu = rulesAnalyze(["SAMPLE REPORT\nProperty: 1 Test Pl, Unit 4D, New York, NY 10001\nBedroom: Visible mold growth across the entire bedroom floor."]);
    expect(fu.unit?.value).toMatch(/4D/);
    const plans = planRooms(fu, [vr("Bedroom", "4B", 1), vr("Bedroom", "4D", 2)]);
    expect(plans[0].target?.unit).toBe("4D");
    expect(planRooms(fu, [vr("Bedroom", "4B", 1)])[0].target).toBeNull();
  });
});

describe("4 — similar-but-different addresses don't match", () => {
  it("whole street name compared", () => {
    expect(sameStreet("10 Lake View Road", "10 Lake Shore Road")).toBe(false);
    expect(sameStreet("10 Lake View Road, Brooklyn, NY", "10 Lake View Rd")).toBe(true);
    expect(sameStreet("308 E 72nd St, Unit 4D, New York, NY 10021", "308 East 72nd Street, Apt. 4D, New York, NY 10021")).toBe(true);
    expect(sameStreet("308 E 72nd St", "308 E 72nd Ave")).toBe(false);
    expect(sameStreet("308 E 72nd St", "308 W 72nd St")).toBe(false);
    expect(sameStreet("12 Martin Luther King Jr Blvd", "12 Martin Luther King Jr Blvd, Newark")).toBe(true);
    expect(sameStreet("12 Martin Luther King Jr Blvd", "12 Martin Luther Blvd")).toBe(false);
  });
});

describe("(d) + 5 — a form save never erases a separately saved quantity or run time", () => {
  beforeEach(() => resetLocalDbForTests());
  it("stale form (opened before the quantity / run time were set) saved afterwards → both kept", async () => {
    const { p, v, locs } = await visit("mitigation", [["Kitchen", water]]);
    const lid = locs[0].id;
    const staleForm = (await scans.getVisitScans(p.id, v.id)).rooms[0].data; // what the open form holds
    await scans.setLineQuantity(p.id, v.id, lid, "extract", 99);
    await scans.setLineDuration(p.id, v.id, lid, "equip.airmovers", 96);
    const { lines: _l, decisions: _d, ...form } = staleForm;
    void _l;
    void _d;
    const view = await scans.saveRoomScan(p.id, v.id, lid, { ...form, materials: { ...form.materials, walls: { ...form.materials.walls, wetHeightIn: 6 } } }, { fromForm: true });
    const d = view.rooms[0].data;
    expect(d.quantityOverrides).toEqual({ extract: 99 });
    expect(d.durationOverrides).toEqual({ "equip.airmovers": 96 });
    expect(d.materials.walls.wetHeightIn).toBe(6);
    expect(d.lines.find((x) => x.id === "extract")!.quantity).toBe(99);
  });
});

describe("(b) + 6 — the installed count beats an earlier typed quantity", () => {
  it("override 2 typed before 5 air movers were placed → 5 used, the old 2 flagged", () => {
    const calc = airMoverCalc(120, DEFAULT_RULES).recommended;
    const d = RoomScanData.parse({ ...water, quantityOverrides: { "equip.airmovers": 2 }, equipmentPlaced: [{ kind: "air_mover", qty: 5 }] });
    const am = analyzeRoom(d, ctx()).lines.find((x) => x.id === "equip.airmovers")!;
    expect(am.quantity).toBe(5);
    expect(am.source).toBe("measured");
    expect(am.flags.join(" ")).toMatch(/An earlier entered quantity \(2\) is not used — the installed count \(5\) governs/);
    expect(am.duration!.equipmentDays).toBe(15);
    expect(calc).toBeGreaterThan(0);
  });
  it("no installed count → the typed quantity still applies", () => {
    const d = RoomScanData.parse({ ...water, quantityOverrides: { "equip.airmovers": 2 } });
    expect(analyzeRoom(d, ctx()).lines.find((x) => x.id === "equip.airmovers")!).toMatchObject({ quantity: 2, source: "pm" });
  });
});

describe("(c) + 7 + 8 — PPE survives excluding the first mold room and follows Info's Production days", () => {
  beforeEach(() => resetLocalDbForTests());
  it("first mold room excluded → PPE moves to the next mold room in the scope", async () => {
    const { p, v, locs } = await visit("mold", [["Bedroom", mold], ["Den", mold]]);
    await scans.setScanOptions(p.id, v.id, { crew: { crewChiefs: 1, subcontractors: 1 } });
    const view = await scans.setScanOptions(p.id, v.id, { exclusions: [{ target: "room", locationId: locs[0].id, reason: "customer declined this room", decidedBy: "customer", signature: "verbal" }] });
    const den = view.rooms.find((r) => r.label === "Den")!.data.lines.find((x) => x.id === "mold.ppe")!;
    expect(den.quantity).toBe(4); // 2 people × 2 days
    expect(den.status).not.toBe("excluded");
  });
  it("Production days set on Info → PPE uses them", async () => {
    const { p, v } = await visit("mold", [["Bedroom", mold]]);
    await repo.updateProject(p.id, { productionDays: "3 days" });
    const view = await scans.setScanOptions(p.id, v.id, { crew: { crewChiefs: 1, subcontractors: 1 } });
    const ppe = view.rooms[0].data.lines.find((x) => x.id === "mold.ppe")!;
    expect(ppe.quantity).toBe(6);
    expect(ppe.calc).toMatch(/× 3 days \(production days “3 days” \(project Info\)\) = 6 sets/);
  });
});

describe("9 — a rejected dehumidifier stays out of the equipment schedule", () => {
  beforeEach(() => resetLocalDbForTests());
  it("placed dehumidifier rejected → no dehumidifier row (the calculated count doesn't bring it back)", async () => {
    const { p, v, locs } = await visit("mitigation", [["Kitchen", { ...water, equipmentPlaced: [{ kind: "dehumidifier", qty: 1 }] }]]);
    let view = await scans.getVisitScans(p.id, v.id);
    expect(view.summary.equipmentSchedule.rows.some((r) => r.type === "Dehumidifiers (water drying)")).toBe(true);
    view = await scans.decideLines(p.id, v.id, locs[0].id, ["equip.dehu"], "reject");
    expect(view.summary.equipmentSchedule.rows.some((r) => /Dehumidifier/.test(r.type))).toBe(false);
  });
});

describe("10 — windows come out of a drywall cut", () => {
  const wall = (openings: object[]) => takeoff(RoomScanData.parse({ measurements: { lengthFt: 10, widthFt: 10, heightFt: 8, openings } }).measurements).walls.find((w) => w.label === "N")!;
  it("10 × 8 wall, full-height cut, 4 × 4 window → 80 − 16 = 64 SF", () => {
    const r = floodCutSF(wall([{ id: "w", kind: "window", wall: "N", widthIn: 48, heightIn: 48 }]), 96, 8);
    expect(r.sf).toBe(64);
    expect(r.calc).toMatch(/full height\) = 80 SF − window 4 × 4 ft = 16 SF = 64 SF/);
  });
  it("partial cut: the window counts only from its sill; no sill height → not subtracted and flagged", () => {
    const sill36 = floodCutSF(wall([{ id: "w", kind: "window", wall: "N", widthIn: 48, heightIn: 48, sillIn: 36 }]), 48, 8);
    expect(sill36.sf).toBe(36); // 10 × 4 = 40 − (4 ft × 1 ft above the 36" sill up to 48") = 36
    const unknown = floodCutSF(wall([{ id: "w", kind: "window", wall: "N", widthIn: 48, heightIn: 48 }]), 48, 8);
    expect(unknown).toMatchObject({ sf: 40, unknownSills: 1 });
    expect(unknown.calc).toMatch(/window not subtracted — sill height not entered/);
  });
  it("full-height cut keeps the drywall above a door (door only to its height)", () => {
    const r = floodCutSF(wall([{ id: "d", kind: "door", wall: "N", widthIn: 36, heightIn: 80 }]), 96, 8);
    expect(r.sf).toBe(r1(80 - 3 * (80 / 12)));
  });
  it("partial cut below the door height is unchanged (door width × cut)", () => {
    const r = floodCutSF(wall([{ id: "d", kind: "door", wall: "N", widthIn: 36, heightIn: 80 }]), 48, 8);
    expect(r.sf).toBe(28); // 10 × 4 = 40 − 3 × 4 = 28
  });
  it("in the room rules: mold removal to full height with a window → 64 SF, and a sill question when needed", () => {
    const d = RoomScanData.parse({ ...mold, materials: { ...mold.materials, walls: { material: "drywall", affectedWalls: ["N"], floodCut: 96 } }, measurements: { lengthFt: 10, widthFt: 10, heightFt: 8, openings: [{ id: "w", kind: "window", wall: "N", widthIn: 48, heightIn: 48 }] } });
    expect(analyzeRoom(d, ctx()).lines.find((x) => x.id === "mold.walls.remove")!.quantity).toBe(64);
    const half = RoomScanData.parse({ ...d, materials: { ...d.materials, walls: { ...d.materials.walls, floodCut: 48 } } });
    expect(analyzeRoom(half, ctx({ roomLabel: "Den" })).questions.join(" ")).toMatch(/Den: enter the window sill height/);
  });
});
const r1 = (x: number) => Math.round(x * 10) / 10;
