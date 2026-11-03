import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import * as S from "./fixtures/fnol-samples";

process.env.DATABASE_URL = "pglite://memory";
delete process.env.POSTGRES_URL;
delete process.env.APP_PASSCODE;
delete process.env.ANTHROPIC_API_KEY;
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fsa-intake-"));

const { resetLocalDbForTests } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const intake = await import("@/lib/intake");
const parseRoute = await import("@/app/api/fnol/parse/route");
const assignmentsRoute = await import("@/app/api/assignments/route");
const openRoute = await import("@/app/api/assignments/[aid]/open/route");
const rulesSectionRoute = await import("@/app/api/rules/[section]/route");

type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;
async function call<P>(h: Handler<P>, method: string, params: P, body?: unknown) {
  const req = new NextRequest("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await h(req, { params: Promise.resolve(params) });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}

beforeEach(() => resetLocalDbForTests());

describe("paste-in FNOL inbox", () => {
  it("parse → review → save creates a property with an assignment; a later FNOL adds to the same property", async () => {
    const p1 = await call(parseRoute.POST as Handler<object>, "POST", {}, { text: S.FNOL_EMS });
    expect(p1.status).toBe(200);
    expect(p1.json!.input.serviceLines).toContain("ems");
    expect(p1.json!.matchedProperty).toBeNull();
    expect(p1.json!.deadlines.deadlines.map((d: { label: string }) => d.label)).toEqual(["Customer contact", "On site", "Estimate upload"]);

    // PM corrects one field during review, then saves
    const reviewed = { ...p1.json!.input, insured: "Jane Example (tenant)" };
    const s1 = await call(assignmentsRoute.POST as Handler<object>, "POST", {}, { rawText: S.FNOL_EMS, input: reviewed });
    expect(s1.status).toBe(200);
    expect(s1.json!.propertyCreated).toBe(true);
    expect(s1.json!.assignment.insured).toBe("Jane Example (tenant)");
    expect(s1.json!.assignment.history[0].kind).toBe("fnol");

    // the final walk-through FNOL writes the address differently but is the same unit
    const p2 = await call(parseRoute.POST as Handler<object>, "POST", {}, { text: S.FNOL_FINAL });
    expect(p2.json!.input.stage).toBe("final_walkthrough");
    expect(p2.json!.matchedProperty?.id).toBe(s1.json!.property.id);
    expect(p2.json!.propertyHistory).toHaveLength(1);
    const s2 = await call(assignmentsRoute.POST as Handler<object>, "POST", {}, { rawText: S.FNOL_FINAL, input: p2.json!.input });
    expect(s2.json!.propertyCreated).toBe(false);

    const all = await intake.listAssignments({ propertyId: s1.json!.property.id });
    expect(all.map((a) => a.stage).sort()).toEqual(["final_walkthrough", "initial_walkthrough"]);
    expect((await intake.relatedByClaim(all[0])).length).toBe(1); // same claim number links them
  });

  it("refuses to save without an address or service line (nothing guessed)", async () => {
    const p = await call(parseRoute.POST as Handler<object>, "POST", {}, { text: S.FNOL_AMBIGUOUS });
    const r = await call(assignmentsRoute.POST as Handler<object>, "POST", {}, { rawText: S.FNOL_AMBIGUOUS, input: p.json!.input });
    expect(r.status).toBe(400);
    expect(r.json!.error).toMatch(/service line/);
  });

  it("opening an assignment starts a visit with the stage, service line and matching output type", async () => {
    const p = await call(parseRoute.POST as Handler<object>, "POST", {}, { text: S.FNOL_CONTENTS_ONLY });
    const s = await call(assignmentsRoute.POST as Handler<object>, "POST", {}, { rawText: S.FNOL_CONTENTS_ONLY, input: p.json!.input });
    const o = await call(openRoute.POST as Handler<{ aid: string }>, "POST", { aid: s.json!.assignment.id }, {});
    expect(o.status).toBe(200);
    const v = await repo.getVisit(o.json!.projectId, o.json!.visitId);
    expect([v.type, v.stage, v.serviceLine]).toEqual(["contents_cleaning", "initial_walkthrough", "contents"]);
    expect([v.appointmentTime, v.arrivalTime, v.accessOutcome]).toEqual([null, null, null]);
    const proj = await repo.getProject(o.json!.projectId);
    expect(proj.claimNumber).toBe("CN-30017");
    expect((await intake.getAssignment(s.json!.assignment.id)).status).toBe("linked");
  });

  it("special assignment and multiple service lines survive the round trip", async () => {
    const p = await call(parseRoute.POST as Handler<object>, "POST", {}, { text: S.FNOL_SPECIAL });
    const s = await call(assignmentsRoute.POST as Handler<object>, "POST", {}, { rawText: S.FNOL_SPECIAL, input: p.json!.input });
    expect(s.json!.assignment.special).toBe(true);
    expect(s.json!.assignment.specialReason).toMatch(/board approval/);
    expect(s.json!.assignment.serviceLines).toEqual(["mitigation", "contents"]);
  });
});

describe("editable defaults (Rules page)", () => {
  it("a section override is validated, applied and resettable", async () => {
    const h = rulesSectionRoute.PUT as Handler<{ section: string }>;
    const bad = await call(h, "PUT", { section: "floodCut" }, { value: { marginAboveWetIn: "lots" } });
    expect(bad.status).toBe(400);
    const cur = (await intake.getRules()).floodCut;
    const ok = await call(h, "PUT", { section: "floodCut" }, { value: { ...cur, marginAboveWetIn: 12 } });
    expect(ok.status).toBe(200);
    expect((await intake.getRules()).floodCut.marginAboveWetIn).toBe(12);
    await call(rulesSectionRoute.DELETE as Handler<{ section: string }>, "DELETE", { section: "floodCut" });
    expect((await intake.getRules()).floodCut.marginAboveWetIn).toBe(24);
  });

  it("program deadlines start at FNOL receipt", async () => {
    const rules = await intake.getRules();
    const d = intake.deadlinesFor({ receivedAt: "2026-11-03T12:00:00.000Z", program: null }, rules);
    expect(d.deadlines.map((x) => x.due)).toEqual(["2026-11-03T13:00:00.000Z", "2026-11-03T16:00:00.000Z", "2026-11-04T12:00:00.000Z"]);
  });
});
