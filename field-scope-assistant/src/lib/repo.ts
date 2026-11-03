import { query, queryOne, tag, tx } from "./db";
import { deleteFile, deleteProjectFiles } from "./storage";
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
  await deleteProjectFiles(id);
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

export type BatchProgress = { total: number; done: number; failed: number; pending: number; errors: string[] };

/** Pages counted as having selectable text (same threshold as the scanned-page check). */
export const TEXT_PAGE_MIN_CHARS = 25;

/**
 * Documents with AI-analysis batch progress and text-extraction results. Text
 * extraction runs at upload and needs no AI key; `progress` is the AI photo analysis.
 */
export async function listDocuments(
  projectId: string,
): Promise<(Document & { progress: BatchProgress; textPages: number; extractedPages: number })[]> {
  const rows = await query<DocumentRow>`SELECT * FROM documents WHERE project_id = ${projectId} ORDER BY created_at DESC`;
  return Promise.all(
    rows.map(async (r) => {
      const t = await queryOne<{ total: string; with_text: string }>`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE length(regexp_replace(text, '[[:space:]]', '', 'g')) >= ${TEXT_PAGE_MIN_CHARS}) AS with_text
        FROM doc_pages WHERE document_id = ${r.id}`;
      return {
        ...toDocument(r),
        progress: await batchProgress(projectId, r.id),
        extractedPages: Number(t?.total ?? 0),
        textPages: Number(t?.with_text ?? 0),
      };
    }),
  );
}

export async function setDocumentStatus(projectId: string, id: string, status: string, error?: string | null): Promise<void> {
  await query`UPDATE documents SET status = ${status}, error = ${error ?? null} WHERE id = ${id} AND project_id = ${projectId}`;
}

export async function deleteDocument(projectId: string, id: string): Promise<void> {
  const d = await getDocument(projectId, id);
  await query`DELETE FROM documents WHERE id = ${id} AND project_id = ${projectId}`;
  await deleteFile(d.storedPath);
}

export async function savePages(documentId: string, pages: { page: number; text: string }[]): Promise<void> {
  const qs = pages.map((p) =>
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
  const qs = ranges.map((r) => {
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
  // claimed_at is a TEXT ISO timestamp; ISO strings compare correctly as text.
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await query`UPDATE batches SET status = 'pending', claimed_at = NULL
    WHERE project_id = ${projectId} AND document_id = ${documentId} AND status = 'processing'
    AND (claimed_at IS NULL OR claimed_at < ${staleBefore})`;
  await query`UPDATE batches SET status = 'pending'
    WHERE project_id = ${projectId} AND document_id = ${documentId} AND status = 'failed' AND attempts < ${MAX_BATCH_ATTEMPTS}`;
  const rows = await query<BatchRow>`
    WITH next AS (
      SELECT id FROM batches
      WHERE project_id = ${projectId} AND document_id = ${documentId} AND status = 'pending'
      ORDER BY start_page ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE batches b SET status = 'processing', attempts = b.attempts + 1, claimed_at = ${nowIso()}
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

export async function batchProgress(projectId: string, documentId: string): Promise<BatchProgress> {
  const rows = await query<{ status: string; n: string }>`
    SELECT status, COUNT(*) AS n FROM batches WHERE project_id = ${projectId} AND document_id = ${documentId} GROUP BY status`;
  const errRows = await query<{ start_page: number; end_page: number; error: string }>`
    SELECT start_page, end_page, error FROM batches
    WHERE project_id = ${projectId} AND document_id = ${documentId} AND status = 'failed' AND error IS NOT NULL
    ORDER BY start_page`;
  const out: BatchProgress = {
    total: 0, done: 0, failed: 0, pending: 0,
    errors: errRows.map((r) => `Pages ${r.start_page}–${r.end_page}: ${r.error}`),
  };
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

/** One photo (or unreadable page) read from a CompanyCam report, with its caption kept attached. */
export type Evidence = {
  id: string; projectId: string; documentId: string; batchId: string | null;
  page: number; photoIndex: number;
  caption: string | null; captionSource: string | null;
  locationId: string | null; locationText: string | null;
  locationConfidence: string | null; locationBasis: string | null;
  materials: string[]; conditions: string[]; captionStatements: string[]; flags: string[];
  readable: boolean;
};
export type EvidenceInput = Omit<Evidence, "id" | "projectId" | "documentId" | "batchId">;

type EvidenceRow = {
  id: string; project_id: string; document_id: string; batch_id: string | null;
  page: number; photo_index: number | null; caption: string | null; caption_source: string | null;
  kind: string; text: string;
  location_id: string | null; location_text: string | null;
  location_confidence: string | null; location_basis: string | null;
  materials: string | null; conditions: string | null; caption_statements: string | null; flags: string | null;
  readable: number | null;
};
function toEvidence(r: EvidenceRow): Evidence {
  return {
    id: r.id, projectId: r.project_id, documentId: r.document_id, batchId: r.batch_id,
    page: Number(r.page), photoIndex: Number(r.photo_index ?? 0),
    // rows written before the column existed kept the caption in `text`
    caption: r.caption ?? (r.text || null), captionSource: r.caption_source,
    locationId: r.location_id, locationText: r.location_text,
    locationConfidence: r.location_confidence, locationBasis: r.location_basis,
    materials: j<string[]>(r.materials, []), conditions: j<string[]>(r.conditions, []),
    captionStatements: j<string[]>(r.caption_statements, []), flags: j<string[]>(r.flags, []),
    readable: r.readable == null ? true : !!Number(r.readable),
  };
}

export async function listEvidence(projectId: string): Promise<Evidence[]> {
  const rows = await query<EvidenceRow>`SELECT * FROM evidence WHERE project_id = ${projectId}
    ORDER BY document_id, page ASC, photo_index ASC`;
  return rows.map(toEvidence);
}

/** Replaces the evidence for one batch (idempotent, so a retried batch never duplicates rows). */
export async function replaceBatchEvidence(projectId: string, documentId: string, batchId: string, items: EvidenceInput[]): Promise<void> {
  await getDocument(projectId, documentId);
  const now = nowIso();
  await tx([
    tag`DELETE FROM evidence WHERE project_id = ${projectId} AND batch_id = ${batchId}`,
    ...items.map(
      (e) => tag`INSERT INTO evidence (id, project_id, document_id, batch_id, page, photo_index, kind, text, caption, caption_source,
          location_id, location_text, location_confidence, location_basis, materials, conditions, caption_statements, flags, readable, created_at)
        VALUES (${newId("ev")}, ${projectId}, ${documentId}, ${batchId}, ${e.page}, ${e.photoIndex}, 'photo', ${e.caption ?? ""},
          ${e.caption}, ${e.captionSource}, ${e.locationId}, ${e.locationText}, ${e.locationConfidence}, ${e.locationBasis},
          ${JSON.stringify(e.materials)}, ${JSON.stringify(e.conditions)}, ${JSON.stringify(e.captionStatements)},
          ${JSON.stringify(e.flags)}, ${e.readable ? 1 : 0}, ${now})`,
    ),
  ]);
}

/** PM reassigns a photo's room. The room must belong to the same project. */
export async function setEvidenceLocation(projectId: string, id: string, patch: { locationId: string | null }): Promise<Evidence> {
  if (patch.locationId) {
    const loc = await queryOne<{ id: string }>`SELECT id FROM locations WHERE id = ${patch.locationId} AND project_id = ${projectId}`;
    if (!loc) throw new NotFound("Room not found.");
  }
  const rows = await query<EvidenceRow>`UPDATE evidence
    SET location_id = ${patch.locationId}, location_confidence = 'confirmed', location_basis = 'pm'
    WHERE id = ${id} AND project_id = ${projectId} RETURNING *`;
  if (!rows.length) throw new NotFound("Evidence not found.");
  return toEvidence(rows[0]);
}

// ---------------- visits / drafts ----------------

type VisitRow = {
  id: string; project_id: string; type: string; visit_date: string;
  appointment_time: string | null; arrival_time: string | null; departure_time: string | null; access_outcome: string | null;
  facts: string; doc: string | null; manual_text: string | null; text: string;
  field_notes: string; created_at: string; updated_at: string;
};
function toVisit(r: VisitRow): Visit {
  // Validate with defaults so a partial/legacy facts blob can never crash rendering.
  const parsed = VisitFacts.safeParse(j<unknown>(r.facts, {}));
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type as VisitType,
    visitDate: r.visit_date,
    appointmentTime: r.appointment_time ?? null,
    arrivalTime: r.arrival_time ?? null,
    departureTime: r.departure_time ?? null,
    accessOutcome: r.access_outcome ?? null,
    facts: parsed.success ? parsed.data : emptyFacts(),
    doc: j<ScopeDoc | null>(r.doc, null),
    manualText: r.manual_text,
    text: r.text ?? "",
    fieldNotes: r.field_notes ?? "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Visits oldest → newest. History, carry-forward and the final summary depend on this order. */
export async function listVisits(projectId: string): Promise<Visit[]> {
  const rows = await query<VisitRow>`SELECT * FROM visits WHERE project_id = ${projectId} ORDER BY visit_date ASC, created_at ASC`;
  return rows.map(toVisit);
}

export async function getVisit(projectId: string, id: string): Promise<Visit> {
  const r = await queryOne<VisitRow>`SELECT * FROM visits WHERE id = ${id} AND project_id = ${projectId}`;
  if (!r) throw new NotFound("Visit not found.");
  return toVisit(r);
}

/**
 * New visits start blank: appointment/arrival/departure times and access outcome
 * are never copied from an earlier visit.
 */
export async function createVisit(
  projectId: string,
  input: { type: VisitType; visitDate: string; appointmentTime?: string | null },
): Promise<Visit> {
  await getProject(projectId);
  const id = newId("vis");
  const now = nowIso();
  const facts = JSON.stringify(emptyFacts());
  await query`INSERT INTO visits (id, project_id, type, visit_date, appointment_time, arrival_time, departure_time, access_outcome,
      facts, doc, manual_text, text, field_notes, created_at, updated_at)
    VALUES (${id}, ${projectId}, ${input.type}, ${input.visitDate}, ${input.appointmentTime ?? null}, NULL, NULL, NULL,
      ${facts}, NULL, NULL, '', '', ${now}, ${now})`;
  await touchProject(projectId);
  return getVisit(projectId, id);
}

/**
 * Fields a PM can edit directly through PATCH /visits/:id, mapped to columns.
 * (This must be an object: the route iterates its keys. When it was an array,
 * Object.keys() returned "0","1",… so every PATCH — including field notes —
 * silently saved nothing.)
 */
export const VISIT_EDITABLE = {
  type: "type",
  visitDate: "visit_date",
  appointmentTime: "appointment_time",
  arrivalTime: "arrival_time",
  departureTime: "departure_time",
  accessOutcome: "access_outcome",
  fieldNotes: "field_notes",
} as const;
export type VisitEditableField = keyof typeof VISIT_EDITABLE;

export async function updateVisitFields(
  projectId: string,
  id: string,
  patch: Partial<Record<VisitEditableField, string | null>>,
): Promise<Visit> {
  await getVisit(projectId, id);
  const v = (k: VisitEditableField) => {
    const x = patch[k];
    if (k === "fieldNotes") return x ?? "";
    return x == null || String(x).trim() === "" ? null : String(x);
  };
  const updates = [];
  if (patch.type !== undefined && patch.type) updates.push(tag`UPDATE visits SET type = ${patch.type} WHERE id = ${id} AND project_id = ${projectId}`);
  if (patch.visitDate !== undefined && patch.visitDate)
    updates.push(tag`UPDATE visits SET visit_date = ${patch.visitDate} WHERE id = ${id} AND project_id = ${projectId}`);
  if (patch.appointmentTime !== undefined)
    updates.push(tag`UPDATE visits SET appointment_time = ${v("appointmentTime")} WHERE id = ${id} AND project_id = ${projectId}`);
  if (patch.arrivalTime !== undefined)
    updates.push(tag`UPDATE visits SET arrival_time = ${v("arrivalTime")} WHERE id = ${id} AND project_id = ${projectId}`);
  if (patch.departureTime !== undefined)
    updates.push(tag`UPDATE visits SET departure_time = ${v("departureTime")} WHERE id = ${id} AND project_id = ${projectId}`);
  if (patch.accessOutcome !== undefined)
    updates.push(tag`UPDATE visits SET access_outcome = ${v("accessOutcome")} WHERE id = ${id} AND project_id = ${projectId}`);
  if (patch.fieldNotes !== undefined)
    updates.push(tag`UPDATE visits SET field_notes = ${v("fieldNotes")} WHERE id = ${id} AND project_id = ${projectId}`);
  if (updates.length) {
    updates.push(tag`UPDATE visits SET updated_at = ${nowIso()} WHERE id = ${id} AND project_id = ${projectId}`);
    await tx(updates);
    await touchProject(projectId);
  }
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
  const qs = STARTER_TEMPLATES.map((t) =>
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
  await deleteFile(m.stored_path);
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
  const rows = await query<ConflictRow>`SELECT * FROM manual_conflicts WHERE resolved = 0 ORDER BY created_at DESC`;
  return rows.map(toConflict);
}

export async function addConflicts(items: { manualIds: string[]; description: string }[]): Promise<void> {
  const now = nowIso();
  const qs = items.map((c) =>
    tag`INSERT INTO manual_conflicts (id, manual_ids, description, resolved, created_at)
      VALUES (${newId("mcf")}, ${JSON.stringify(c.manualIds)}, ${c.description}, 0, ${now})`
  );
  if (qs.length) await tx(qs);
}

export async function resolveConflict(id: string): Promise<void> {
  const updated = await query<{ id: string }>`UPDATE manual_conflicts SET resolved = 1 WHERE id = ${id} RETURNING id`;
  if (!updated.length) throw new NotFound("Conflict not found.");
}
