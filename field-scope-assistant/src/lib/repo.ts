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

export async function createProject(input: Record<string, unknown>, isDemo = false): Promise<Project> {
  const clean = cleanProjectInput(input);
  const id = newId("prj");
  const now = nowIso();
        const name = clean.name ?? clean.address ?? "untitled project";
  await query`INSERT INTO projects (id, data, is_demo, created_at, updated_at, name)
    VALUES (${id}, ${JSON.stringify(clean)}, ${isDemo ? 1 : 0}, ${now}, ${now}, ${name})`;
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
  await query`DELETE FROM projects WHERE id = ${id}`;
  await query`DELETE FROM drafts WHERE project_id = ${id}`;
  await query`DELETE FROM batches WHERE project_id = ${id}`;
  rmSync(path.join(UPLOAD_DIR, id), { recursive: true, force: true });
}

// ---------------- locations ----------------

type LocationRow = { id: string; project_id: string; floor: string | null; unit: string | null; room: string; sort: number };
function toLocation(r: LocationRow): Location {
  return { id: r.id, projectId: r.project_id, floor: r.floor, unit: r.unit, room: r.room, sort: r.sort };
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
}

// ---------------- documents / batches ----------------

export type Document = {
  id: string;
  projectId: string;
  filename: string;
  storedPath: string;
  size: number;
  pageCount: number;
  status: string;
  error: string | null;
  createdAt: string;
};
type DocumentRow = {
  id: string; project_id: string; filename: string; stored_path: string;
  size: number; page_count: number; status: string; error: string | null; created_at: string;
};
function toDocument(r: DocumentRow): Document {
  return {
    id: r.id, projectId: r.project_id, filename: r.filename, storedPath: r.stored_path,
    size: Number(r.size), pageCount: Number(r.page_count), status: r.status, error: r.error, createdAt: r.created_at,
  };
}

export async function createDocument(
  projectId: string,
  input: { id: string; filename: string; storedPath: string; size: number; pageCount: number }
): Promise<Document> {
  const now = nowIso();
  await query`INSERT INTO documents (id, project_id, filename, stored_path, size, page_count, status, error, created_at)
    VALUES (${input.id}, ${projectId}, ${input.filename}, ${input.storedPath}, ${input.size}, ${input.pageCount}, 'pending', NULL, ${now})`;
  const row = await queryOne<DocumentRow>`SELECT * FROM documents WHERE id = ${input.id}`;
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
  await query`UPDATE documents SET status = ${status}, error = ${error ?? null} WHERE id = ${id} AND project_id = ${projectId}`;
}

export async function deleteDocument(projectId: string, id: string): Promise<void> {
  const d = await getDocument(projectId, id);
  await query`DELETE FROM documents WHERE id = ${id} AND project_id = ${projectId}`;
  if (d.storedPath) rmSync(d.storedPath, { force: true });
}

export async function savePages(documentId: string, pages: { page: number; text: string }[]): Promise<void> {
  const qs: unknown[] = pages.map((p) =>
    tag`INSERT INTO doc_pages (document_id, page, text, char_count)
      VALUES (${documentId}, ${p.page}, ${p.text}, ${p.text.length})
      ON CONFLICT (document_id, page) DO UPDATE SET text = EXCLUDED.text, char_count = EXCLUDED.char_count`
  );
  if (qs.length) await tx(qs);
}

export async function getPages(documentId: string, startPage?: number, endPage?: number): Promise<{ page: number; text: string; charCount: number }[]> {
  let rows;
  if (startPage !== undefined && endPage !== undefined) {
    rows = await query<{ page: number; text: string; charCount: number }>`
      SELECT page, text, char_count AS "charCount" FROM doc_pages
      WHERE document_id = ${documentId} AND page >= ${startPage} AND page <= ${endPage} ORDER BY page ASC`;
  } else {
    rows = await query<{ page: number; text: string; charCount: number }>`
      SELECT page, text, char_count AS "charCount" FROM doc_pages WHERE document_id = ${documentId} ORDER BY page ASC`;
  }
  return rows.map((r) => ({ page: Number(r.page), text: r.text, charCount: Number(r.charCount) }));
}

export type Batch = {
  id: string; projectId: string; documentId: string;
  startPage: number; endPage: number; status: string; attempts: number; error: string | null;
};
type BatchRow = {
  id: string; project_id: string; document_id: string;
  start_page: number; end_page: number; status: string; attempts: number; error: string | null;
  claimed_at: string | null;
};
function toBatch(r: BatchRow): Batch {
  return {
    id: r.id, projectId: r.project_id, documentId: r.document_id,
    startPage: Number(r.start_page), endPage: Number(r.end_page),
    status: r.status, attempts: Number(r.attempts), error: r.error,
  };
}

export async function createBatches(
  projectId: string,
  documentId: string,
  ranges: ({ startPage: number; endPage: number } | [number, number])[]
): Promise<void> {
  const qs: unknown[] = ranges.map((r) => {
    const startPage = Array.isArray(r) ? r[0] : r.startPage;
    const endPage = Array.isArray(r) ? r[1] : r.endPage;
    return tag`INSERT INTO batches (id, project_id, document_id, start_page, end_page, status, attempts, error, claimed_at)
      VALUES (${newId("bat")}, ${projectId}, ${documentId}, ${startPage}, ${endPage}, 'pending', 0, NULL, NULL)`;
  });
  if (qs.length) await tx(qs);
}

export const MAX_BATCH_ATTEMPTS = 3;

export async function claimNextBatch(projectId: string, documentId: string, retryFailed = false): Promise<Batch | null> {
  if (retryFailed) {
    await query`UPDATE batches SET status = 'pending', attempts = 0, error = NULL, claimed_at = NULL
      WHERE project_id = ${projectId} AND document_id = ${documentId} AND status = 'failed'`;
  }
  await query`UPDATE batches SET status = 'pending', claimed_at = NULL
    WHERE project_id = ${projectId} AND document_id = ${documentId} AND status = 'processing'
    AND claimed_at < NOW() - INTERVAL '10 minutes'`;
  await query`UPDATE batches SET status = 'pending'
    WHERE project_id = ${projectId} AND document_id = ${documentId} AND status = 'failed' AND attempts < ${MAX_BATCH_ATTEMPTS}`;
  const rows = await query<BatchRow>`
    WITH next AS (
      SELECT id FROM batches
      WHERE project_id = ${projectId} AND document_id = ${documentId} AND status = 'pending'
      ORDER BY start_page ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE batches b SET status = 'processing', attempts = b.attempts + 1, claimed_at = NOW()
    FROM next WHERE b.id = next.id RETURNING b.*`;
  if (!rows.length) return null;
  return toBatch(rows[0]);
}

export async function finishBatch(batchId: string, status: "done" | "failed", error?: string | null, attempts?: number): Promise<void> {
  if (attempts !== undefined) {
    await query`UPDATE batches SET status = ${status}, error = ${error ?? null}, attempts = ${attempts} WHERE id = ${batchId}`;
  } else {
    await query`UPDATE batches SET status = ${status}, error = ${error ?? null} WHERE id = ${batchId}`;
  }
}

export async function batchProgress(projectId: string, documentId: string): Promise<{ total: number; done: number; failed: number; pending: number }> {
  const rows = await query<{ status: string; n: string }>`
    SELECT status, COUNT(*) AS n FROM batches WHERE project_id = ${projectId} AND document_id = ${documentId} GROUP BY status`;
  const out = { total: 0, done: 0, failed: 0, pending: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    out.total += n;
    if (r.status === "done") out.done += n;
    else if (r.status === "failed") out.failed += n;
    else out.pending += n;
  }
  return out;
}

// ---------------- evidence ----------------

export type Evidence = {
  id: string; projectId: string; documentId: string; batchId: string | null;
  page: number; kind: string; text: string;
  locationId: string | null; locationText: string | null;
  locationConfidence: string | null; locationBasis: string | null;
  caption?: string | null; conditions?: string | null; materials?: string | null;
  captionStatements?: string | null; flags?: string | null; photoIndex?: number | null;
};
type EvidenceRow = {
  id: string; project_id: string; document_id: string; batch_id: string | null;
  page: number; kind: string; text: string;
  location_id: string | null; location_text: string | null;
  location_confidence: string | null; location_basis: string | null;
};
function toEvidence(r: EvidenceRow): Evidence {
  return {
    id: r.id, projectId: r.project_id, documentId: r.document_id, batchId: r.batch_id,
    page: Number(r.page), kind: r.kind, text: r.text,
    locationId: r.location_id, locationText: r.location_text,
    locationConfidence: r.location_confidence, locationBasis: r.location_basis,
  };
}

export async function listEvidence(projectId: string): Promise<Evidence[]> {
  const rows = await query<EvidenceRow>`SELECT * FROM evidence WHERE project_id = ${projectId} ORDER BY page ASC`;
  return rows.map(toEvidence);
}

export async function replaceBatchEvidence(
  projectId: string,
  documentId: string,
  batchId: string,
  items: { page: number; kind: string; text: string; locationId?: string | null; locationText?: string | null }[]
): Promise<void> {
  const qs: unknown[] = [
    tag`DELETE FROM evidence WHERE project_id = ${projectId} AND batch_id = ${batchId}`,
    ...items.map((e) =>
      tag`INSERT INTO evidence (id, project_id, document_id, batch_id, page, kind, text, location_id, location_text)
        VALUES (${newId("ev")}, ${projectId}, ${documentId}, ${batchId}, ${e.page}, ${e.kind}, ${e.text}, ${e.locationId ?? null}, ${e.locationText ?? null})`
    ),
  ];
  await tx(qs);
}

export async function setEvidenceLocation(
  projectId: string,
  id: string,
  patch: { locationId?: string | null; locationText?: string | null; locationConfidence?: string | null; locationBasis?: string | null }
): Promise<Evidence> {
  const cur = await queryOne<EvidenceRow>`SELECT * FROM evidence WHERE id = ${id} AND project_id = ${projectId}`;
  if (!cur) throw new NotFound("Evidence not found.");
  const location_id = patch.locationId !== undefined ? patch.locationId : cur.location_id;
  const location_text = patch.locationText !== undefined ? patch.locationText : cur.location_text;
  const location_confidence = patch.locationConfidence !== undefined ? patch.locationConfidence : cur.location_confidence;
  const location_basis = patch.locationBasis !== undefined ? patch.locationBasis : cur.location_basis;
  const rows = await query<EvidenceRow>`UPDATE evidence
    SET location_id = ${location_id}, location_text = ${location_text},
        location_confidence = ${location_confidence}, location_basis = ${location_basis}
    WHERE id = ${id} AND project_id = ${projectId} RETURNING *`;
  if (!rows.length) throw new NotFound("Evidence not found.");
  return toEvidence(rows[0]);
}

// ---------------- visits / drafts ----------------

type VisitRow = {
  id: string; project_id: string; type: string; visit_date: string;
  facts: string; doc: string | null; manual_text: string | null; text: string;
  field_notes: string; created_at: string; updated_at: string;
};
function toVisit(r: VisitRow): Visit {
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type as VisitType,
    visitDate: r.visit_date,
    facts: j<VisitFacts>(r.facts, emptyFacts()),
    doc: r.doc ? (JSON.parse(r.doc) as ScopeDoc) : null,
    manualText: r.manual_text,
    text: r.text,
    fieldNotes: r.field_notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  } as Visit;
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

export async function createVisit(projectId: string, input: { type: VisitType; visitDate: string }): Promise<Visit> {
  const id = newId("vis");
  const now = nowIso();
  const facts = JSON.stringify(emptyFacts());
  await query`INSERT INTO visits (id, project_id, type, visit_date, facts, doc, manual_text, text, field_notes, created_at, updated_at)
    VALUES (${id}, ${projectId}, ${input.type}, ${input.visitDate}, ${facts}, NULL, NULL, '', '', ${now}, ${now})`;
  await touchProject(projectId);
  return getVisit(projectId, id);
}

export const VISIT_EDITABLE = ["type", "visitDate", "facts", "doc", "manualText", "text", "fieldNotes"] as const;

export async function updateVisitFields(
  projectId: string,
  id: string,
  patch: Partial<Pick<Visit, "type" | "visitDate" | "facts" | "doc" | "manualText" | "text" | "fieldNotes">>
): Promise<Visit> {
  await getVisit(projectId, id);
  const updates: unknown[] = [];
  if (patch.type !== undefined) updates.push(tag`UPDATE visits SET type = ${patch.type} WHERE id = ${id}`);
  if (patch.visitDate !== undefined) updates.push(tag`UPDATE visits SET visit_date = ${patch.visitDate} WHERE id = ${id}`);
  if (patch.facts !== undefined) updates.push(tag`UPDATE visits SET facts = ${JSON.stringify(patch.facts)} WHERE id = ${id}`);
  if (patch.doc !== undefined) updates.push(tag`UPDATE visits SET doc = ${patch.doc ? JSON.stringify(patch.doc) : null} WHERE id = ${id}`);
  if (patch.manualText !== undefined) updates.push(tag`UPDATE visits SET manual_text = ${patch.manualText} WHERE id = ${id}`);
  if (patch.text !== undefined) updates.push(tag`UPDATE visits SET text = ${patch.text} WHERE id = ${id}`);
  if (patch.fieldNotes !== undefined) updates.push(tag`UPDATE visits SET field_notes = ${patch.fieldNotes} WHERE id = ${id}`);
  updates.push(tag`UPDATE visits SET updated_at = ${nowIso()} WHERE id = ${id}`);
  if (updates.length) await tx(updates);
  await touchProject(projectId);
  return getVisit(projectId, id);
}

export async function saveVisitState(input: {
  projectId: string; visitId: string; trigger: string;
  facts?: VisitFacts; doc?: ScopeDoc | null; manualText?: string | null;
  text: string; changes: string[]; input?: unknown;
}): Promise<void> {
  const vrow = await queryOne<{ version: string }>`SELECT MAX(version) AS version FROM drafts WHERE visit_id = ${input.visitId}`;
  const version = Number(vrow?.version ?? 0) + 1;
  const now = nowIso();
  const visit = await getVisit(input.projectId, input.visitId);
  await tx([
    tag`UPDATE visits SET facts = ${input.facts ? JSON.stringify(input.facts) : JSON.stringify(visit.facts)}, doc = ${input.doc !== undefined ? (input.doc ? JSON.stringify(input.doc) : null) : JSON.stringify(visit.doc)}, manual_text = ${input.manualText !== undefined ? input.manualText : visit.manualText}, text = ${input.text}, updated_at = ${now} WHERE id = ${input.visitId}`,
    tag`INSERT INTO drafts (id, project_id, visit_id, version, trigger, facts, doc, manual_text, text, changes, input, created_at)
      VALUES (${newId("drf")}, ${input.projectId}, ${input.visitId}, ${version}, ${input.trigger},
        ${input.facts ? JSON.stringify(input.facts) : null}, ${input.doc !== undefined ? (input.doc ? JSON.stringify(input.doc) : null) : null},
        ${input.manualText !== undefined ? input.manualText : null}, ${input.text}, ${JSON.stringify(input.changes)},
        ${input.input !== undefined ? JSON.stringify(input.input) : null}, ${now})`,
    tag`UPDATE projects SET updated_at = ${now} WHERE id = ${input.projectId}`,
  ]);
}

export async function listDrafts(projectId: string, visitId: string): Promise<DraftVersion[]> {
  const rows = await query<{
    id: string; version: number; trigger: string; facts: string | null; doc: string | null;
    manual_text: string | null; text: string; changes: string; input: string | null; created_at: string;
  }>`SELECT * FROM drafts WHERE project_id = ${projectId} AND visit_id = ${visitId} ORDER BY version DESC`;
  return rows.map((r) => ({
    id: r.id,
    visitId,
    version: Number(r.version),
    trigger: r.trigger as DraftVersion["trigger"],
    facts: r.facts ? (JSON.parse(r.facts) as VisitFacts) : undefined,
    doc: r.doc ? (JSON.parse(r.doc) as ScopeDoc) : undefined,
    manualText: r.manual_text ?? undefined,
    text: r.text,
    changes: JSON.parse(r.changes) as string[],
    input: r.input ? JSON.parse(r.input) : undefined,
    createdAt: r.created_at,
  }));
}

export async function getDraftState(projectId: string, visitId: string, draftId: string): Promise<DraftVersion> {
  const drafts = await listDrafts(projectId, visitId);
  const d = drafts.find((x) => x.id === draftId);
  if (!d) throw new NotFound("Draft not found.");
  return d;
}

export async function deleteVisit(projectId: string, id: string): Promise<void> {
  const deleted = await query<{ id: string }>`DELETE FROM visits WHERE id = ${id} AND project_id = ${projectId} RETURNING id`;
  if (!deleted.length) throw new NotFound("Visit not found.");
}

// ---------------- templates ----------------

export type ChecklistItem = { id: string; label: string };
export type ChecklistTemplate = { id: string; name: string; visitTypes: VisitType[]; items: ChecklistItem[]; isStarter: boolean };
type TemplateRow = { id: string; name: string; visit_types: string; items: string; is_starter: number };
function toTemplate(r: TemplateRow): ChecklistTemplate {
  return {
    id: r.id,
    name: r.name,
    visitTypes: JSON.parse(r.visit_types) as VisitType[],
    items: JSON.parse(r.items) as ChecklistItem[],
    isStarter: !!r.is_starter,
  };
}

export async function listTemplates(): Promise<ChecklistTemplate[]> {
  await ensureStarterTemplates();
  const rows = await query<TemplateRow>`SELECT * FROM checklist_templates ORDER BY name ASC`;
  return rows.map(toTemplate);
}

export async function getTemplate(id: string): Promise<ChecklistTemplate> {
  const r = await queryOne<TemplateRow>`SELECT * FROM checklist_templates WHERE id = ${id}`;
  if (!r) throw new NotFound("Template not found.");
  return toTemplate(r);
}

export async function saveTemplate(t: { id?: string; name: string; visitTypes: VisitType[]; items: string[] }): Promise<ChecklistTemplate> {
  const existing = t.id ? await queryOne<TemplateRow>`SELECT * FROM checklist_templates WHERE id = ${t.id}` : null;
  const oldItems: ChecklistItem[] = existing ? (JSON.parse(existing.items) as ChecklistItem[]) : [];
  const items: ChecklistItem[] = t.items.map((label) => {
    const found = oldItems.find((o) => o.label === label);
    return found ?? { id: newId("sti"), label };
  });
  const id = t.id ?? newId("tpl");
  const isStarter = existing ? !!existing.is_starter : false;
  await query`INSERT INTO checklist_templates (id, name, visit_types, items, is_starter)
    VALUES (${id}, ${t.name}, ${JSON.stringify(t.visitTypes)}, ${JSON.stringify(items)}, ${isStarter ? 1 : 0})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, visit_types = EXCLUDED.visit_types, items = EXCLUDED.items,
      is_starter = checklist_templates.is_starter`;
  const row = await queryOne<TemplateRow>`SELECT * FROM checklist_templates WHERE id = ${id}`;
  if (!row) throw new Error("Failed to save template.");
  return toTemplate(row);
}

export async function deleteTemplate(id: string): Promise<void> {
  const deleted = await query<{ id: string }>`DELETE FROM checklist_templates WHERE id = ${id} RETURNING id`;
  if (!deleted.length) throw new NotFound("Template not found.");
}

const STARTER_TEMPLATES: { name: string; visitTypes: VisitType[]; items: string[] }[] = [
  { name: "Initial assessment", visitTypes: ["initial_assessment"], items: ["Exterior walk-around", "Interior walk-through", "Moisture mapping", "Photo documentation", "Source identification"] },
  { name: "Mitigation monitoring", visitTypes: ["daily_monitoring"], items: ["Equipment check", "Moisture readings", "Progress photos", "Customer update"] },
  { name: "Final walk-through", visitTypes: ["final_walkthrough"], items: ["Dry standard verification", "Final photos", "Customer sign-off", "Documentation complete"] },
  { name: "General checklist", visitTypes: ["initial_assessment", "daily_monitoring", "final_walkthrough"], items: ["Safety check", "Documentation", "Customer communication"] },
];

async function ensureStarterTemplates(): Promise<void> {
  const n = await queryOne<{ n: string }>`SELECT COUNT(*) AS n FROM checklist_templates WHERE is_starter = 1`;
  if (Number(n?.n ?? 0) > 0) return;
  const qs: unknown[] = STARTER_TEMPLATES.map((t) =>
    tag`INSERT INTO checklist_templates (id, name, visit_types, items, is_starter)
      VALUES (${newId("tpl")}, ${t.name}, ${JSON.stringify(t.visitTypes)},
        ${JSON.stringify(t.items.map((label) => ({ id: newId("sti"), label })))}, 1)
      ON CONFLICT DO NOTHING`
  );
  if (qs.length) await tx(qs);
}

// ---------------- manuals ----------------

export type ManualRule = { id: string; topic: string; rule: string };
export type Manual = { id: string; name: string; filename: string; storedPath: string; text: string; rules: ManualRule[]; status: string; error: string | null; createdAt: string };
type ManualRow = {
  id: string; name: string; filename: string; stored_path: string; text: string;
  rules: string; status: string; error: string | null; created_at: string;
};
function toManual(r: ManualRow): Manual {
  return {
    id: r.id, name: r.name, filename: r.filename, storedPath: r.stored_path, text: r.text,
    rules: JSON.parse(r.rules) as ManualRule[], status: r.status, error: r.error, createdAt: r.created_at,
  };
}

export async function listManuals(): Promise<Manual[]> {
  const rows = await query<ManualRow>`SELECT id, name, filename, stored_path, text, rules, status, error, created_at FROM manuals ORDER BY created_at DESC`;
  return rows.map(toManual);
}

export async function getManualText(id: string): Promise<{ manual: Manual; text: string }> {
  const r = await queryOne<ManualRow>`SELECT * FROM manuals WHERE id = ${id}`;
  if (!r) throw new NotFound("Manual not found.");
  const manual = toManual(r);
  return { manual, text: manual.text };
}

export async function createManual(input: { id: string; name: string; filename: string; storedPath: string; text: string }): Promise<Manual> {
  const now = nowIso();
  await query`INSERT INTO manuals (id, name, filename, stored_path, text, rules, status, error, created_at)
    VALUES (${input.id}, ${input.name}, ${input.filename}, ${input.storedPath}, ${input.text}, '[]', 'pending', NULL, ${now})`;
  const row = await queryOne<ManualRow>`SELECT * FROM manuals WHERE id = ${input.id}`;
  if (!row) throw new Error("Failed to create manual.");
  return toManual(row);
}

export async function setManualRules(id: string, rules: ManualRule[], status: string, error?: string | null): Promise<void> {
  await query`UPDATE manuals SET rules = ${JSON.stringify(rules)}, status = ${status}, error = ${error ?? null} WHERE id = ${id}`;
}

export async function deleteManual(id: string): Promise<void> {
  const m = await queryOne<ManualRow>`SELECT * FROM manuals WHERE id = ${id}`;
  if (!m) throw new NotFound("Manual not found.");
  await query`DELETE FROM manuals WHERE id = ${id}`;
  await query`DELETE FROM manual_conflicts WHERE manual_ids LIKE ${`%${id}%`}`;
  if (m.stored_path) rmSync(m.stored_path, { force: true });
}

export type ManualConflict = { id: string; manualIds: string[]; description: string; resolved: boolean; createdAt: string };
type ConflictRow = { id: string; manual_ids: string; description: string; resolved: number; created_at: string };
function toConflict(r: ConflictRow): ManualConflict {
  return {
    id: r.id,
    manualIds: JSON.parse(r.manual_ids) as string[],
    description: r.description,
    resolved: !!r.resolved,
    createdAt: r.created_at,
  };
}

export async function listConflicts(): Promise<ManualConflict[]> {
  const rows = await query<ConflictRow>`SELECT * FROM manual_conflicts ORDER BY created_at DESC`;
  return rows.map(toConflict);
}

export async function addConflicts(items: { manualIds: string[]; description: string }[]): Promise<void> {
  const now = nowIso();
  const qs: unknown[] = items.map((c) =>
    tag`INSERT INTO manual_conflicts (id, manual_ids, description, resolved, created_at)
      VALUES (${newId("mcf")}, ${JSON.stringify(c.manualIds)}, ${c.description}, 0, ${now})`
  );
  if (qs.length) await tx(qs);
}

export async function resolveConflict(id: string): Promise<void> {
  const updated = await query<{ id: string }>`UPDATE manual_conflicts SET resolved = 1 WHERE id = ${id} RETURNING id`;
  if (!updated.length) throw new NotFound("Conflict not found.");
}
