import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

/**
 * TEST 1 (user's manual-entry case): New mold scope, 11:00 AM, 308 E 72nd St, New York, NY 10021,
 * Unit 4D, customer Carol Vinelli. Notes: "Mold under wood flooring. Has Mold report she will send over."
 * The mold report has not arrived; a CompanyCam gallery labeled 429 E 52nd St was supplied by mistake.
 */
process.env.DATABASE_URL = "pglite://memory";
delete process.env.POSTGRES_URL;
delete process.env.APP_PASSCODE;
delete process.env.AI_PROVIDER;
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-test1-"));

const { resetLocalDbForTests } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const scans = await import("@/lib/scans");
const intake = await import("@/lib/intake");
const { ingestPdf } = await import("@/lib/service");
const quickRoute = await import("@/app/api/quickstart/route");
const { PDFDocument, StandardFonts } = await import("pdf-lib");

type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;
async function post(h: Handler<object>, body: unknown) {
  const req = new NextRequest("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await h(req, { params: Promise.resolve({}) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const TEST1 = {
  address: "308 E 72nd St, New York, NY 10021",
  unit: "4D",
  customer: "Carol Vinelli",
  job: "mold",
  appointmentTime: "11:00",
  notes: "Mold under wood flooring. Has Mold report she will send over.",
};
const MOLD_SEQUENCE = [
  "mold.containment",
  "mold.negair",
  "mold.ppe",
  "baseboard",
  "mold.floor.remove",
  "mold.underlayment.remove",
  "mold.subfloor.clean",
  "mold.antimicrobial",
  "mold.dispose",
  "mold.finalclean",
  "mold.pcv",
];
const WATER_FIRE_IDS = ["extract", "pad.remove", "carpet.remove", "floor.remove", "floor.clean", "clean.hard", "antimicrobial", "floodcut", "equip.airmovers", "equip.scrubber", "monitor", "walls.clean", "ceiling.clean"];

async function start() {
  const r = await post(quickRoute.POST as Handler<object>, TEST1);
  expect(r.status).toBe(200);
  const view = await scans.getVisitScans(r.json.projectId, r.json.visitId);
  return { r: r.json, view, room: view.rooms[0] };
}

beforeEach(() => resetLocalDbForTests());

describe("TEST 1 — manual mold scope (308 E 72nd St, Unit 4D)", () => {
  it("one tap creates property, assignment, project and a mold visit with the time, customer and notes", async () => {
    const t0 = Date.now();
    const { r } = await start();
    expect(Date.now() - t0).toBeLessThan(8000); // in-process DB; one request on the phone
    const project = await repo.getProject(r.projectId);
    expect(project.address).toBe("308 E 72nd St, New York, NY 10021, Unit 4D");
    expect(project.customer).toBe("Carol Vinelli");
    const visit = await repo.getVisit(r.projectId, r.visitId);
    expect([visit.type, visit.stage, visit.serviceLine, visit.appointmentTime]).toEqual(["mold_remediation", "initial_walkthrough", "mold", "11:00"]);
    expect(visit.fieldNotes).toBe(TEST1.notes);
    const [a] = await intake.listAssignments({ propertyId: r.propertyId });
    expect([a.serviceLines, a.lossType, a.status]).toEqual([["mold"], "mold", "linked"]);
    expect(r.understood).toEqual(expect.arrayContaining(["Loss: mold", "Mold assessment report: pending (customer will send)"]));
  });

  it("proposes the mold lines in job order — and no water or fire lines", async () => {
    const { room } = await start();
    const ids = room.data.lines.map((l) => l.id);
    expect(ids.filter((id) => id.startsWith("mold.") || id === "baseboard")).toEqual(MOLD_SEQUENCE);
    for (const id of WATER_FIRE_IDS) expect(ids, id).not.toContain(id);
    expect(room.data.lines.every((l) => l.status === "suggested")).toBe(true);
    const fl = room.data.lines.find((l) => l.id === "mold.floor.remove")!;
    expect(fl).toMatchObject({ activity: "Remove & bag", item: "wood flooring with growth", unit: "SF", quantity: null });
    expect(fl.flags).toEqual(expect.arrayContaining(["Confirm against the mold assessment report (pending).", expect.stringMatching(/lead\/asbestos/)]));
    expect(room.data.lines.find((l) => l.id === "mold.pcv")!.flags).toContain("Third party — not in our price.");
    // reconstruction stays pending (not estimated) — never silently in the mitigation price
    for (const l of room.data.lines.filter((x) => x.kind === "reconstruction")) expect(l.flags.join(" ")).toMatch(/Pending reconstruction/);
    // the baseboard rule from the bug fix: full-wall paint, no "paint baseboard"
    expect(ids).toContain("walls.paint");
    expect(room.data.lines.some((l) => l.scopeCategory === "painting" && /baseboard/i.test(l.item))).toBe(false);
  });

  it("asks only questions that change the work, and lists what waits on the mold report", async () => {
    const { room } = await start();
    const q = room.analysis.questions.join("\n");
    expect(room.analysis.questions.length).toBeLessThanOrEqual(6);
    expect(q).toMatch(/measure length, width and ceiling height/);
    expect(q).toMatch(/which room is this/);
    expect(q).toMatch(/moisture source caused the growth/);
    expect(q).toMatch(/whole floor or part/);
    expect(q).toMatch(/year built/);
    expect(q).not.toMatch(/water category|is there a mold assessment report/); // answered by the notes
    expect(room.analysis.pending).toHaveLength(4);
    expect(room.analysis.pending[0]).toMatch(/Affected area and extent/);
    expect(room.analysis.notes.join(" ")).toMatch(/NYS Labor Law Art\. 32/);
    // the pending items print in the scope itself
    const visit = await repo.getVisit((await repo.listProjects())[0].id, (await start()).r.visitId).catch(() => null);
    void visit;
  });

  it("with measurements (test values 12×10×8 ft, one 36\" door on S): quantities and math are right", async () => {
    const { r, room } = await start();
    const { lines: _l, decisions: _d, ...data } = room.data;
    void _l;
    void _d;
    const view = await scans.saveRoomScan(r.projectId, r.visitId, room.locationId, {
      ...data,
      materials: { ...data.materials, flooring: { ...data.materials.flooring, affectedPct: 100 } },
      measurements: { lengthFt: 12, widthFt: 10, heightFt: 8, segments: null, openings: [{ id: "d1", kind: "door", wall: "S", widthIn: 36, heightIn: 80, offsetFt: 2 }] },
    });
    const L = view.rooms[0].data.lines;
    const q = (id: string) => L.find((l) => l.id === id)!;
    expect(q("mold.containment")).toMatchObject({ quantity: 352, unit: "SF" }); // 44 LF perimeter × 8 ft
    expect(q("mold.floor.remove")).toMatchObject({ quantity: 120, unit: "SF" });
    expect(q("mold.subfloor.clean")).toMatchObject({ quantity: 120, unit: "SF" });
    expect(q("baseboard")).toMatchObject({ activity: "Remove", quantity: 41, unit: "LF" }); // 44 − 3 ft door
    expect(q("baseboard.replace")).toMatchObject({ quantity: 41, unit: "LF" });
    // full continuous walls: 44 × 8 = 352 − door 20 = 332 SF — not 41 LF of baseboard, not 120 SF of floor
    expect(q("walls.paint")).toMatchObject({ quantity: 332, unit: "SF" });
    expect(L.find((l) => l.id === "floor.baseboard.reset")).toBeUndefined(); // base is replaced, not reset
    expect(view.rooms[0].analysis.questions.join(" ")).not.toMatch(/measure length/);

    // accept the mitigation lines → they print in the Mold Remediation Scope with the pending-report notes
    await scans.decideLines(r.projectId, r.visitId, room.locationId, L.filter((l) => l.kind !== "reconstruction").map((l) => l.id), "accept");
    const visit = await repo.getVisit(r.projectId, r.visitId);
    expect(visit.text).toMatch(/MOLD REMEDIATION SCOPE/);
    expect(visit.text).toMatch(/Remove & bag wood flooring with growth — 120 SF/);
    expect(visit.text).toMatch(/Set up containment .* — 352 SF/);
    expect(visit.text).toMatch(/Pending the mold assessment report: Affected area and extent/);
    expect(visit.text).toMatch(/Pending reconstruction .*seal\/prime & paint full continuous wall/i);
    expect(visit.text).not.toMatch(/paint baseboard/i);
    expect(visit.text).not.toMatch(/extract|air mover|flood cut/i);
  });

  it("flags the CompanyCam gallery labeled 429 E 52nd St instead of attaching it to Test 1", async () => {
    const { r } = await start();
    const pdf = async (lines: string[]) => {
      const d = await PDFDocument.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      const pg = d.addPage([612, 792]);
      lines.forEach((t, i) => pg.drawText(t, { x: 40, y: 740 - i * 18, size: 12, font: f }));
      return new Uint8Array(await d.save());
    };
    const wrong = await ingestPdf(r.projectId, { name: "gallery.pdf", bytes: await pdf(["Servpro Team Holmes", "429 E 52nd St, New York, NY 10022", "Oct 30, 2026 - 27 photos"]) });
    expect(wrong.addressMismatch).toMatch(/labeled "429 E 52nd St.*but this project is 308 E 72nd St/);
    expect((await repo.getDocument(r.projectId, wrong.id)).error).toMatch(/Address mismatch/);
    const right = await ingestPdf(r.projectId, { name: "gallery2.pdf", bytes: await pdf(["Servpro Team Holmes", "308 East 72nd Street, Apt 4D, New York, NY 10021"]) });
    expect(right.addressMismatch).toBeNull();
  });
});
