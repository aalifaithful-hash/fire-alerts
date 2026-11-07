import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatTime12, parseTimeInput } from "@/lib/time";

// Fixes from the live Test 1 run.
process.env.DATABASE_URL = "pglite://memory";
delete process.env.POSTGRES_URL;
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-live-"));
const { resetLocalDbForTests } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const scans = await import("@/lib/scans");
const { workspacePayload } = await import("@/lib/payload");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const { putFile, projectKey } = await import("@/lib/storage");
const { query } = await import("@/lib/db");

beforeEach(() => resetLocalDbForTests());

describe("fast time entry (replaces the native segmented picker)", () => {
  it.each([
    ["11", "11:00"],
    ["11a", "11:00"],
    ["11 am", "11:00"],
    ["11:00 AM", "11:00"],
    ["1100", "11:00"],
    ["930", "09:30"],
    ["2:30p", "14:30"],
    ["3", "15:00"], // field hours: 1–6 without am/pm → PM
    ["7", "07:00"],
    ["12", "12:00"],
    ["12am", "00:00"],
    ["15:45", "15:45"],
    ["06:00", "06:00"], // leading zero = 24h as written
    ["noon", "12:00"],
  ])("%s → %s", (input, out) => expect(parseTimeInput(input)).toBe(out));
  it.each(["", "25", "11:75", "13pm", "abc"])("rejects %j", (input) => expect(parseTimeInput(input)).toBeNull());
  it("shows 12-hour time", () => {
    expect(formatTime12("11:00")).toBe("11:00 AM");
    expect(formatTime12("13:05")).toBe("1:05 PM");
    expect(formatTime12("00:15")).toBe("12:15 AM");
  });
});

describe("mold room proposes mold lines without the water gate; equipment is loss-type aware", () => {
  it("a Mold visit room with loss type unset and source unknown still gets the mold lines", async () => {
    const p = await repo.createProject({ name: "308 E 72nd St", address: "308 E 72nd St, Unit 4D" });
    const v = await repo.createVisit(p.id, { type: "mold_remediation", visitDate: "2026-11-04", stage: "initial_walkthrough", serviceLine: "mold" });
    const loc = await repo.insertLocation(p.id, { unit: "4D", room: "Bedroom" });
    const view = await scans.saveRoomScan(p.id, v.id, loc.id, {
      // exactly what the live run had: no loss type chosen, source "unknown", flooring measured 8 × 6 = 48 SF
      materials: { flooring: { type: "wood", affected: true } },
      measurements: { lengthFt: 8, widthFt: 6, heightFt: 8, openings: [] },
    });
    const room = view.rooms[0];
    const ids = room.data.lines.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(["mold.containment", "mold.negair", "mold.floor.remove", "mold.subfloor.clean", "mold.finalclean"]));
    expect(room.analysis.questions.join(" ")).not.toMatch(/is the source stopped or repaired/);
    expect(room.analysis.notes.join(" ")).toMatch(/Loss type taken from the visit/);
    // equipment hint: HEPA air scrubber / negative air, not a water-drying dehumidifier
    expect(view.summary.dehumidifiers).toBeNull();
    expect(view.summary.scrubbers).toBe(1);
    expect(ids).not.toContain("mold.dehu");
    expect(ids).not.toContain("equip.airmovers");
  });

  it("a water room still gets the dehumidifier calculation", async () => {
    const p = await repo.createProject({ name: "x", address: "1 Test Pl" });
    const v = await repo.createVisit(p.id, { type: "initial_mitigation", visitDate: "2026-11-04", stage: "initial_walkthrough", serviceLine: "mitigation" });
    const loc = await repo.insertLocation(p.id, { room: "Kitchen" });
    const view = await scans.saveRoomScan(p.id, v.id, loc.id, { loss: { type: "water", category: "1" }, materials: { flooring: { type: "tile", affected: true } }, measurements: { lengthFt: 8, widthFt: 6, heightFt: 8, openings: [] } });
    expect(view.summary.dehumidifiers?.min).toBe(1);
  });
});

describe("gallery stored before the address check is flagged when the project opens", () => {
  it("429 E 52nd St gallery on the 308 E 72nd St project", async () => {
    const p = await repo.createProject({ name: "308 E 72nd St", address: "308 E 72nd St, New York, NY 10021, Unit 4D" });
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([612, 792]).drawText("Servpro Team Holmes  429 E 52nd St, New York, NY 10022", { x: 40, y: 740, size: 12, font: f });
    const bytes = new Uint8Array(await d.save());
    // simulate the old upload path: stored with no warning
    const doc = await repo.createDocument(p.id, { id: "doc_old", filename: "gallery.pdf", storedPath: await putFile(projectKey(p.id, "doc_old.pdf"), bytes, "application/pdf"), size: bytes.length, pageCount: 1 });
    await repo.savePages(doc.id, [{ page: 1, text: "Servpro Team Holmes\n429 E 52nd St, New York, NY 10022" }]);
    await query`UPDATE documents SET status = 'processing', error = NULL WHERE id = ${doc.id}`;
    const ws = await workspacePayload(p.id);
    expect(ws.documents[0].error).toMatch(/Address mismatch: this PDF is labeled "429 E 52nd St/);
    expect((await repo.getDocument(p.id, doc.id)).error).toMatch(/Address mismatch/); // persisted
  });
});
