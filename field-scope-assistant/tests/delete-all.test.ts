import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

/**
 * "Delete All Projects". Runs ONLY on an in-process test database (pglite://memory) and a temp
 * file folder — never on the live Neon data. The guard below fails the run if that isn't so.
 */
process.env.DATABASE_URL = "pglite://memory";
delete process.env.POSTGRES_URL;
delete process.env.APP_PASSCODE;
delete process.env.BLOB_READ_WRITE_TOKEN;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-delall-"));
process.env.DATA_DIR = DATA_DIR;

const { resetLocalDbForTests, query } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const { ingestPdf, commit } = await import("@/lib/service");
const { emptyFacts } = await import("@/lib/schemas");
const listRoute = await import("@/app/api/projects/route");
const oneRoute = await import("@/app/api/projects/[pid]/route");
const delAllRoute = await import("@/app/api/projects/delete-all/route");
const { PDFDocument } = await import("pdf-lib");
const intake = await import("@/lib/intake");
const { quickStart } = await import("@/lib/quickstart");

type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;
async function call<P>(h: Handler<P>, method: string, params: P, body?: unknown) {
  const req = new NextRequest("http://localhost/api/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await h(req, { params: Promise.resolve(params) });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}
const count = async (table: string) => Number((await query<{ n: string }>([`SELECT COUNT(*) AS n FROM ${table}`] as unknown as TemplateStringsArray))[0].n);
const UP = path.join(DATA_DIR, "uploads", "projects");
/** How many of these projects still have a stored-file folder (earlier tests share the temp folder). */
const files = (ids: string[]) => (existsSync(UP) ? readdirSync(UP).filter((d) => ids.includes(d)).length : 0);

/** Three TEST projects, each with a visit, a draft version and an uploaded PDF. */
async function seed() {
  const ids: string[] = [];
  for (const a of ["1 Test Delete St", "2 Test Delete St", "3 Test Delete St"]) {
    const p = await repo.createProject({ address: a, name: a, customer: "Test Customer" });
    const v = await repo.createVisit(p.id, { type: "initial_mitigation", visitDate: "2026-11-06" });
    await commit(p.id, v.id, emptyFacts(), { trigger: "manual_edit", input: null, changes: ["test draft"] }, "Test scope text");
    const d = await PDFDocument.create();
    d.addPage([200, 200]);
    await ingestPdf(p.id, { name: "test.pdf", bytes: new Uint8Array(await d.save()) });
    ids.push(p.id);
  }
  return ids;
}

beforeEach(() => resetLocalDbForTests());

describe("Delete All Projects (test DB only)", () => {
  it("runs on the in-memory test database, never the live one", () => {
    expect(process.env.DATABASE_URL).toBe("pglite://memory");
    expect(process.env.POSTGRES_URL).toBeUndefined();
  });

  it("loading the list deletes nothing; the request without the confirmation deletes nothing", async () => {
    const ids = await seed();
    const list = await call(listRoute.GET as Handler<object>, "GET", {});
    expect(list.json!.projects).toHaveLength(3);
    // no GET handler on the delete-all route at all
    expect((delAllRoute as Record<string, unknown>).GET).toBeUndefined();
    for (const body of [{}, { ids }, { confirm: "yes", ids }, { confirm: "DELETE ALL PROJECTS" }]) {
      const r = await call(delAllRoute.POST as Handler<object>, "POST", {}, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json!.error).toMatch(/nothing was deleted/);
    }
    expect(await repo.listProjects()).toHaveLength(3);
    expect(await count("visits")).toBe(3);
    expect(await count("drafts")).toBeGreaterThanOrEqual(3);
  });

  it("a stale list (a project added or removed after the panel opened) deletes nothing", async () => {
    const ids = await seed();
    await repo.createProject({ address: "4 Added Later St" });
    const r1 = await call(delAllRoute.POST as Handler<object>, "POST", {}, { confirm: "DELETE ALL PROJECTS", ids });
    expect(r1.status).toBe(400);
    expect(r1.json!.error).toMatch(/The project list changed \(4 now, 3 shown\) — nothing was deleted/);
    const r2 = await call(delAllRoute.POST as Handler<object>, "POST", {}, { confirm: "DELETE ALL PROJECTS", ids: [...ids, "prj_unknown"] });
    expect(r2.status).toBe(400);
    expect(await repo.listProjects()).toHaveLength(4);
  });

  it("confirmed: every project goes, with its visits, drafts, documents, batches and stored files", async () => {
    const ids = await seed();
    expect(files(ids)).toBe(3);
    expect(await count("documents")).toBe(3);
    const r = await call(delAllRoute.POST as Handler<object>, "POST", {}, { confirm: "DELETE ALL PROJECTS", ids });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ deleted: 3, unlinkedAssignments: 0 });
    expect(await repo.listProjects()).toEqual([]);
    for (const t of ["projects", "visits", "drafts", "documents", "batches", "locations", "evidence", "room_scans"]) expect(await count(t), t).toBe(0);
    expect(files(ids)).toBe(0);
    // the list is empty afterwards
    expect((await call(listRoute.GET as Handler<object>, "GET", {})).json!.projects).toEqual([]);
  });

  it("FNOL assignments linked to deleted projects go back to 'new' (unlinked); none are deleted", async () => {
    // two TEST jobs opened from the inbox flow (assignment linked to a project) + one assignment left in the inbox
    const a = await quickStart({ address: "10 Test Unlink St", unit: "1A", customer: "Test One", job: "mold", notes: "test" });
    const b = await quickStart({ address: "20 Test Unlink St", customer: "Test Two", job: "water", notes: "test" });
    const inboxOnly = await intake.createAssignmentFromFnol("TEST FNOL", {
      serviceLines: ["mitigation"], contentsOnly: false, stage: "initial_walkthrough", special: false, specialReason: null, program: null,
      claimNumber: "TEST-1", assignmentNumber: null, policyNumber: null, carrier: null, insured: "Test Three", contactPhone: null, email: null,
      address: "30 Test Unlink St", unit: null, lossDate: null, lossType: null, causeOfLoss: null, receivedAt: null,
    });
    const before = await intake.listAssignments();
    expect(before).toHaveLength(3);
    expect(before.filter((x) => x.status === "linked").map((x) => x.projectId).sort()).toEqual([a.projectId, b.projectId].sort());

    const ids = (await repo.listProjects()).map((p) => p.id);
    const r = await call(delAllRoute.POST as Handler<object>, "POST", {}, { confirm: "DELETE ALL PROJECTS", ids });
    expect(r.json).toEqual({ deleted: 2, unlinkedAssignments: 2 });
    expect(await repo.listProjects()).toEqual([]);

    const after = await intake.listAssignments();
    expect(after).toHaveLength(3); // nothing deleted
    for (const x of after) expect([x.status, x.projectId], x.id).toEqual(["new", null]);
    const linkedBefore = before.filter((x) => x.status === "linked");
    for (const lb of linkedBefore) {
      const x = after.find((y) => y.id === lb.id)!;
      expect(x.history.at(-1)).toMatchObject({ kind: "status", text: "Project deleted (Delete All Projects) — unlinked; status → new" });
      expect([x.insured, x.serviceLines, x.claimNumber]).toEqual([lb.insured, lb.serviceLines, lb.claimNumber]); // FNOL data kept
    }
    // the inbox-only assignment was not touched
    const untouched = after.find((y) => y.id === inboxOnly.assignment.id)!;
    expect(untouched.history).toEqual(inboxOnly.assignment.history);
    // a reset assignment can be linked to a new project again
    const reopened = await intake.openProjectForAssignment(linkedBefore[0].id);
    expect((await intake.getAssignment(linkedBefore[0].id))).toMatchObject({ status: "linked", projectId: reopened.projectId });
  });

  it("the per-project delete is unchanged", async () => {
    const [a, b] = await seed();
    const r = await call(oneRoute.DELETE as Handler<{ pid: string }>, "DELETE", { pid: a });
    expect(r.json).toEqual({ ok: true });
    expect((await repo.listProjects()).map((p) => p.id).sort()).toEqual([b, (await repo.listProjects()).find((p) => p.id !== b)!.id].sort());
    expect(await repo.listProjects()).toHaveLength(2);
  });
});
