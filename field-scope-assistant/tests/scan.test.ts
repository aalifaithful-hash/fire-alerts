import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { DEFAULT_RULES } from "@/lib/defaults";
import { analyzeRoom, cutHeight, type RoomContext } from "@/lib/roomRules";
import { RoomScanData, type Exclusion } from "@/lib/scan";
import { buildSketch, toPng, toSvg } from "@/lib/sketch";

process.env.DATABASE_URL = "pglite://memory";
delete process.env.POSTGRES_URL;
delete process.env.APP_PASSCODE;
delete process.env.ANTHROPIC_API_KEY;
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-scan-"));

const kitchenInput = {
  source: { where: "in_room", fixture: "supply line under sink", wall: "E", positionFt: 5, surface: "floor", status: "repaired", hoursSinceLoss: 10, waterSource: "dishwasher" },
  loss: { type: "water", category: "2" },
  materials: {
    flooring: { type: "LVP", affected: true, affectedPct: 50, action: "replace", continuousRun: "A" },
    baseboard: { affected: true, walls: ["E", "S"], action: "remove" },
    walls: { material: "drywall", affectedWalls: ["E", "S"], wetHeightIn: 6, floodCut: "auto" },
    ceiling: { affected: false },
    insulation: true,
    cabinets: { affected: true, lf: 10, detach: true },
    fixtures: [],
  },
  contents: { present: true, affected: true, items: "dishes, small appliances", handling: "packout" },
  measurements: {
    lengthFt: 12,
    widthFt: 10,
    heightFt: 8,
    openings: [{ id: "d1", kind: "door", wall: "S", widthIn: 36, heightIn: 80, offsetFt: 2 }],
  },
  moisturePoints: [{ id: "mp1", label: "E wall base", surface: "wall", wall: "E", reading: "38", dryGoal: "12" }],
};
const kitchen = () => RoomScanData.parse(kitchenInput);
const ctx = (over: Partial<RoomContext> = {}): RoomContext => ({
  rules: DEFAULT_RULES,
  roomLabel: "Unit 5C — Kitchen",
  run: [],
  exclusions: [],
  locationId: "loc_k",
  reconstructionRequested: false,
  yearBuilt: null,
  ...over,
});
const line = (a: ReturnType<typeof analyzeRoom>, id: string) => a.lines.find((l) => l.id === id);

describe("room analysis: quantities with the math shown", () => {
  it("Cat 2 kitchen: extraction, flood cut, baseboard, insulation, antimicrobial, paint full wall", () => {
    const a = analyzeRoom(kitchen(), ctx());
    expect(line(a, "extract")).toMatchObject({ quantity: 60, unit: "SF" }); // 12×10 = 120 × 50%
    // 6" wet + 24" margin = 30" → 48" sheet stop; E 10 LF + S (12 − 3 door) 9 LF = 19 LF × 4 ft
    const fc = line(a, "floodcut")!;
    expect(fc.item).toContain('48"');
    expect(fc.quantity).toBe(76);
    expect(fc.calc).toContain('wet 6" + 24" margin = 30" → 48" (sheet stop)');
    expect(line(a, "insulation.remove")?.quantity).toBe(76);
    expect(line(a, "baseboard")).toMatchObject({ activity: "Remove", quantity: 19, unit: "LF" });
    // paint full continuous wall, every wall whose baseboard comes off: E, S (removed) + N, W (detached & reset
    // for the LVP replacement): N 96 + W 80 + E 80 + S (96 − door 20) 76 = 332 SF
    expect(line(a, "walls.paint")).toMatchObject({ quantity: 332, unit: "SF", kind: "reconstruction" });
    // antimicrobial: 60 SF floor + wet strip 19 LF × 0.5 ft = 9.5 → 69.5
    expect(line(a, "antimicrobial")?.quantity).toBe(69.5);
    expect(line(a, "equip.airmovers")).toMatchObject({ quantity: 1, kind: "equipment" });
    expect(line(a, "equip.airmovers")!.calc).toContain("60 SF wet floor ÷ 50–70 SF per air mover = 1–2");
    expect(line(a, "cabinets.detach")?.quantity).toBe(10);
    expect(line(a, "contents.packout")?.status).toBe("suggested");
    // every line starts suggested; nothing is auto-accepted
    expect(a.lines.every((l) => l.status === "suggested")).toBe(true);
    // demolition carries hazard flags when the year built is unknown
    expect(fc.flags.join(" ")).toMatch(/Year built unknown/);
    expect(fc.flags.join(" ")).toMatch(/Asbestos survey/);
    // reconstruction lines are pending unless a reconstruction estimate is requested
    expect(line(a, "drywall.replace")!.flags.join(" ")).toMatch(/Pending reconstruction/);
    expect(a.lines.every((l) => l.justification.length > 5)).toBe(true);
  });

  it("flood-cut conventions are the editable defaults", () => {
    expect(cutHeight(4, "1", DEFAULT_RULES)).toMatchObject({ cutIn: 24 }); // 4 + 12 (Cat 1 low wicking) = 16 → 24
    expect(cutHeight(20, "2", DEFAULT_RULES)).toMatchObject({ cutIn: 48 }); // 20 + 24 = 44 → 48
    expect(cutHeight(30, "3", DEFAULT_RULES)).toMatchObject({ cutIn: 96 }); // 54 → 96
    const custom = { ...DEFAULT_RULES, floodCut: { ...DEFAULT_RULES.floodCut, roundToSheetStops: false } };
    expect(cutHeight(6, "2", custom).cutIn).toBe(30);
  });

  it("Category 1 walls are dried in place unless the PM sets a flood cut; plaster is never auto-cut", () => {
    const s = kitchen();
    s.loss.category = "1";
    s.materials.baseboard.action = null;
    let a = analyzeRoom(s, ctx());
    expect(line(a, "floodcut")).toBeUndefined();
    expect(a.questions.join(" ")).toMatch(/dried in place by default/);
    expect(line(a, "baseboard")?.activity).toBe("Detach & reset");
    s.materials.walls.floodCut = 24;
    a = analyzeRoom(s, ctx());
    expect(line(a, "floodcut")?.item).toContain('24"');
    s.materials.walls.material = "plaster";
    s.loss.category = "3";
    s.materials.walls.floodCut = "auto";
    a = analyzeRoom(s, ctx());
    expect(line(a, "floodcut")).toBeUndefined();
    expect(a.questions.join(" ")).toMatch(/plaster walls/);
  });

  it("missing measurements leave quantities blank and ask for them", () => {
    const s = kitchen();
    s.measurements = { lengthFt: null, widthFt: null, heightFt: null, segments: null, openings: [] };
    const a = analyzeRoom(s, ctx());
    expect(line(a, "extract")!.quantity).toBeNull();
    expect(line(a, "extract")!.flags).toContain("Quantity needs measurements.");
    expect(a.questions[0]).toMatch(/measure length, width and ceiling height/);
  });

  it("category-change flag never changes the category itself", () => {
    const s = kitchen();
    s.loss.category = "1";
    s.source.waterSource = "toilet_overflow";
    s.source.hoursSinceLoss = 80;
    const a = analyzeRoom(s, ctx());
    expect(a.notes.join(" ")).toMatch(/normally at least Category 2/);
    expect(a.notes.join(" ")).toMatch(/80 h since loss/);
    expect(s.loss.category).toBe("1");
  });

  it("continuous flooring: an unaffected room in the same run is replaced to the natural break", () => {
    const hall = RoomScanData.parse({
      source: { where: "adjacent" },
      loss: { type: "water", category: "2" },
      materials: { flooring: { type: "LVP", affected: false, continuousRun: "A" } },
      measurements: { lengthFt: 15, widthFt: 4, heightFt: 8 },
    });
    const a = analyzeRoom(hall, ctx({ roomLabel: "Hallway", locationId: "loc_h", run: [{ roomLabel: "Hallway", floorSF: 60, replace: false }, { roomLabel: "Unit 5C — Kitchen", floorSF: 120, replace: true }] }));
    const r = line(a, "floor.replace")!;
    expect(r.quantity).toBe(60);
    expect(r.justification).toMatch(/Continuous with Unit 5C — Kitchen \(run A\)/);
    expect(r.calc).toMatch(/run A total 180 SF/);
  });

  it("contents declined by the customer: contents lines excluded (moving contents to reach the structure stays)", () => {
    const ex: Exclusion = { id: "e1", target: "contents_all", locationId: null, serviceLine: null, reason: "Customer will handle contents", decidedBy: "customer", date: "2026-11-03", signature: "not_documented", note: null, text: "" };
    const s = kitchen();
    let a = analyzeRoom(s, ctx({ exclusions: [ex] }));
    expect(line(a, "contents.packout")).toMatchObject({ status: "excluded" });
    expect(line(a, "contents.packout")!.flags.join(" ")).toMatch(/contents work declined — Customer will handle contents \(customer, 2026-11-03\)/);
    expect(line(a, "floodcut")!.status).toBe("suggested"); // structure untouched
    s.contents.handling = "manipulate";
    a = analyzeRoom(s, ctx({ exclusions: [ex] }));
    expect(line(a, "contents.manip")!.status).toBe("suggested");
  });

  it("room exclusion marks every line excluded, and pre-1978 adds a lead flag", () => {
    const ex: Exclusion = { id: "e2", target: "room", locationId: "loc_k", serviceLine: null, reason: "Owner's contractor", decidedBy: "owner", date: "2026-11-03", signature: "signed", note: null, text: "" };
    const a = analyzeRoom(kitchen(), ctx({ exclusions: [ex], yearBuilt: 1962 }));
    expect(a.lines.every((l) => l.status === "excluded")).toBe(true);
    expect(line(a, "floodcut")!.flags.join(" ")).toMatch(/Built 1962 \(before 1978\)/);
  });
});

describe("sketch", () => {
  it("draws measured rooms to scale, unmeasured rooms as 'not to scale', with source, flood cut, moisture points and legend", () => {
    const k = kitchen();
    const a = analyzeRoom(k, ctx());
    const fc = a.lines.find((l) => l.id === "floodcut")!;
    fc.status = "accepted";
    const unmeasured = RoomScanData.parse({ source: { where: "above" } });
    const model = buildSketch([
      { locationId: "loc_k", label: "Unit 5C — Kitchen", floor: "5", scan: k, lines: a.lines, excluded: false },
      { locationId: "loc_b", label: "Unit 5C — Bath", floor: "5", scan: unmeasured, lines: [], excluded: false },
      { locationId: "loc_x", label: "Unit 5C — Closet", floor: "5", scan: unmeasured, lines: [], excluded: true },
    ]);
    const svg = toSvg(model);
    expect(svg).toContain("Unit 5C — Kitchen — 12′ × 10′ × 8′h");
    expect(svg).toContain("not to scale (not measured)");
    expect(svg).toContain("FC 48″");
    expect(svg).toContain("Source: supply line under sink");
    expect(svg).toContain("Source: from above");
    expect(svg).toContain("EXCLUDED");
    expect(svg).toContain("Run A");
    expect(svg).toContain("Mitigation (affected / removal)");
    expect(svg).toContain("Reconstruction (replace / paint)");
    const png = toPng(model);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

// ---------------- service + routes on Postgres ----------------

const { resetLocalDbForTests } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const scans = await import("@/lib/scans");
const exportRoute = await import("@/app/api/projects/[pid]/visits/[vid]/export/route");

describe("room scan workflow end to end (no AI)", () => {
  beforeEach(() => resetLocalDbForTests());

  it("scan → proposed lines → accept → scope bullets, exclusions explicit, PDF/DOCX carry line items and sketch after the scope", async () => {
    const p = await repo.createProject({ address: "429 E 52nd St, Apt 5C" });
    const k = await repo.insertLocation(p.id, { floor: "5", unit: "5C", room: "Kitchen" });
    const v = await repo.createVisit(p.id, { type: "initial_mitigation", visitDate: "2026-11-03", stage: "initial_walkthrough", serviceLine: "mitigation" });

    const view = await scans.saveRoomScan(p.id, v.id, k.id, kitchenInput);
    const room = view.rooms[0];
    expect(room.data.lines.length).toBeGreaterThan(8);
    expect(view.summary.questions.some((q) => /year built/.test(q))).toBe(true);
    expect(view.sketchSvg).toContain("<svg");

    await scans.decideLines(p.id, v.id, k.id, ["extract", "floodcut", "baseboard", "antimicrobial", "contents.packout"], "accept");
    await scans.decideLines(p.id, v.id, k.id, ["equip.airmovers"], "reject");
    let visit = await repo.getVisit(p.id, v.id);
    expect(visit.text).toContain('Flood cut drywall at 48" (E, S) — 76 SF');
    expect(visit.text).toContain("Remove baseboard (E, S) — 19 LF");
    expect(visit.text).toContain("Pending reconstruction (separate assignment, not estimated)");
    expect(visit.text).not.toContain("air movers"); // rejected

    // customer declines contents: structure only, said explicitly
    await scans.setScanOptions(p.id, v.id, { exclusions: [{ target: "contents_all", reason: "Customer will handle contents", decidedBy: "customer" }] });
    visit = await repo.getVisit(p.id, v.id);
    expect(visit.text).not.toContain("Pack out");
    expect(visit.text).toMatch(/Contents cleaning and pack-out excluded at the customer's request/);
    expect(visit.text).toMatch(/structure only/);
    expect(visit.text).toMatch(/not documented — signature required/);
    const after = await scans.getVisitScans(p.id, v.id);
    expect(after.rooms[0].data.lines.find((l) => l.id === "contents.packout")!.status).toBe("excluded");
    expect(after.summary.qa.find((q) => /signed customer declination/.test(q.text))!.ok).toBe(false);

    // decisions survive re-analysis after a measurement change
    await scans.saveRoomScan(p.id, v.id, k.id, { ...kitchenInput, measurements: { ...kitchenInput.measurements, lengthFt: 14 } });
    const again = await scans.getVisitScans(p.id, v.id);
    expect(again.rooms[0].data.lines.find((l) => l.id === "floodcut")!.status).toBe("accepted");
    expect(again.rooms[0].data.lines.find((l) => l.id === "extract")!.quantity).toBe(70);

    // exports: scope, then line items, then sketch
    const call = async (format: string) => {
      const res = await (exportRoute.GET as (r: NextRequest, c: { params: Promise<{ pid: string; vid: string }> }) => Promise<Response>)(
        new NextRequest(`http://localhost/x?format=${format}`),
        { params: Promise.resolve({ pid: p.id, vid: v.id }) },
      );
      return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
    };
    const pdf = await call("pdf");
    expect(pdf.status).toBe(200);
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text } = await extractText(await getDocumentProxy(pdf.bytes), { mergePages: false });
    const pages = text as string[];
    const scopeIdx = pages.findIndex((t) => /initial mitigation scope/i.test(t));
    const linesIdx = pages.findIndex((t) => /ESTIMATOR LINE ITEMS/.test(t));
    const sketchIdx = pages.findIndex((t) => /SKETCH OF AFFECTED AREAS/.test(t));
    expect(scopeIdx).toBe(0);
    expect(linesIdx).toBeGreaterThan(scopeIdx);
    expect(sketchIdx).toBeGreaterThan(linesIdx);
    expect(pages[linesIdx]).toMatch(/Flood cut drywall at 48/);
    expect(pages[sketchIdx]).toMatch(/FC 48/);
    const docx = await call("docx");
    expect(docx.status).toBe(200);
    const zipText = Buffer.from(docx.bytes).toString("latin1");
    expect(zipText).toMatch(/media\/[^"]+\.svg/); // SVG sketch embedded (with PNG fallback)
  });
});
