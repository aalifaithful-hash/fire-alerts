import { rmSync } from "node:fs";
import path from "node:path";
import { getDb, UPLOAD_DIR } from "./db";
import { newId } from "./ids";
import { nowIso } from "./time";
import { emptyFacts, VisitFacts, type Location, type ScopeDoc, type VisitType } from "./schemas";
import { PROJECT_TEXT_FIELDS, type DraftVersion, type Project, type Visit } from "./types";

/**
 * Data access. Every read/write that touches project data takes the projectId and
 * filters on it, so one property's information can never leak into another's.
 */

export class NotFound extends Error {}

const j = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ---------------- projects ----------------

type ProjectRow = { id: string; data: string; is_demo: number; created_at: string; updated_at: string };
function toProject(r: ProjectRow): Project {
  const d = j<Record<string, string | null>>(r.data, {});
  const p: Record<string, unknown> = { id: r.id, isDemo: !!r.is_demo, createdAt: r.created_at, updatedAt: r.updated_at };
  for (const f of PROJECT_TEXT_FIELDS) p[f] = d[f] ?? null;
  p.name = (d.name as string) || (d.address as string) || "Untitled project";
  p.address = (d.address as string) || "";
  return p as unknown as Project;
}

export function cleanProjectInput(input: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of PROJECT_TEXT_FIELDS) {
    if (!(f in input)) continue;
    const v = input[f];
    out[f] = v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, 2000);
  }
  return out;
}

export function listProjects(q?: string): (Project & { visitCount: number; lastVisit: string | null })[] {
  const rows = getDb()
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM visits v WHERE v.project_id = p.id) AS visit_count,
              (SELECT MAX(visit_date) FROM visits v WHERE v.project_id = p.id) AS last_visit
       FROM projects p ORDER BY p.updated_at DESC`,
    )
    .all() as (ProjectRow & { visit_count: number; last_visit: string | null })[];
  const needle = q?.trim().toLowerCase();
  return rows
    .filter((r) => !needle || r.data.toLowerCase().includes(needle))
    .map((r) => ({ ...toProject(r), visitCount: r.visit_count, lastVisit: r.last_visit }));
}

export function getProject(id: string): Project {
  const r = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!r) throw new NotFound("Project not found");
  return toProject(r);
}

export function createProject(input: Record<string, unknown>, isDemo = false): Project {
  const id = newId("prj");
  const now = nowIso();
  getDb()
    .prepare("INSERT INTO projects (id, data, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, JSON.stringify(cleanProjectInput(input)), isDemo ? 1 : 0, now, now);
  return getProject(id);
}

export function updateProject(id: string, patch: Record<string, unknown>): Project {
  const p = getProject(id);
  const current: Record<string, unknown> = {};
  for (const f of PROJECT_TEXT_FIELDS) current[f] = (p as unknown as Record<string, unknown>)[f];
  const next = { ...current, ...cleanProjectInput(patch) };
  getDb().prepare("UPDATE projects SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), nowIso(), id);
  return getProject(id);
}

export function touchProject(id: string) {
  getDb().prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(nowIso(), id);
}

/** Deletes the project, every row that belongs to it, and its uploaded files. */
export function deleteProject(id: string) {
  getProject(id);
  getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
  getDb().prepare("DELETE FROM drafts WHERE project_id = ?").run(id);
  getDb().prepare("DELETE FROM batches WHERE project_id = ?").run(id);
  rmSync(path.join(UPLOAD_DIR, id), { recursive: true, force: true });
}

// ---------------- locations ----------------

type LocRow = { id: string; project_id: string; floor: string | null; unit: string | null; room: string; sort: number };
const toLoc = (r: LocRow): Location => ({ id: r.id, projectId: r.project_id, floor: r.floor, unit: r.unit, room: r.room, sort: r.sort });

export function listLocations(projectId: string): Location[] {
  return (getDb().prepare("SELECT * FROM locations WHERE project_id = ? ORDER BY sort").all(projectId) as LocRow[]).map(toLoc);
}

export function insertLocation(projectId: string, l: { id?: string; floor: string | null; unit: string | null; room: string }): Location {
  const id = l.id ?? newId("loc");
  const sort = (getDb().prepare("SELECT COUNT(*) AS n FROM locations WHERE project_id = ?").get(projectId) as { n: number }).n;
  getDb()
    .prepare("INSERT INTO locations (id, project_id, floor, unit, room, sort) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, projectId, l.floor || null, l.unit || null, l.room.trim(), sort);
  return toLoc(getDb().prepare("SELECT * FROM locations WHERE id = ?").get(id) as LocRow);
}

export function updateLocation(projectId: string, id: string, l: { floor: string | null; unit: string | null; room: string }) {
  const r = getDb()
    .prepare("UPDATE locations SET floor = ?, unit = ?, room = ? WHERE id = ? AND project_id = ?")
    .run(l.floor || null, l.unit || null, l.room.trim(), id, projectId);
  if (!r.changes) throw new NotFound("Room not found");
}

/** Removing a room never deletes its findings: they move to "Location to confirm". */
export function deleteLocation(projectId: string, id: string) {
  const d = getDb();
  const tx = d.transaction(() => {
    const r = d.prepare("DELETE FROM locations WHERE id = ? AND project_id = ?").run(id, projectId);
    if (!r.changes) throw new NotFound("Room not found");
    for (const v of listVisits(projectId)) {
      let changed = false;
      for (const i of v.facts.items)
        if (i.locationId === id) {
          i.locationId = null;
          i.needsLocation = true;
          changed = true;
        }
      for (const e of v.facts.equipment)
        if (e.locationId === id) {
          e.locationId = null;
          changed = true;
        }
      if (changed) d.prepare("UPDATE visits SET facts = ? WHERE id = ?").run(JSON.stringify(v.facts), v.id);
    }
  });
  tx();
}

// ---------------- documents & batches ----------------

export interface DocumentRec {
  id: string;
  projectId: string;
  filename: string;
  storedPath: string;
  size: number;
  pageCount: number;
  status: string;
  error: string | null;
  createdAt: string;
}
type DocRow = { id: string; project_id: string; filename: string; stored_path: string; size: number; page_count: number; status: string; error: string | null; created_at: string };
const toDoc = (r: DocRow): DocumentRec => ({
  id: r.id,
  projectId: r.project_id,
  filename: r.filename,
  storedPath: r.stored_path,
  size: r.size,
  pageCount: r.page_count,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
});

export function createDocument(projectId: string, d: { id: string; filename: string; storedPath: string; size: number; pageCount: number }) {
  getDb()
    .prepare("INSERT INTO documents (id, project_id, filename, stored_path, size, page_count, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?)")
    .run(d.id, projectId, d.filename, d.storedPath, d.size, d.pageCount, nowIso());
  return getDocument(projectId, d.id);
}

export function getDocument(projectId: string, id: string): DocumentRec {
  const r = getDb().prepare("SELECT * FROM documents WHERE id = ? AND project_id = ?").get(id, projectId) as DocRow | undefined;
  if (!r) throw new NotFound("Document not found");
  return toDoc(r);
}

export function listDocuments(projectId: string) {
  const docs = (getDb().prepare("SELECT * FROM documents WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as DocRow[]).map(toDoc);
  return docs.map((d) => ({ ...d, progress: batchProgress(projectId, d.id) }));
}

export function setDocumentStatus(projectId: string, id: string, status: string, error: string | null = null) {
  getDb().prepare("UPDATE documents SET status = ?, error = ? WHERE id = ? AND project_id = ?").run(status, error, id, projectId);
}

export function deleteDocument(projectId: string, id: string) {
  const d = getDocument(projectId, id);
  getDb().prepare("DELETE FROM documents WHERE id = ? AND project_id = ?").run(id, projectId);
  rmSync(d.storedPath, { force: true });
}

export function savePages(documentId: string, pages: string[]) {
  const ins = getDb().prepare("INSERT OR REPLACE INTO doc_pages (document_id, page, text, char_count) VALUES (?, ?, ?, ?)");
  getDb().transaction(() => pages.forEach((t, i) => ins.run(documentId, i + 1, t, t.replace(/\s/g, "").length)))();
}

export function getPages(projectId: string, documentId: string, from: number, to: number): { page: number; text: string; charCount: number }[] {
  getDocument(projectId, documentId);
  return (
    getDb()
      .prepare("SELECT page, text, char_count FROM doc_pages WHERE document_id = ? AND page BETWEEN ? AND ? ORDER BY page")
      .all(documentId, from, to) as { page: number; text: string; char_count: number }[]
  ).map((r) => ({ page: r.page, text: r.text, charCount: r.char_count }));
}

export interface Batch {
  id: string;
  documentId: string;
  startPage: number;
  endPage: number;
  status: "pending" | "processing" | "done" | "failed";
  attempts: number;
  error: string | null;
}
type BatchRow = { id: string; document_id: string; start_page: number; end_page: number; status: Batch["status"]; attempts: number; error: string | null };
const toBatch = (r: BatchRow): Batch => ({ id: r.id, documentId: r.document_id, startPage: r.start_page, endPage: r.end_page, status: r.status, attempts: r.attempts, error: r.error });

export function createBatches(projectId: string, documentId: string, ranges: [number, number][]) {
  const ins = getDb().prepare(
    "INSERT INTO batches (id, document_id, project_id, start_page, end_page, status, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
  );
  getDb().transaction(() => ranges.forEach(([a, b]) => ins.run(newId("bat"), documentId, projectId, a, b, nowIso())))();
}

export const MAX_BATCH_ATTEMPTS = 3;
const STALE_MS = 6 * 60 * 1000;

/**
 * Claims the next batch to process. Batches stuck in "processing" (e.g. the server
 * restarted mid-request) are released after a timeout so interrupted runs resume.
 */
export function claimNextBatch(projectId: string, documentId: string, retryFailed = false): Batch | null {
  const d = getDb();
  return d.transaction(() => {
    d.prepare("UPDATE batches SET status = 'pending' WHERE document_id = ? AND status = 'processing' AND updated_at < ?").run(
      documentId,
      new Date(Date.now() - STALE_MS).toISOString(),
    );
    if (retryFailed)
      d.prepare("UPDATE batches SET status = 'pending', attempts = 0 WHERE document_id = ? AND project_id = ? AND status = 'failed'").run(documentId, projectId);
    const r = d
      .prepare("SELECT * FROM batches WHERE document_id = ? AND project_id = ? AND status = 'pending' ORDER BY start_page LIMIT 1")
      .get(documentId, projectId) as BatchRow | undefined;
    if (!r) return null;
    d.prepare("UPDATE batches SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(nowIso(), r.id);
    return toBatch({ ...r, status: "processing", attempts: r.attempts + 1 });
  })();
}

export function finishBatch(id: string, ok: boolean, error: string | null, attempts: number) {
  const status = ok ? "done" : attempts >= MAX_BATCH_ATTEMPTS ? "failed" : "pending";
  getDb().prepare("UPDATE batches SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, nowIso(), id);
}

export function batchProgress(projectId: string, documentId: string) {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM batches WHERE document_id = ? AND project_id = ? GROUP BY status")
    .all(documentId, projectId) as { status: string; n: number }[];
  const c = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  const errors = (
    getDb().prepare("SELECT start_page, end_page, error FROM batches WHERE document_id = ? AND error IS NOT NULL").all(documentId) as {
      start_page: number;
      end_page: number;
      error: string;
    }[]
  ).map((r) => `Pages ${r.start_page}–${r.end_page}: ${r.error}`);
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return { total, done: c.done ?? 0, failed: c.failed ?? 0, pending: (c.pending ?? 0) + (c.processing ?? 0), errors };
}

// ---------------- evidence ----------------

export interface Evidence {
  id: string;
  projectId: string;
  documentId: string;
  page: number;
  photoIndex: number;
  caption: string | null;
  captionSource: string | null;
  locationId: string | null;
  locationText: string | null;
  locationConfidence: string | null;
  locationBasis: string | null;
  materials: string[];
  conditions: string[];
  captionStatements: string[];
  flags: string[];
  readable: boolean;
}
type EvRow = {
  id: string; project_id: string; document_id: string; page: number; photo_index: number; caption: string | null; caption_source: string | null;
  location_id: string | null; location_text: string | null; location_confidence: string | null; location_basis: string | null;
  materials: string; conditions: string; caption_statements: string; flags: string; readable: number;
};
const toEv = (r: EvRow): Evidence => ({
  id: r.id,
  projectId: r.project_id,
  documentId: r.document_id,
  page: r.page,
  photoIndex: r.photo_index,
  caption: r.caption,
  captionSource: r.caption_source,
  locationId: r.location_id,
  locationText: r.location_text,
  locationConfidence: r.location_confidence,
  locationBasis: r.location_basis,
  materials: j(r.materials, []),
  conditions: j(r.conditions, []),
  captionStatements: j(r.caption_statements, []),
  flags: j(r.flags, []),
  readable: !!r.readable,
});

export function listEvidence(projectId: string): Evidence[] {
  return (getDb().prepare("SELECT * FROM evidence WHERE project_id = ? ORDER BY document_id, page, photo_index").all(projectId) as EvRow[]).map(toEv);
}

export function replaceBatchEvidence(projectId: string, documentId: string, batchId: string, rows: Omit<Evidence, "id" | "projectId" | "documentId">[]) {
  const d = getDb();
  getDocument(projectId, documentId);
  d.transaction(() => {
    d.prepare("DELETE FROM evidence WHERE batch_id = ? AND project_id = ?").run(batchId, projectId);
    const ins = d.prepare(`INSERT INTO evidence (id, project_id, document_id, batch_id, page, photo_index, caption, caption_source, location_id,
      location_text, location_confidence, location_basis, materials, conditions, caption_statements, flags, readable, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of rows)
      ins.run(
        newId("ev"), projectId, documentId, batchId, e.page, e.photoIndex, e.caption, e.captionSource, e.locationId,
        e.locationText, e.locationConfidence, e.locationBasis, JSON.stringify(e.materials), JSON.stringify(e.conditions),
        JSON.stringify(e.captionStatements), JSON.stringify(e.flags), e.readable ? 1 : 0, nowIso(),
      );
  })();
}

export function setEvidenceLocation(projectId: string, id: string, locationId: string | null) {
  if (locationId && !listLocations(projectId).some((l) => l.id === locationId)) throw new NotFound("Room not found");
  const r = getDb()
    .prepare("UPDATE evidence SET location_id = ?, location_confidence = 'confirmed', location_basis = 'pm' WHERE id = ? AND project_id = ?")
    .run(locationId, id, projectId);
  if (!r.changes) throw new NotFound("Evidence not found");
}

// ---------------- visits & drafts ----------------

type VisitRow = {
  id: string; project_id: string; type: VisitType; visit_date: string; appointment_time: string | null; arrival_time: string | null;
  departure_time: string | null; access_outcome: string | null; field_notes: string; facts: string; doc: string | null;
  manual_text: string | null; created_at: string; updated_at: string;
};
function toVisit(r: VisitRow): Visit {
  const parsed = VisitFacts.safeParse(j(r.facts, {}));
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type,
    visitDate: r.visit_date,
    appointmentTime: r.appointment_time,
    arrivalTime: r.arrival_time,
    departureTime: r.departure_time,
    accessOutcome: r.access_outcome,
    fieldNotes: r.field_notes,
    facts: parsed.success ? parsed.data : emptyFacts(),
    doc: j<ScopeDoc | null>(r.doc, null),
    manualText: r.manual_text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Visits ordered oldest → newest (date, then creation). */
export function listVisits(projectId: string): Visit[] {
  return (getDb().prepare("SELECT * FROM visits WHERE project_id = ? ORDER BY visit_date, created_at").all(projectId) as VisitRow[]).map(toVisit);
}

export function getVisit(projectId: string, id: string): Visit {
  const r = getDb().prepare("SELECT * FROM visits WHERE id = ? AND project_id = ?").get(id, projectId) as VisitRow | undefined;
  if (!r) throw new NotFound("Visit not found");
  return toVisit(r);
}

/**
 * New visits start blank: appointment/arrival/departure times and access outcome
 * are never copied from an earlier visit.
 */
export function createVisit(projectId: string, input: { type: VisitType; visitDate: string; appointmentTime?: string | null }): Visit {
  getProject(projectId);
  const id = newId("vis");
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO visits (id, project_id, type, visit_date, appointment_time, arrival_time, departure_time, access_outcome, field_notes, facts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, '', ?, ?, ?)`,
    )
    .run(id, projectId, input.type, input.visitDate, input.appointmentTime ?? null, JSON.stringify(emptyFacts()), now, now);
  touchProject(projectId);
  return getVisit(projectId, id);
}

export const VISIT_EDITABLE = {
  type: "type",
  visitDate: "visit_date",
  appointmentTime: "appointment_time",
  arrivalTime: "arrival_time",
  departureTime: "departure_time",
  accessOutcome: "access_outcome",
  fieldNotes: "field_notes",
} as const;

export function updateVisitFields(projectId: string, id: string, patch: Partial<Record<keyof typeof VISIT_EDITABLE, string | null>>) {
  getVisit(projectId, id);
  for (const [k, col] of Object.entries(VISIT_EDITABLE)) {
    if (!(k in patch)) continue;
    const v = patch[k as keyof typeof VISIT_EDITABLE];
    getDb()
      .prepare(`UPDATE visits SET ${col} = ?, updated_at = ? WHERE id = ? AND project_id = ?`)
      .run(k === "fieldNotes" ? (v ?? "") : v || null, nowIso(), id, projectId);
  }
  return getVisit(projectId, id);
}

export function saveVisitState(
  projectId: string,
  visitId: string,
  state: { facts: VisitFacts; doc: ScopeDoc | null; manualText: string | null; text: string },
  version: { trigger: DraftVersion["trigger"]; input: string | null; changes: string[] },
): DraftVersion {
  const d = getDb();
  getVisit(projectId, visitId);
  return d.transaction(() => {
    d.prepare("UPDATE visits SET facts = ?, doc = ?, manual_text = ?, updated_at = ? WHERE id = ? AND project_id = ?").run(
      JSON.stringify(state.facts),
      state.doc ? JSON.stringify(state.doc) : null,
      state.manualText,
      nowIso(),
      visitId,
      projectId,
    );
    const n = (d.prepare("SELECT COALESCE(MAX(version), 0) AS n FROM drafts WHERE visit_id = ?").get(visitId) as { n: number }).n + 1;
    const id = newId("drf");
    d.prepare(
      "INSERT INTO drafts (id, visit_id, project_id, version, trigger, input, changes, facts, doc, manual_text, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, visitId, projectId, n, version.trigger, version.input, JSON.stringify(version.changes), JSON.stringify(state.facts),
      state.doc ? JSON.stringify(state.doc) : null, state.manualText, state.text, nowIso(),
    );
    touchProject(projectId);
    return { id, visitId, version: n, trigger: version.trigger, input: version.input, changes: version.changes, text: state.text, createdAt: nowIso() };
  })();
}

type DraftRow = { id: string; visit_id: string; version: number; trigger: DraftVersion["trigger"]; input: string | null; changes: string; text: string; created_at: string; facts: string; doc: string | null; manual_text: string | null };

export function listDrafts(projectId: string, visitId: string): DraftVersion[] {
  return (
    getDb().prepare("SELECT * FROM drafts WHERE visit_id = ? AND project_id = ? ORDER BY version DESC").all(visitId, projectId) as DraftRow[]
  ).map((r) => ({ id: r.id, visitId: r.visit_id, version: r.version, trigger: r.trigger, input: r.input, changes: j(r.changes, []), text: r.text, createdAt: r.created_at }));
}

export function getDraftState(projectId: string, visitId: string, draftId: string) {
  const r = getDb().prepare("SELECT * FROM drafts WHERE id = ? AND visit_id = ? AND project_id = ?").get(draftId, visitId, projectId) as DraftRow | undefined;
  if (!r) throw new NotFound("Draft not found");
  return { version: r.version, facts: VisitFacts.parse(j(r.facts, {})), doc: j<ScopeDoc | null>(r.doc, null), manualText: r.manual_text, text: r.text };
}

export function deleteVisit(projectId: string, id: string) {
  const r = getDb().prepare("DELETE FROM visits WHERE id = ? AND project_id = ?").run(id, projectId);
  if (!r.changes) throw new NotFound("Visit not found");
}

// ---------------- checklist templates ----------------

export interface ChecklistTemplate {
  id: string;
  name: string;
  visitTypes: VisitType[];
  items: { id: string; label: string }[];
  isStarter: boolean;
}
type TplRow = { id: string; name: string; visit_types: string; items: string; is_starter: number };
const toTpl = (r: TplRow): ChecklistTemplate => ({ id: r.id, name: r.name, visitTypes: j(r.visit_types, []), items: j(r.items, []), isStarter: !!r.is_starter });

export function listTemplates(): ChecklistTemplate[] {
  ensureStarterTemplates();
  return (getDb().prepare("SELECT * FROM checklist_templates ORDER BY is_starter, name").all() as TplRow[]).map(toTpl);
}
export function getTemplate(id: string): ChecklistTemplate {
  const r = getDb().prepare("SELECT * FROM checklist_templates WHERE id = ?").get(id) as TplRow | undefined;
  if (!r) throw new NotFound("Template not found");
  return toTpl(r);
}
export function saveTemplate(t: { id?: string; name: string; visitTypes: VisitType[]; items: string[] }): ChecklistTemplate {
  const id = t.id ?? newId("tpl");
  const items = t.items.map((label, i) => ({ id: `c${i + 1}`, label: label.trim() })).filter((x) => x.label);
  getDb()
    .prepare(
      `INSERT INTO checklist_templates (id, name, visit_types, items, is_starter, created_at) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, visit_types = excluded.visit_types, items = excluded.items, is_starter = 0`,
    )
    .run(id, t.name.trim(), JSON.stringify(t.visitTypes), JSON.stringify(items), nowIso());
  return getTemplate(id);
}
export function deleteTemplate(id: string) {
  getDb().prepare("DELETE FROM checklist_templates WHERE id = ?").run(id);
}

function ensureStarterTemplates() {
  const n = (getDb().prepare("SELECT COUNT(*) AS n FROM checklist_templates").get() as { n: number }).n;
  if (n) return;
  const starters: { name: string; types: VisitType[]; items: string[] }[] = [
    {
      name: "Starter — Mitigation visit (edit to match your company)",
      types: ["initial_assessment", "initial_mitigation", "kickoff", "checklist"],
      items: [
        "Cause of loss and source status documented",
        "Water category / class documented",
        "Work authorization signed",
        "CompanyCam photos uploaded",
        "DocuSketch / sketch completed",
        "DryBook / moisture map started",
        "Moisture readings recorded",
        "Equipment placed and logged",
        "Customer walk-through of scope",
        "Next visit scheduled",
      ],
    },
    {
      name: "Starter — Daily monitoring (edit to match your company)",
      types: ["daily_monitoring"],
      items: [
        "Moisture readings recorded",
        "DryBook updated",
        "Equipment operating / adjusted",
        "CompanyCam photos uploaded",
        "Customer update given",
        "Next visit scheduled",
      ],
    },
    {
      name: "Starter — Final walk-through (edit to match your company)",
      types: ["final_walkthrough"],
      items: [
        "Final moisture readings recorded",
        "Dry standard met and documented",
        "Equipment pickup completed",
        "Certificate of completion signed",
        "Final CompanyCam photos uploaded",
        "DryBook closed out",
        "Reconstruction handoff",
      ],
    },
  ];
  for (const s of starters) {
    const id = newId("tpl");
    getDb()
      .prepare("INSERT INTO checklist_templates (id, name, visit_types, items, is_starter, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(id, s.name, JSON.stringify(s.types), JSON.stringify(s.items.map((label, i) => ({ id: `c${i + 1}`, label }))), nowIso());
  }
}

// ---------------- company manuals ----------------

export interface Manual {
  id: string;
  name: string;
  filename: string;
  status: string;
  error: string | null;
  rules: { id: string; topic: string; rule: string }[];
  textLength: number;
  createdAt: string;
}
type ManRow = { id: string; name: string; filename: string; stored_path: string; text: string; rules: string; status: string; error: string | null; created_at: string };
const toManual = (r: ManRow): Manual => ({
  id: r.id,
  name: r.name,
  filename: r.filename,
  status: r.status,
  error: r.error,
  rules: j(r.rules, []),
  textLength: r.text.length,
  createdAt: r.created_at,
});

export function listManuals(): Manual[] {
  return (getDb().prepare("SELECT * FROM manuals ORDER BY created_at").all() as ManRow[]).map(toManual);
}
export function getManualText(id: string): { manual: Manual; text: string; storedPath: string } {
  const r = getDb().prepare("SELECT * FROM manuals WHERE id = ?").get(id) as ManRow | undefined;
  if (!r) throw new NotFound("Manual not found");
  return { manual: toManual(r), text: r.text, storedPath: r.stored_path };
}
export function createManual(m: { id: string; name: string; filename: string; storedPath: string; text: string }) {
  getDb()
    .prepare("INSERT INTO manuals (id, name, filename, stored_path, text, status, created_at) VALUES (?, ?, ?, ?, ?, 'uploaded', ?)")
    .run(m.id, m.name, m.filename, m.storedPath, m.text, nowIso());
}
export function setManualRules(id: string, rules: Manual["rules"], status: string, error: string | null = null) {
  getDb().prepare("UPDATE manuals SET rules = ?, status = ?, error = ? WHERE id = ?").run(JSON.stringify(rules), status, error, id);
}
export function deleteManual(id: string) {
  const { storedPath } = getManualText(id);
  getDb().prepare("DELETE FROM manuals WHERE id = ?").run(id);
  getDb().prepare("DELETE FROM manual_conflicts WHERE manual_ids LIKE ?").run(`%${id}%`);
  rmSync(storedPath, { force: true });
}
export function listConflicts(): { id: string; description: string; manualIds: string[]; status: string }[] {
  return (getDb().prepare("SELECT * FROM manual_conflicts WHERE status = 'open' ORDER BY created_at").all() as {
    id: string; description: string; manual_ids: string; status: string;
  }[]).map((r) => ({ id: r.id, description: r.description, manualIds: j(r.manual_ids, []), status: r.status }));
}
export function addConflicts(list: { description: string; manualIds: string[] }[]) {
  const ins = getDb().prepare("INSERT INTO manual_conflicts (id, description, manual_ids, status, created_at) VALUES (?, ?, ?, 'open', ?)");
  for (const c of list) ins.run(newId("cfl"), c.description, JSON.stringify(c.manualIds), nowIso());
}
export function resolveConflict(id: string) {
  getDb().prepare("UPDATE manual_conflicts SET status = 'resolved' WHERE id = ?").run(id);
}
