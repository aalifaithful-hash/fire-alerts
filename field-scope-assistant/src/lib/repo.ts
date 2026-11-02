import { rmSync } from "node:fs";
import path from "node:path";
import { query, queryOne, tag, tx, UPLOAD_DIR } from "./db";
import { newId } from "./ids";
import { nowIso } from "./time";
import { emptyFacts, VisitFacts, type Location, type ScopeDoc, type VisitType } from "./schemas";
import { PROJECT_TEXT_FIELDS, type DraftVersion, type Project, type Visit } from "./types";

/**
 * Data access. Every read/write that touches project data takes the projectId and
 * filters on it, so one property's information can never leak into another's.
 *
 * All functions are async and backed by hosted Postgres (see ./db). Number
 * conversions guard against Postgres returning COUNT(*)/MAX() as strings.
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
    const v = input[f];
    out[f] = v == null || v === "" ? null : String(v);
  }
  return out;
}

export async function listProjects(search?: string): Promise<(Project & { visitCount: number; lastVisit: string | null })[]> {
  const rows = await query<ProjectRow & { visit_count: string; last_visit: string | null }>`
    SELECT p.*,
      (SELECT COUNT(*) FROM visits v WHERE v.project_id = p.id) AS visit_count,
      (SELECT MAX(visit_date) FROM visits v WHERE v.project_id = p.id) AS last_visit
    FROM projects p ORDER BY p.updated_at DESC`;
  const needle = search?.trim().toLowerCase();
  return rows
    .filter((r) => !needle || r.data.toLowerCase().includes(needle))
    .map((r) => ({ ...toProject(r), visitCount: Number(r.visit_count), lastVisit: r.last_visit }));
}

export async function getProject(id: string): Promise<Project> {
  const r = await queryOne<ProjectRow>`SELECT * FROM projects WHERE id = ${id}`;
  if (!r) throw new NotFound("Project not found.");
  return toProject(r);
}

export async function createProject(input: Record<string, unknown>): Promise<Project> {
  const clean = cleanProjectInput(input);
  const id = newId("prj");
  const now = nowIso();
  await query`INSERT INTO projects (id, data, is_demo, created_at, updated_at)
    VALUES (${id}, ${JSON.stringify(clean)}, 0, ${now}, ${now})`;
  return getProject(id);
}

export async function updateProject(id: string, input: Record<string, unknown>): Promise<Project> {
  await getProject(id);
  const clean = cleanProjectInput(input);
  await query`UPDATE projects SET data = ${JSON.stringify(clean)}, updated_at = ${nowIso()} WHERE id = ${id}`;
  return getProject(id);
}

export async function touchProject(id: string): Promise<void> {
  await query`UPDATE projects SET updated_at = ${nowIso()} WHERE id = ${id}`;
}

export async function deleteProject(id: string): Promise<void> {
  await getProject(id);
  // ON DELETE CASCADE removes child rows; explicit deletes kept for safety.
  await query`DELETE FROM projects WHERE id = ${id}`;
  await query`DELETE FROM drafts WHERE project_id = ${id}`;
  await query`DELETE FROM batches WHERE project_id = ${id}`;
  rmSync(path.join(UPLOAD_DIR, id), { recursive: true, force: true });
}

// ---------------- locations ----------------

type LocationRow = { id: string; floor: string | null; unit: string | null; room: string; sort: number };
function toLocation(r: LocationRow): Location {
  return { id: r.id, floor: r.floor, unit: r.unit, room: r.room, sort: r.sort };
}

export async function listLocations(projectId: string): Promise<Location[]> {
  const rows = await query<LocationRow>`SELECT * FROM locations WHERE project_id = ${projectId} ORDER BY sort ASC`;
  return rows.map(toLocation);
}

export async function insertLocation(
  projectId: string,
  loc: { floor?: string | null; unit?: string | null; room: string }
): Promise<Location> {
  const n = await queryOne<{ n: string }>`SELECT COUNT(*) AS n FROM locations WHERE project_id = ${projectId}`;
  const id = newId("loc");
  await query`INSERT INTO locations (id, project_id, floor, unit, room, sort)
    VALUES (${id}, ${projectId}, ${loc.floor ?? null}, ${loc.unit ?? null}, ${loc.room}, ${Number(n?.n ?? 0)})`;
  const row = await queryOne<LocationRow>`SELECT * FROM locations WHERE id = ${id}`;
  if (!row) throw new Error("Failed to create location.");
  return toLocation(row);
}

export async function updateLocation(
  projectId: string,
  id: string,
  patch: { floor?: string | null; unit?: string | null; room?: string }
): Promise<Location> {
  const cur = await queryOne<LocationRow>`SELECT * FROM locations WHERE id = ${id} AND project_id = ${projectId}`;
  if (!cur) throw new NotFound("Room not found.");
  const floor = patch.floor !== undefined ? patch.floor : cur.floor;
  const unit = patch.unit !== undefined ? patch.unit : cur.unit;
  const room = patch.room !== undefined ? patch.room : cur.room;
  const rows = await query<LocationRow>`UPDATE locations SET floor = ${floor}, unit = ${unit}, room = ${room}
    WHERE id = ${id} AND project_id = ${projectId} RETURNING *`;
  if (!rows.length) throw new NotFound("Room not found.");
  return toLocation(rows[0]);
}

export async function deleteLocation(projectId: string, id: string): Promise<void> {
  const deleted = await query<{ id: string }>`DELETE FROM locations WHERE id = ${id} AND project_id = ${projectId} RETURNING id`;
  if (!deleted.length) throw new NotFound("Room not found.");
  const visits = await query<{ id: string; facts: string }>`SELECT id, facts FROM visits WHERE project_id = ${projectId}`;
  const updates: unknown[] = [];
  for (const v of visits) {
    const facts = j<VisitFacts>(v.facts, emptyFacts());
    const rooms = facts.property.rooms.filter((r) => r.locationId !== id);
    if (rooms.length !== facts.property.rooms.length) {
      const next: VisitFacts = { ...facts, property: { ...facts.property, rooms } };
      updates.push(tag`UPDATE visits SET facts = ${JSON.stringify(next)} WHERE id = ${v.id}`);
    }
  }
  if (updates.length) await tx(updates);
}

// ---------------- documents / batches ----------------

export type Document = {
  id: string; projectId: string; filename: string; storedPath: string;
  size: number; pageCount: number; status: string; error: string | null; createdAt: string;
};
type DocumentRow = {
  id: string; project_id: string; filename: string; stored_path: string;
  size: number; page_count: number; status: string; error: string | null; created_at: string;
};
function toDocument(r: DocumentRow): Document {
  return {
    id: r.id, projectId: r.project_id, filename: r.filename, storedPath: r.stored_path,
    size: r.size, pageCount: r.page_count, status: r.status, error: r.error, createdAt: r.created_at,
  };
}

export async function createDocument(
  projectId: string,
  input: { filename: string; storedPath: string; size: number; pageCount: number }
): Promise<Document> {
  await getProject(projectId);
  const id = newId("doc");
  const now = nowIso();
  await query`INSERT INTO documents (id, project_id, filename, stored_path, size, page_count, status, created_at)
    VALUES (${id}, ${projectId}, ${input.filename}, ${input.storedPath}, ${input.size}, ${input.pageCount}, 'uploaded', ${now})`;
  const row = await queryOne<DocumentRow>`SELECT * FROM documents WHERE id = ${id}`;
  if (!row) throw new Error("Failed to create document.");
  return toDocument(row);
}

export async function getDocument(projectId: string, id: string): Promise<Document> {
  const r = await queryOne<DocumentRow>`SELECT * FROM documents WHERE id = ${id} AND project_id = ${projectId}`;
  if (!r) throw new NotFound("Document not found.");
  return toDocument(r);
}

export async function listDocuments(projectId: string): Promise<Document[]> {
  const rows = await query<DocumentRow>`SELECT * FROM documents WHERE project_id = ${projectId} ORDER BY created_at DESC`;
  return rows.map(toDocument);
}

export async function setDocumentStatus(projectId: string, id: string, status: string, error?: string | null): Promise<void> {
  await getDocument(projectId, id);
  await query`UPDATE documents SET status = ${status}, error = ${error ?? null} WHERE id = ${id}`;
}

export async function deleteDocument(projectId: string, id: string): Promise<void> {
  const d = await getDocument(projectId, id);
  await query`DELETE FROM documents WHERE id = ${id} AND project_id = ${projectId}`;
  rmSync(d.storedPath, { force: true });
  await touchProject(projectId);
}

export async function savePages(documentId: string, pages: { page: number; text: string }[]): Promise<void> {
  await Promise.all(
    pages.map((t) =>
      query`INSERT INTO doc_pages (document_id, page, text, char_count)
        VALUES (${documentId}, ${t.page}, ${t.text}, ${t.text.length})
        ON CONFLICT (document_id, page) DO UPDATE SET text = EXCLUDED.text, char_count = EXCLUDED.char_count`
    )
  );
}

export async function getPages(documentId: string): Promise<{ page: number; text: string }[]> {
  const rows = await query<{ page: number; text: string }>`SELECT page, text FROM doc_pages WHERE document_id = ${documentId} ORDER BY page ASC`;
  return rows;
}

export type Batch = {
  id: string; documentId: string; projectId: string; startPage: number; endPage: number;
  status: string; attempts: number; error: string | null; updatedAt: string;
};
type BatchRow = {
  id: string; document_id: string; project_id: string; start_page: number; end_page: number;
  status: string; attempts: number; error: string | null; updated_at: string;
};
function toBatch(r: BatchRow): Batch {
  return {
    id: r.id, documentId: r.document_id, projectId: r.project_id, startPage: r.start_page,
    endPage: r.end_page, status: r.status, attempts: r.attempts, error: r.error, updatedAt: r.updated_at,
  };
}
export const MAX_BATCH_ATTEMPTS = 3;

export async function createBatches(
  projectId: string,
  documentId: string,
  ranges: { startPage: number; endPage: number }[]
): Promise<Batch[]> {
  const now = nowIso();
  const ids = ranges.map(() => newId("bat"));
  await Promise.all(
    ranges.map((r, i) =>
      query`INSERT INTO batches (id, document_id, project_id, start_page, end_page, status, attempts, updated_at)
        VALUES (${ids[i]}, ${documentId}, ${projectId}, ${r.startPage}, ${r.endPage}, 'pending', 0, ${now})`
    )
  );
  const rows = await query<BatchRow>`SELECT * FROM batches WHERE document_id = ${documentId} ORDER BY start_page ASC`;
  return rows.map(toBatch);
}

/** Atomically claims the next pending batch (single statement, SKIP LOCKED). */
export async function claimNextBatch(projectId: string, documentId: string): Promise<Batch | null> {
  const now = nowIso();
  // Release batches stuck in processing for > 10 minutes.
  await query`UPDATE batches SET status = 'pending', updated_at = ${now}
    WHERE document_id = ${documentId} AND project_id = ${projectId}
      AND status = 'processing' AND updated_at < ${new Date(Date.now() - 10 * 60 * 1000).toISOString()}`;
  // Retry failed batches below the attempt cap.
  await query`UPDATE batches SET status = 'pending', updated_at = ${now}
    WHERE document_id = ${documentId} AND project_id = ${projectId}
      AND status = 'failed' AND attempts < ${MAX_BATCH_ATTEMPTS}`;
  const rows = await query<BatchRow>`
    WITH next AS (
      SELECT id FROM batches
      WHERE document_id = ${documentId} AND project_id = ${projectId} AND status = 'pending'
      ORDER BY start_page
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE batches b SET status = 'processing', attempts = b.attempts + 1, updated_at = ${now}
    FROM next WHERE b.id = next.id
    RETURNING b.*`;
  if (!rows.length) return null;
  return toBatch(rows[0]);
}

export async function finishBatch(batchId: string, status: "done" | "failed", error?: string | null): Promise<void> {
  await query`UPDATE batches SET status = ${status}, error = ${error ?? null}, updated_at = ${nowIso()} WHERE id = ${batchId}`;
}

export async function batchProgress(projectId: string, documentId: string): Promise<{ total: number; done: number; failed: number; processing: number }> {
  const rows = await query<{ status: string; n: string }>`SELECT status, COUNT(*) AS n FROM batches WHERE document_id = ${documentId} AND project_id = ${projectId} GROUP BY status`;
  const c: Record<string, number> = {};
  for (const r of rows) c[r.status] = Number(r.n);
  const done = c.done ?? 0;
  const failed = c.failed ?? 0;
  const processing = c.processing ?? 0;
  return { total: done + failed + processing + (c.pending ?? 0), done, failed, processing };
}

// ---------------- evidence ----------------

export type Evidence = {
  id: string; projectId: string; documentId: string | null; batchId: string | null;
  page: number; photoIndex: number; caption: string | null; captionSource: string | null;
  locationId: string | null; locationText: string | null; locationConfidence: string | null;
  locationBasis: string | null; materials: string[]; conditions: string[];
  captionStatements: string[]; flags: string[]; readable: boolean; createdAt: string;
};
type EvidenceRow = {
  id: string; project_id: string; document_id: string | null; batch_id: string | null;
  page: number; photo_index: number; caption: string | null; caption_source: string | null;
  location_id: string | null; location_text: string | null; location_confidence: string | null;
  location_basis: string | null; materials: string; conditions: string;
  caption_statements: string; flags: string; readable: number; created_at: string;
};
function toEvidence(r: EvidenceRow): Evidence {
  return {
    id: r.id, projectId: r.project_id, documentId: r.document_id, batchId: r.batch_id,
    page: r.page, photoIndex: r.photo_index, caption: r.caption, captionSource: r.caption_source,
    locationId: r.location_id, locationText: r.location_text, locationConfidence: r.location_confidence,
    locationBasis: r.location_basis, materials: j<string[]>(r.materials, []), conditions: j<string[]>(r.conditions, []),
    captionStatements: j<string[]>(r.caption_statements, []), flags: j<string[]>(r.flags, []),
    readable: r.readable === 1, createdAt: r.created_at,
  };
}

export async function listEvidence(projectId: string): Promise<Evidence[]> {
  const rows = await query<EvidenceRow>`SELECT * FROM evidence WHERE project_id = ${projectId}
    ORDER BY CASE WHEN document_id IS NULL THEN 1 ELSE 0 END, page ASC, photo_index ASC, created_at ASC`;
  return rows.map(toEvidence);
}

export async function replaceBatchEvidence(
  projectId: string,
  documentId: string,
  batchId: string,
  items: Omit<Evidence, "id" | "projectId" | "documentId" | "batchId" | "createdAt">[]
): Promise<void> {
  const now = nowIso();
  const inserts = items.map((e) => {
    const id = newId("evi");
    return tag`INSERT INTO evidence (id, project_id, document_id, batch_id, page, photo_index, caption, caption_source, location_id, location_text, location_confidence, location_basis, materials, conditions, caption_statements, flags, readable, created_at)
      VALUES (${id}, ${projectId}, ${documentId}, ${batchId}, ${e.page}, ${e.photoIndex}, ${e.caption ?? null}, ${e.captionSource ?? null}, ${e.locationId ?? null}, ${e.locationText ?? null}, ${e.locationConfidence ?? null}, ${e.locationBasis ?? null}, ${JSON.stringify(e.materials)}, ${JSON.stringify(e.conditions)}, ${JSON.stringify(e.captionStatements)}, ${JSON.stringify(e.flags)}, ${e.readable ? 1 : 0}, ${now})`;
  });
  await tx([tag`DELETE FROM evidence WHERE batch_id = ${batchId} AND project_id = ${projectId}`, ...inserts]);
}

export async function setEvidenceLocation(
  projectId: string,
  id: string,
  patch: { locationId?: string | null; locationText?: string | null; locationConfidence?: string | null; locationBasis?: string | null }
): Promise<Evidence> {
  const cur = await queryOne<EvidenceRow>`SELECT * FROM evidence WHERE id = ${id} AND project_id = ${projectId}`;
  if (!cur) throw new NotFound("Photo not found.");
  const e = toEvidence(cur);
  const locationId = patch.locationId !== undefined ? patch.locationId : e.locationId;
  const locationText = patch.locationText !== undefined ? patch.locationText : e.locationText;
  const locationConfidence = patch.locationConfidence !== undefined ? patch.locationConfidence : e.locationConfidence;
  const locationBasis = patch.locationBasis !== undefined ? patch.locationBasis : e.locationBasis;
  const rows = await query<EvidenceRow>`UPDATE evidence
    SET location_id = ${locationId}, location_text = ${locationText}, location_confidence = ${locationConfidence}, location_basis = ${locationBasis}
    WHERE id = ${id} AND project_id = ${projectId} RETURNING *`;
  if (!rows.length) throw new NotFound("Photo not found.");
  return toEvidence(rows[0]);
}

// ---------------- visits / drafts ----------------

type VisitRow = {
  id: string; project_id: string; type: string; visit_date: string;
  appointment_time: string | null; arrival_time: string | null; departure_time: string | null;
  access_outcome: string | null; field_notes: string; facts: string; doc: string | null;
  manual_text: string | null; created_at: string; updated_at: string;
};
function toVisit(r: VisitRow): Visit {
  return {
    id: r.id, projectId: r.project_id, type: r.type as VisitType, visitDate: r.visit_date,
    appointmentTime: r.appointment_time, arrivalTime: r.arrival_time, departureTime: r.departure_time,
    accessOutcome: r.access_outcome, fieldNotes: r.field_notes, facts: j<VisitFacts>(r.facts, emptyFacts()),
    doc: r.doc ? (JSON.parse(r.doc) as ScopeDoc) : null, manualText: r.manual_text,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listVisits(projectId: string): Promise<Visit[]> {
  const rows = await query<VisitRow>`SELECT * FROM visits WHERE project_id = ${projectId} ORDER BY visit_date DESC, created_at DESC`;
  return rows.map(toVisit);
}

export async function getVisit(projectId: string, id: string): Promise<Visit> {
  const r = await queryOne<VisitRow>`SELECT * FROM visits WHERE id = ${id} AND project_id = ${projectId}`;
  if (!r) throw new NotFound("Visit not found.");
  return toVisit(r);
}

export async function createVisit(projectId: string, input: { type: VisitType; visitDate: string; appointmentTime?: string | null }): Promise<Visit> {
  await getProject(projectId);
  const id = newId("vis");
  const now = nowIso();
  const facts = emptyFacts();
  await query`INSERT INTO visits (id, project_id, type, visit_date, appointment_time, facts, created_at, updated_at)
    VALUES (${id}, ${projectId}, ${input.type}, ${input.visitDate}, ${input.appointmentTime ?? null}, ${JSON.stringify(facts)}, ${now}, ${now})`;
  await touchProject(projectId);
  return getVisit(projectId, id);
}

export const VISIT_EDITABLE: (keyof Pick<Visit, "appointmentTime" | "arrivalTime" | "departureTime" | "accessOutcome" | "fieldNotes">)[] =
  ["appointmentTime", "arrivalTime", "departureTime", "accessOutcome", "fieldNotes"];

export async function updateVisitFields(
  projectId: string,
  id: string,
  patch: Partial<Pick<Visit, "appointmentTime" | "arrivalTime" | "departureTime" | "accessOutcome" | "fieldNotes">>
): Promise<Visit> {
  await getVisit(projectId, id);
  const updates: unknown[] = [];
  if (patch.appointmentTime !== undefined)
    updates.push(tag`UPDATE visits SET appointment_time = ${patch.appointmentTime ?? null} WHERE id = ${id} AND project_id = ${projectId}`);
  if (patch.arrivalTime !== undefined)
    updates.push(tag`UPDATE visits SET arrival_time = ${patch.arrivalTime ?? null} WHERE id = ${id} AND project_id = ${projectId}`);
  if (patch.departureTime !== undefined)
    updates.push(tag`UPDATE visits SET departure_time = ${patch.departureTime ?? null} WHERE id = ${id} AND project_id = ${projectId}`);
  if (patch.accessOutcome !== undefined)
    updates.push(tag`UPDATE visits SET access_outcome = ${patch.accessOutcome ?? null} WHERE id = ${id} AND project_id = ${projectId}`);
  if (patch.fieldNotes !== undefined)
    updates.push(tag`UPDATE visits SET field_notes = ${patch.fieldNotes ?? null} WHERE id = ${id} AND project_id = ${projectId}`);
  updates.push(tag`UPDATE visits SET updated_at = ${nowIso()} WHERE id = ${id} AND project_id = ${projectId}`);
  await tx(updates);
  await touchProject(projectId);
  return getVisit(projectId, id);
}

export async function saveVisitState(input: {
  projectId: string; visitId: string; trigger: string; facts?: VisitFacts;
  doc?: ScopeDoc | null; manualText?: string | null; text: string;
  changes: unknown[]; input?: unknown;
}): Promise<Visit> {
  const visit = await getVisit(input.projectId, input.visitId);
  const n = await queryOne<{ n: string }>`SELECT COALESCE(MAX(version), 0) AS n FROM drafts WHERE visit_id = ${input.visitId}`;
  const version = Number(n?.n ?? 0) + 1;
  const facts = input.facts ?? visit.facts;
  const doc = input.doc === undefined ? visit.doc : input.doc;
  const manualText = input.manualText === undefined ? visit.manualText : input.manualText;
  const now = nowIso();
  const id = newId("drf");
  await tx([
    tag`UPDATE visits SET facts = ${JSON.stringify(facts)}, doc = ${doc ? JSON.stringify(doc) : null}, manual_text = ${manualText ?? null}, updated_at = ${now} WHERE id = ${input.visitId} AND project_id = ${input.projectId}`,
    tag`INSERT INTO drafts (id, visit_id, project_id, version, trigger, input, changes, facts, doc, manual_text, text, created_at)
      VALUES (${id}, ${input.visitId}, ${input.projectId}, ${version}, ${input.trigger}, ${input.input ? JSON.stringify(input.input) : null}, ${JSON.stringify(input.changes)}, ${JSON.stringify(facts)}, ${doc ? JSON.stringify(doc) : null}, ${manualText ?? null}, ${input.text}, ${now})`,
    tag`UPDATE projects SET updated_at = ${now} WHERE id = ${input.projectId}`,
  ]);
  return getVisit(input.projectId, input.visitId);
}

type DraftRow = {
  id: string; visit_id: string; project_id: string; version: number; trigger: string;
  input: string | null; changes: string; facts: string; doc: string | null;
  manual_text: string | null; text: string; created_at: string;
};
export async function listDrafts(projectId: string, visitId: string): Promise<DraftVersion[]> {
  await getVisit(projectId, visitId);
  const rows = await query<DraftRow>`SELECT * FROM drafts WHERE visit_id = ${visitId} AND project_id = ${projectId} ORDER BY version DESC`;
  return rows.map((r) => ({
    id: r.id, visitId: r.visit_id, projectId: r.project_id, version: r.version, trigger: r.trigger,
    input: j(r.input, null), changes: j(r.changes, []), facts: j<VisitFacts>(r.facts, emptyFacts()),
    doc: r.doc ? (JSON.parse(r.doc) as ScopeDoc) : null, manualText: r.manual_text, text: r.text, createdAt: r.created_at,
  }));
}

export async function getDraftState(projectId: string, visitId: string, draftId: string): Promise<DraftVersion> {
  const drafts = await listDrafts(projectId, visitId);
  const d = drafts.find((x) => x.id === draftId);
  if (!d) throw new NotFound("Draft not found.");
  return d;
}

export async function deleteVisit(projectId: string, id: string): Promise<void> {
  const rows = await query<{ id: string }>`DELETE FROM visits WHERE id = ${id} AND project_id = ${projectId} RETURNING id`;
  if (!rows.length) throw new NotFound("Visit not found.");
  await touchProject(projectId);
}

// ---------------- templates ----------------

export type ChecklistTemplate = { id: string; name: string; visitTypes: VisitType[]; items: string[]; isStarter: boolean; createdAt: string };
type TemplateRow = { id: string; name: string; visit_types: string; items: string; is_starter: number; created_at: string };
function toTemplate(r: TemplateRow): ChecklistTemplate {
  return {
    id: r.id, name: r.name, visitTypes: j<VisitType[]>(r.visit_types, []),
    items: j<string[]>(r.items, []), isStarter: !!r.is_starter, createdAt: r.created_at,
  };
}

export async function listTemplates(): Promise<ChecklistTemplate[]> {
  await ensureStarterTemplates();
  const rows = await query<TemplateRow>`SELECT * FROM checklist_templates ORDER BY is_starter DESC, name ASC`;
  return rows.map(toTemplate);
}

export async function getTemplate(id: string): Promise<ChecklistTemplate> {
  const r = await queryOne<TemplateRow>`SELECT * FROM checklist_templates WHERE id = ${id}`;
  if (!r) throw new NotFound("Template not found.");
  return toTemplate(r);
}

export async function saveTemplate(t: { id?: string; name: string; visitTypes: VisitType[]; items: string[] }): Promise<ChecklistTemplate> {
  if (!t.name.trim()) throw new Error("Template name is required.");
  const id = t.id ?? newId("tpl");
  const now = nowIso();
  await query`INSERT INTO checklist_templates (id, name, visit_types, items, is_starter, created_at)
    VALUES (${id}, ${t.name.trim()}, ${JSON.stringify(t.visitTypes)}, ${JSON.stringify(t.items)}, 0, ${now})
    ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, visit_types = EXCLUDED.visit_types, items = EXCLUDED.items, is_starter = EXCLUDED.is_starter`;
  return getTemplate(id);
}

export async function deleteTemplate(id: string): Promise<void> {
  const rows = await query<{ id: string }>`DELETE FROM checklist_templates WHERE id = ${id} RETURNING id`;
  if (!rows.length) throw new NotFound("Template not found.");
}

const STARTER_TEMPLATES: { name: string; visitTypes: VisitType[]; items: string[] }[] = [
  {
    name: "Final walk-through / completed mitigation",
    visitTypes: ["final"],
    items: [
      "Verify all mitigation equipment removed and work areas clean.",
      "Confirm drying goals met in every affected room (meter readings logged).",
      "Photo-document finished conditions for each room in scope.",
      "Collect customer sign-off and note any remaining concerns.",
    ],
  },
  {
    name: "Reconstruction scope",
    visitTypes: ["reconstruction"],
    items: [
      "Measure each affected room (L \u00d7 W \u00d7 H) and note ceiling type.",
      "List materials to replace vs. restore per room.",
      "Note electrical / plumbing / HVAC impacts.",
      "Photo-document pre-reconstruction conditions.",
    ],
  },
  {
    name: "Contents cleaning scope",
    visitTypes: ["contents"],
    items: [
      "Inventory affected contents by room with condition notes.",
      "Separate cleanable, questionable, and non-restorable items.",
      "Photo-document high-value items before handling.",
      "Record chain of custody for pack-out / storage.",
    ],
  },
  {
    name: "Checklist information",
    visitTypes: ["checklist"],
    items: [
      "Confirm appointment details and site access.",
      "Walk the loss with the customer and note concerns.",
      "Capture overview photos of every affected area.",
      "Summarize next steps before leaving the site.",
    ],
  },
];

export async function ensureStarterTemplates(): Promise<void> {
  const r = await queryOne<{ n: string }>`SELECT COUNT(*) AS n FROM checklist_templates`;
  if (Number(r?.n ?? 0)) return;
  const now = nowIso();
  await Promise.all(
    STARTER_TEMPLATES.map((t) =>
      query`INSERT INTO checklist_templates (id, name, visit_types, items, is_starter, created_at)
        VALUES (${newId("tpl")}, ${t.name}, ${JSON.stringify(t.visitTypes)}, ${JSON.stringify(t.items)}, 1, ${now})`
    )
  );
}

// ---------------- manuals ----------------

export type Manual = {
  id: string; name: string; filename: string; storedPath: string;
  status: string; error: string | null; createdAt: string;
};
type ManualRow = {
  id: string; name: string; filename: string; stored_path: string;
  text: string; rules: string; status: string; error: string | null; created_at: string;
};
function toManual(r: ManualRow): Manual {
  return {
    id: r.id, name: r.name, filename: r.filename, storedPath: r.stored_path,
    status: r.status, error: r.error, createdAt: r.created_at,
  };
}

export async function listManuals(): Promise<Manual[]> {
  const rows = await query<ManualRow>`SELECT id, name, filename, stored_path, status, error, created_at FROM manuals ORDER BY created_at DESC`;
  return rows.map(toManual);
}

export async function getManualText(id: string): Promise<{ name: string; text: string }> {
  const r = await queryOne<{ name: string; text: string }>`SELECT name, text FROM manuals WHERE id = ${id}`;
  if (!r) throw new NotFound("Manual not found.");
  return r;
}

export async function createManual(input: { name: string; filename: string; storedPath: string; text: string }): Promise<Manual> {
  const id = newId("man");
  const now = nowIso();
  await query`INSERT INTO manuals (id, name, filename, stored_path, text, rules, status, created_at)
    VALUES (${id}, ${input.name}, ${input.filename}, ${input.storedPath}, ${input.text}, '[]', 'uploaded', ${now})`;
  const row = await queryOne<ManualRow>`SELECT * FROM manuals WHERE id = ${id}`;
  if (!row) throw new Error("Failed to create manual.");
  return toManual(row);
}

export async function setManualRules(id: string, rules: string[], status: string, error?: string | null): Promise<void> {
  await query`UPDATE manuals SET rules = ${JSON.stringify(rules)}, status = ${status}, error = ${error ?? null} WHERE id = ${id}`;
}

export async function deleteManual(id: string): Promise<void> {
  const r = await queryOne<{ stored_path: string }>`SELECT stored_path FROM manuals WHERE id = ${id}`;
  if (!r) throw new NotFound("Manual not found.");
  await query`DELETE FROM manuals WHERE id = ${id}`;
  await query`DELETE FROM manual_conflicts WHERE manual_ids LIKE ${`%${id}%`}`;
  rmSync(r.stored_path, { force: true });
}

export type ManualConflict = { id: string; description: string; manualIds: string[]; status: string; createdAt: string };
type ConflictRow = { id: string; description: string; manual_ids: string; status: string; created_at: string };
function toConflict(r: ConflictRow): ManualConflict {
  return { id: r.id, description: r.description, manualIds: j<string[]>(r.manual_ids, []), status: r.status, createdAt: r.created_at };
}

export async function listConflicts(): Promise<ManualConflict[]> {
  const rows = await query<ConflictRow>`SELECT * FROM manual_conflicts ORDER BY created_at DESC`;
  return rows.map(toConflict);
}

export async function addConflicts(items: { description: string; manualIds: string[] }[]): Promise<void> {
  const now = nowIso();
  await Promise.all(
    items.map((c) =>
      query`INSERT INTO manual_conflicts (id, description, manual_ids, status, created_at)
        VALUES (${newId("mcf")}, ${c.description}, ${JSON.stringify(c.manualIds)}, 'open', ${now})`
    )
  );
}

export async function resolveConflict(id: string): Promise<void> {
  const rows = await query<{ id: string }>`UPDATE manual_conflicts SET status = 'resolved' WHERE id = ${id} RETURNING id`;
  if (!rows.length) throw new NotFound("Conflict not found.");
}
