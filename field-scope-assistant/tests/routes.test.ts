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
