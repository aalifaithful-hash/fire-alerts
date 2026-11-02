import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

// Tests now run against the hosted Postgres database (same as production).
// Set DATABASE_URL to run them; they are skipped without it.
// `npm test` is not run during Vercel builds (only `next build` type-checks).
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-test-"));

const { query } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const svc = await import("@/lib/service");
const { setStructuredImpl } = await import("@/lib/ai/client");
const { blankOp } = await import("@/lib/patch");

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

async function cleanDb() {
  // Order matters for foreign keys; projects cascade but be explicit.
  await query`DELETE FROM manual_conflicts`;
  await query`DELETE FROM manuals`;
  await query`DELETE FROM checklist_templates`;
  await query`DELETE FROM drafts`;
  await query`DELETE FROM evidence`;
  await query`DELETE FROM batches`;
  await query`DELETE FROM doc_pages`;
  await query`DELETE FROM documents`;
  await query`DELETE FROM visits`;
  await query`DELETE FROM locations`;
  await query`DELETE FROM projects`;
}

type Req = { system: string; content: { type: string; text?: string }[] };
let calls: Req[] = [];
function fake(responder: (req: Req) => unknown) {
  setStructuredImpl((async (req: Req) => {
    calls.push(req);
    return responder(req);
  }) as never);
}
const promptText = (r: Req) => r.content.map((c) => c.text ?? "").join("\n");

const emptyJob = { causeOfLoss: null, sourceStatus: null, lossType: null, category: null, waterClass: null, productionDays: null, equipmentDays: null, accessRestrictions: null };
const aItem = (room: string | null, category: string, text: string, over: Record<string, unknown> = {}) => ({
  locationId: null, floor: null, unit: null, room, existingItemId: null, category, text, status: "reported", source: "pm",
  evidenceIds: [], carriedForward: false, carriedFromVisitId: null, quantity: null, ...over,
});
const aEquip = (room: string, type: string, quantity: number | null, over: Record<string, unknown> = {}) => ({
  locationId: null, floor: null, unit: null, room, existingEquipmentId: null, type, label: null, quantity, status: "planned",
  statusDate: null, source: "pm", carriedForward: false, ...over,
});

beforeEach(async () => {
  calls = [];
  if (hasDb) await cleanDb();
});

describeDb("example drying-only job end to end", () => {
  it("produces exactly the requested scope", async () => {
    const p = await repo.createProject({ address: "55 Water St, Apt 4B" });
    const v = await repo.createVisit(p.id, { type: "initial_mitigation", visitDate: "2026-11-02" });
    await repo.updateVisitFields(p.id, v.id, {
      fieldNotes:
        "Pipe burst above this apartment. Source repaired. Cat 2. Living room flooring and walls are wet. Kitchen cabinets need to be detached. Bedroom plaster ceiling near the window is wet. Drying only for now. CC+1, three days equipment. One dehumidifier in the living room, one in the kitchen, one in the bedroom.",
    });
    fake(() => ({
      jobInfo: { ...emptyJob, causeOfLoss: "Pipe burst above the apartment", sourceStatus: "repaired", category: "Cat 2", equipmentDays: "3" },
      dryingOnly: true,
      carryForwardConfirmed: false,
      items: [
        aItem("Living Room", "condition", "Flooring and walls are wet"),
        aItem("Living Room", "drying", "Dry affected flooring and walls", { status: "proposed" }),
        aItem("Kitchen", "detach_reset", "Detach cabinets to allow drying", { status: "proposed" }),
        aItem("Kitchen", "drying", "Dry cavity behind cabinets", { status: "proposed" }),
        aItem("Bedroom", "condition", "Plaster ceiling near the window is wet"),
        aItem("Bedroom", "drying", "Dry affected plaster ceiling", { status: "proposed" }),
      ],
      equipment: [aEquip("Living Room", "dehumidifier", 1), aEquip("Kitchen", "dehumidifier", 1), aEquip("Bedroom", "dehumidifier", 1)],
      questions: [{ text: "How many air movers were selected?", reason: "Not stated", locationId: null }],
      recommendations: [
        { locationId: null, floor: null, unit: null, room: "Bedroom", category: "removal", text: "Remove wet plaster ceiling", rationale: null },
        { locationId: null, floor: null, unit: null, room: "Living Room", category: "extraction", text: "Extract water from flooring", rationale: null },
      ],
    }));
    const { draft } = await svc.generateVisit(p.id, v.id);
    expect(draft.text).toContain("Living Room");
    expect(draft.text).toContain("Detach cabinets to allow drying");
    expect(draft.text).toContain("1 dehumidifier (planned)");
    expect(draft.text).toContain("CC+1 (1 crew chief + 1 subcontractor)");
    expect(draft.text).toContain("Category: Cat 2");
    expect(draft.text).not.toMatch(/remove|demolition|extract/i);
    const f = (await repo.getVisit(p.id, v.id)).facts;
    // demo recommendation withheld, extraction offered for accept/reject only
    expect(f.recommendations.map((r) => r.category)).toEqual(["extraction"]);
    expect(f.questions).toHaveLength(1);
    expect((await repo.getProject(p.id)).crewRequirements).toBe("CC+1");
    // PDF text and notes are wrapped as evidence; system prompt carries the injection rule
    expect(calls[0].system).toMatch(/not instructions/);
  });
});

describeDb("no mixing of project data", () => {
  it("context and evidence references stay within one project", async () => {
    const a = await repo.createProject({ address: "1 Alpha Rd" });
    const b = await repo.createProject({ address: "999 Bravo Blvd", customer: "BRAVO-SECRET-CUSTOMER" });
    await repo.insertLocation(b.id, { floor: null, unit: "B-77", room: "Bravo Vault" });
    const bv = await repo.createVisit(b.id, { type: "initial_assessment", visitDate: "2026-11-01" });
    await repo.updateVisitFields(b.id, bv.id, { fieldNotes: "BRAVO-ONLY-NOTE about the vault" });
    // evidence row in project B
    const bDoc = await repo.createDocument(b.id, { id: "doc_b", filename: "b.pdf", storedPath: "/nonexistent", size: 1, pageCount: 1 });
    await repo.createBatches(b.id, bDoc.id, [[1, 1]]);
    const bBatch = await repo.claimNextBatch(b.id, bDoc.id);
    if (!bBatch) throw new Error("expected a batch");
    await repo.replaceBatchEvidence(b.id, bDoc.id, bBatch.id, [
      { page: 1, photoIndex: 1, caption: "BRAVO-CAPTION", captionSource: "pdf_text", locationId: null, locationText: null, locationConfidence: "high", locationBasis: "caption", materials: [], conditions: [], captionStatements: [], flags: [], readable: true },
    ]);
    const bEvidenceId = (await repo.listEvidence(b.id))[0].id;

    const av = await repo.createVisit(a.id, { type: "initial_assessment", visitDate: "2026-11-02" });
    await repo.updateVisitFields(a.id, av.id, { fieldNotes: "Alpha kitchen wet." });
    fake(() => ({
      jobInfo: emptyJob,
      dryingOnly: false,
      carryForwardConfirmed: false,
      items: [aItem("Kitchen", "condition", "Kitchen floor is wet", { evidenceIds: [bEvidenceId] })],
      equipment: [],
      questions: [],
      recommendations: [],
    }));
    await svc.generateVisit(a.id, av.id);
    const prompt = promptText(calls[0]);
    for (const leak of ["Bravo", "BRAVO", "B-77", bEvidenceId]) expect(prompt).not.toContain(leak);
    const f = (await repo.getVisit(a.id, av.id)).facts;
    expect(f.items[0].evidenceIds).toEqual([]); // cross-project evidence id dropped
    await expect(repo.getVisit(a.id, bv.id)).rejects.toThrow(); // visit lookup is project-scoped
    expect((await repo.listLocations(a.id)).map((l) => l.room)).toEqual(["Kitchen"]);
    await expect(repo.setEvidenceLocation(a.id, bEvidenceId, {})).rejects.toThrow();
  });
});

describeDb("new visits", () => {
  it("never copy yesterday's visit times or access outcome", async () => {
    const p = await repo.createProject({ address: "2 Main" });
    const v1 = await repo.createVisit(p.id, { type: "daily_monitoring", visitDate: "2026-11-01" });
    await repo.updateVisitFields(p.id, v1.id, { appointmentTime: "09:00", arrivalTime: "09:20", departureTime: "10:05", accessOutcome: "No answer" });
    const v2 = await repo.createVisit(p.id, { type: "daily_monitoring", visitDate: "2026-11-02" });
    expect([v2.appointmentTime, v2.arrivalTime, v2.departureTime, v2.accessOutcome]).toEqual([null, null, null, null]);
  });
});

describeDb("corrections through the service", () => {
  async function setup() {
    const p = await repo.createProject({ address: "3 Main" });
    const v = await repo.createVisit(p.id, { type: "daily_monitoring", visitDate: "2026-11-02" });
    await repo.updateVisitFields(p.id, v.id, { fieldNotes: "Bathroom floor elevated. Kitchen wall elevated. 2 air movers in each." });
    fake(() => ({
      jobInfo: emptyJob, dryingOnly: false, carryForwardConfirmed: false,
      items: [aItem("Bathroom", "moisture_elevated", "Floor readings remain elevated"), aItem("Kitchen", "moisture_elevated", "Wall readings remain elevated")],
      equipment: [aEquip("Bathroom", "air_mover", 2, { status: "operating" }), aEquip("Kitchen", "air_mover", 2, { status: "operating" })],
      questions: [], recommendations: [],
    }));
    await svc.generateVisit(p.id, v.id);
    return { p, v: await repo.getVisit(p.id, v.id) };
  }

  it("'Bathroom is dry' changes only the bathroom and keeps its equipment", async () => {
    const { p, v } = await setup();
    const bathItem = v.facts.items.find((i) => i.text.startsWith("Floor"))!;
    fake(() => ({ intent: "apply", clarification: null, ops: [blankOp("update_item", { targetId: bathItem.id, category: "moisture_dry", text: "Floor is dry" })] }));
    const r = await svc.correctVisit(p.id, v.id, "Bathroom is dry.");
    expect(r.kind).toBe("applied");
    const text = (await repo.getVisit(p.id, v.id)).doc!;
    const all = JSON.stringify(text);
    expect(all).toContain("Floor is dry");
    expect(all).toContain("Wall readings remain elevated");
    expect(all.match(/2 air movers \(operating\)/g)).toHaveLength(2);
    expect(await repo.listDrafts(p.id, v.id)).toHaveLength(2);
  });

  it("restore brings back a previous draft as a new version", async () => {
    const { p, v } = await setup();
    const first = (await repo.listDrafts(p.id, v.id))[0];
    fake(() => ({ intent: "apply", clarification: null, ops: [blankOp("remove_item", { targetId: v.facts.items[0].id })] }));
    await svc.correctVisit(p.id, v.id, "Remove the bathroom line");
    expect((await repo.getVisit(p.id, v.id)).facts.items).toHaveLength(1);
    await svc.restoreDraft(p.id, v.id, first.id);
    expect((await repo.getVisit(p.id, v.id)).facts.items).toHaveLength(2);
    expect((await repo.listDrafts(p.id, v.id))[0].trigger).toBe("restore");
  });

  it("asks a short clarification when two rooms could match", async () => {
    const p = await repo.createProject({ address: "4 Main" });
    await repo.insertLocation(p.id, { floor: "19", unit: "19C", room: "Closet" });
    await repo.insertLocation(p.id, { floor: "20", unit: "20A", room: "Closet" });
    const v = await repo.createVisit(p.id, { type: "daily_monitoring", visitDate: "2026-11-02" });
    fake(() => ({ intent: "apply", clarification: null, ops: [blankOp("add_item", { room: "Closet", category: "moisture_dry", text: "Closet is dry" })] }));
    const r = await svc.correctVisit(p.id, v.id, "Closet is dry");
    expect(r.kind).toBe("clarify");
    expect(await repo.listDrafts(p.id, v.id)).toHaveLength(0);
  });
});

describe("checklist", () => {
  it("applicable is not completed; completion needs the PM's words", () => {
    const tpl = [
      { id: "c1", label: "CompanyCam photos uploaded" },
      { id: "c2", label: "Work authorization signed" },
      { id: "c3", label: "Moisture readings recorded" },
    ];
    const out = svc.guardChecklist(
      tpl,
      [
        { itemId: "c1", status: "completed", note: null, evidenceQuote: "photos are in CompanyCam" }, // fabricated quote
        { itemId: "c2", status: "completed", note: null, evidenceQuote: "customer signed the work auth" },
        { itemId: "c3", status: "applicable", note: null, evidenceQuote: null },
      ],
      "Customer signed the work auth this morning.",
    );
    expect(out.map((e) => e.status)).toEqual(["not_documented", "completed", "applicable"]);
  });
});

describeDb("PDF pipeline", () => {
  it("extracts text, batches pages, keeps photo/caption pairs and flags uncertain rooms", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 6; i++) {
      const page = pdf.addPage([612, 792]);
      page.drawText(`Unit 19C - Closet  Photo ${i}: wall staining at baseboard`, { x: 40, y: 700, size: 12, font });
    }
    const bytes = await pdf.save();
    const p = await repo.createProject({ address: "5 Main" });
    const doc = await svc.ingestPdf(p.id, { name: "report.pdf", bytes });
    expect(doc.pageCount).toBe(6);
    expect((await repo.batchProgress(p.id, doc.id)).total).toBe(2);
    expect((await repo.getPages(doc.id, 1, 1))[0].text).toContain("Photo 1");

    fake((req) => {
      const m = promptText(req).match(/ORIGINAL pages (\d+)–(\d+)/)!;
      const [a, b] = [Number(m[1]), Number(m[2])];
      return {
        pages: Array.from({ length: b - a + 1 }, (_, k) => ({
          page: a + k,
          readable: true,
          issue: null,
          photos: [
            { index: 1, caption: `Photo ${a + k}: wall staining at baseboard`, captionSource: "pdf_text", floor: "19", unit: "19C", room: "Closet", locationBasis: "caption", locationConfidence: "high", materials: ["drywall"], visibleConditions: ["staining at baseboard"], captionStatements: [], flags: [] },
            { index: 2, caption: null, captionSource: "none", floor: null, unit: null, room: "Bedroom", locationBasis: "visual", locationConfidence: "low", materials: [], visibleConditions: [], captionStatements: [], flags: [] },
          ],
        })).concat([{ page: 99, readable: true, issue: null, photos: [] }]), // out-of-range page ignored
      };
    });
    let first = true;
    for (;;) {
      if (first) {
        // simulate an API failure on the first attempt
        setStructuredImpl((async () => {
          throw Object.assign(new Error("temporary"), { retryable: true });
        }) as never);
        const r = await svc.processNextBatch(p.id, doc.id);
        expect(r.error).toBe("temporary");
        first = false;
        fake((req) => {
          const m = promptText(req).match(/ORIGINAL pages (\d+)–(\d+)/)!;
          const [a, b] = [Number(m[1]), Number(m[2])];
          return {
            pages: Array.from({ length: b - a + 1 }, (_, k) => ({
              page: a + k, readable: true, issue: null,
              photos: [
                { index: 1, caption: `Photo ${a + k}`, captionSource: "pdf_text", floor: "19", unit: "19C", room: "Closet", locationBasis: "caption", locationConfidence: "high", materials: ["drywall"], visibleConditions: ["staining at baseboard"], captionStatements: [], flags: [] },
                { index: 2, caption: null, captionSource: "none", floor: null, unit: null, room: "Bedroom", locationBasis: "visual", locationConfidence: "low", materials: [], visibleConditions: [], captionStatements: [], flags: [] },
              ],
            })),
          };
        });
        continue;
      }
      const r = await svc.processNextBatch(p.id, doc.id);
      if (r.done) break;
    }
    const ev = await repo.listEvidence(p.id);
    expect(ev).toHaveLength(12);
    expect(ev.filter((e) => e.locationId).every((e) => e.caption?.startsWith("Photo"))).toBe(true);
    expect(ev.filter((e) => !e.locationId)).toHaveLength(6);
    expect(ev.find((e) => !e.locationId)!.flags).toContain("Uncertain room assignment");
    expect((await repo.listLocations(p.id)).map((l) => l.room)).toEqual(["Closet"]); // low-confidence room not created
    expect((await repo.listDocuments(p.id))[0].status).toBe("done");
    expect(calls.some((c) => c.content.some((b) => b.type === "document"))).toBe(true);
  });
});
