import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

// Route-level tests: exercise the real Next.js route handlers on in-process Postgres.
process.env.DATABASE_URL = "pglite://memory";
delete process.env.POSTGRES_URL;
delete process.env.APP_PASSCODE;
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-routes-"));

const { resetLocalDbForTests } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const visitRoute = await import("@/app/api/projects/[pid]/visits/[vid]/route");
const visitsRoute = await import("@/app/api/projects/[pid]/visits/route");
const blobTokenRoute = await import("@/app/api/projects/[pid]/documents/blob/route");
const fromBlobRoute = await import("@/app/api/projects/[pid]/documents/from-blob/route");
const { checkUploadedBlob } = await import("@/lib/storage");

const draftRoute = await import("@/app/api/projects/[pid]/visits/[vid]/draft/route");
const itemsRoute = await import("@/app/api/projects/[pid]/visits/[vid]/items/route");
const textRoute = await import("@/app/api/projects/[pid]/visits/[vid]/text/route");
const exportRoute = await import("@/app/api/projects/[pid]/visits/[vid]/export/route");
const docsRoute = await import("@/app/api/projects/[pid]/documents/route");
const docTextRoute = await import("@/app/api/projects/[pid]/documents/[did]/text/route");
const processRoute = await import("@/app/api/projects/[pid]/documents/[did]/process/route");
const { PDFDocument, StandardFonts } = await import("pdf-lib");

type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;
async function call<P>(h: Handler<P>, method: string, params: P, body?: unknown, cookie?: string) {
  const req = new NextRequest("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await h(req, { params: Promise.resolve(params) });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeEach(() => {
  resetLocalDbForTests();
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.APP_PASSCODE;
});

describe("field notes persistence (issue 2)", () => {
  it("PATCH fieldNotes is stored and comes back on a fresh load", async () => {
    const p = await repo.createProject({ address: "10 Notes St" });
    const v = await repo.createVisit(p.id, { type: "daily_monitoring", visitDate: "2026-11-03" });
    const notes = "Kitchen wall still elevated. Bath subfloor dry. 2 air movers in kitchen.";

    const patched = await call(visitRoute.PATCH as Handler<{ pid: string; vid: string }>, "PATCH", { pid: p.id, vid: v.id }, { fieldNotes: notes });
    expect(patched.status).toBe(200);
    expect((patched.json!.visit as { fieldNotes: string }).fieldNotes).toBe(notes);

    // "reload": a brand-new GET, read straight from Postgres
    const reloaded = await call(visitRoute.GET as Handler<{ pid: string; vid: string }>, "GET", { pid: p.id, vid: v.id });
    expect(reloaded.status).toBe(200);
    expect((reloaded.json!.visit as { fieldNotes: string }).fieldNotes).toBe(notes);
    expect((await repo.getVisit(p.id, v.id)).fieldNotes).toBe(notes);
  });

  it("visit times and access outcome persist; empty strings clear them", async () => {
    const p = await repo.createProject({ address: "11 Notes St" });
    const v = await repo.createVisit(p.id, { type: "daily_monitoring", visitDate: "2026-11-03" });
    const h = visitRoute.PATCH as Handler<{ pid: string; vid: string }>;
    await call(h, "PATCH", { pid: p.id, vid: v.id }, { appointmentTime: "09:00", arrivalTime: "09:20", accessOutcome: "No answer" });
    let got = await repo.getVisit(p.id, v.id);
    expect([got.appointmentTime, got.arrivalTime, got.departureTime, got.accessOutcome]).toEqual(["09:00", "09:20", null, "No answer"]);
    await call(h, "PATCH", { pid: p.id, vid: v.id }, { accessOutcome: "" });
    got = await repo.getVisit(p.id, v.id);
    expect(got.accessOutcome).toBeNull();
    expect(got.appointmentTime).toBe("09:00"); // untouched fields stay
  });

  it("VISIT_EDITABLE is a field map (the array version made every PATCH a no-op)", () => {
    expect(Object.keys(repo.VISIT_EDITABLE)).toContain("fieldNotes");
    expect(Array.isArray(repo.VISIT_EDITABLE)).toBe(false);
  });

  it("new visit via the API starts with blank times and lists oldest → newest", async () => {
    const p = await repo.createProject({ address: "12 Notes St" });
    const h = visitsRoute.POST as Handler<{ pid: string }>;
    const a = await call(h, "POST", { pid: p.id }, { type: "daily_monitoring", visitDate: "2026-11-01", appointmentTime: "08:00" });
    const b = await call(h, "POST", { pid: p.id }, { type: "daily_monitoring", visitDate: "2026-11-02" });
    expect((a.json!.visit as { appointmentTime: string }).appointmentTime).toBe("08:00");
    expect((b.json!.visit as { appointmentTime: string | null }).appointmentTime).toBeNull();
    expect((await repo.listVisits(p.id)).map((v) => v.visitDate)).toEqual(["2026-11-01", "2026-11-02"]);
  });

  it("requires the passcode when APP_PASSCODE is set", async () => {
    process.env.APP_PASSCODE = "pass123";
    const p = await repo.createProject({ address: "13 Notes St" });
    const v = await repo.createVisit(p.id, { type: "daily_monitoring", visitDate: "2026-11-03" });
    const r = await call(visitRoute.PATCH as Handler<{ pid: string; vid: string }>, "PATCH", { pid: p.id, vid: v.id }, { fieldNotes: "x" });
    expect(r.status).toBe(401);
    expect((await repo.getVisit(p.id, v.id)).fieldNotes).toBe("");
  });
});

describe("direct Blob upload routes (issue 3)", () => {
  const TOKEN = "vercel_blob_rw_teststore123_" + "s".repeat(24);

  it("issues a client token only for PDFs inside the project's own folder", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = TOKEN;
    const p = await repo.createProject({ address: "20 Blob St" });
    const other = await repo.createProject({ address: "21 Other St" });
    const h = blobTokenRoute.POST as Handler<{ pid: string }>;
    const ask = (pathname: string) =>
      call(h, "POST", { pid: p.id }, { type: "blob.generate-client-token", payload: { pathname, multipart: true, clientPayload: null } });

    const ok = await ask(`projects/${p.id}/report.pdf`);
    expect(ok.status).toBe(200);
    expect(String(ok.json!.clientToken)).toMatch(/^vercel_blob_client_/);

    expect((await ask(`projects/${other.id}/report.pdf`)).status).toBe(400); // another project's folder
    expect((await ask(`projects/${p.id}/../x.pdf`)).status).toBe(400);
    expect((await ask(`projects/${p.id}/notes.txt`)).status).toBe(400);
  });

  it("returns a clear error when Blob is not configured", async () => {
    const p = await repo.createProject({ address: "22 Blob St" });
    const r = await call(blobTokenRoute.POST as Handler<{ pid: string }>, "POST", { pid: p.id }, {
      type: "blob.generate-client-token",
      payload: { pathname: `projects/${p.id}/a.pdf`, multipart: false, clientPayload: null },
    });
    expect(r.status).toBe(400);
    expect(String(r.json!.error)).toMatch(/BLOB_READ_WRITE_TOKEN/);
  });

  it("from-blob refuses blobs outside the project or with a mismatched URL", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = TOKEN;
    const p = await repo.createProject({ address: "23 Blob St" });
    const h = fromBlobRoute.POST as Handler<{ pid: string }>;
    const host = "https://teststore123.private.blob.vercel-storage.com";
    const bad1 = await call(h, "POST", { pid: p.id }, { pathname: "projects/prj_other/a.pdf", url: `${host}/projects/prj_other/a.pdf` });
    const bad2 = await call(h, "POST", { pid: p.id }, { pathname: `projects/${p.id}/a.pdf`, url: `${host}/projects/prj_other/a.pdf` });
    expect(bad1.status).toBe(400);
    expect(bad2.status).toBe(400);
    expect(await repo.listDocuments(p.id)).toHaveLength(0);
    expect(checkUploadedBlob({ pathname: `projects/${p.id}/a-x1.pdf`, url: `${host}/projects/${p.id}/a-x1.pdf` }, `projects/${p.id}/`)).toBe(
      `${host}/projects/${p.id}/a-x1.pdf`,
    );
  });
});

describe("no AI key: what must still work", () => {

  it("a PM can start, write and export a scope by hand", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const p = await repo.createProject({ address: "30 Manual Ave" });
    const kitchen = await repo.insertLocation(p.id, { floor: "3", unit: "3B", room: "Kitchen" });
    const v = await repo.createVisit(p.id, { type: "contents_cleaning", visitDate: "2026-11-03" });
    const ids = { pid: p.id, vid: v.id };

    const started = await call(draftRoute.POST as Handler<typeof ids>, "POST", ids);
    expect(started.status).toBe(200);
    expect((await repo.getVisit(p.id, v.id)).doc?.title).toBe("Contents Cleaning Scope");

    const added = await call(itemsRoute.POST as Handler<typeof ids>, "POST", ids, {
      locationId: kitchen.id,
      category: "contents",
      text: "Pack out and clean kitchen contents",
      status: "proposed",
    });
    expect(added.status).toBe(200);
    const after = await repo.getVisit(p.id, v.id);
    expect(after.text).toContain("Unit 3B — Kitchen");
    expect(after.text).toContain("Pack out and clean kitchen contents.");
    expect((await repo.listVisits(p.id))[0].doc).not.toBeNull(); // History no longer says "no draft"

    const free = "CONTENTS CLEANING SCOPE\nUnit 3B — Kitchen\n• Pack out contents\n• Clean cabinets";
    expect((await call(textRoute.PUT as Handler<typeof ids>, "PUT", ids, { text: free })).status).toBe(200);
    expect((await repo.getVisit(p.id, v.id)).manualText).toBe(free);
    expect((await repo.listDrafts(p.id, v.id)).length).toBe(3);

    const req = new NextRequest(`http://localhost/x?format=docx`);
    const res = await (exportRoute.GET as Handler<typeof ids>)(req, { params: Promise.resolve(ids) });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it("PDF text is extracted at upload; AI photo analysis waits without failing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i++) pdf.addPage([612, 792]).drawText(`Bedroom 1 - Photo ${i}: water staining on ceiling`, { x: 40, y: 700, size: 12, font });
    const form = new FormData();
    form.append("file", new File([Buffer.from(await pdf.save())], "429_E_52nd_St_Bedroom_1.pdf", { type: "application/pdf" }));
    const p = await repo.createProject({ address: "429 E 52nd St" });
    const up = await (docsRoute.POST as Handler<{ pid: string }>)(new NextRequest("http://localhost/x", { method: "POST", body: form }), {
      params: Promise.resolve({ pid: p.id }),
    });
    expect(up.status).toBe(200);
    const [doc] = await repo.listDocuments(p.id);
    expect([doc.pageCount, doc.extractedPages, doc.textPages, doc.progress.total]).toEqual([4, 4, 4, 1]);

    const text = await call(docTextRoute.GET as Handler<{ pid: string; did: string }>, "GET", { pid: p.id, did: doc.id });
    expect((text.json!.pages as { text: string }[])[2].text).toContain("Photo 3: water staining");

    const proc = await call(processRoute.POST as Handler<{ pid: string; did: string }>, "POST", { pid: p.id, did: doc.id }, {});
    expect(proc.status).toBe(503);
    expect(proc.json!.code).toBe("NO_API_KEY");
    const [again] = await repo.listDocuments(p.id);
    expect(again.progress).toMatchObject({ pending: 1, failed: 0, done: 0 }); // stays queued for when the key is added
  });
});

describe("JSON payloads contain data, not unresolved promises", () => {
  it("GET /api/templates returns an array (Settings page crashed on {})", async () => {
    const templatesRoute = await import("@/app/api/templates/route");
    const r = await call(templatesRoute.GET as Handler<Record<string, never>>, "GET", {} as Record<string, never>);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json!.templates)).toBe(true);
    expect((r.json!.templates as unknown[]).length).toBeGreaterThan(0);
  });
});
