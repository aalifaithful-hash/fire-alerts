import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UPLOAD_DIR } from "./db";
import { newId } from "./ids";
import { fullLabel, norm, resolveLocation } from "./locations";
import { applyGuards } from "./guards";
import { applyOps } from "./patch";
import { buildChunk, extractPageTexts, isPdf, MAX_CHUNK_BYTES, planBatches, SCANNED_THRESHOLD } from "./pdf";
import { docToText, renderDoc } from "./render";
import * as repo from "./repo";
import {
  CATEGORIES,
  ITEM_STATUSES,
  VISIT_TYPE_LABELS,
  type Category,
  type ChecklistStatus,
  type ItemStatus,
  type Location,
  type ScopeDoc,
  type VisitFacts,
  type VisitType,
} from "./schemas";
import { todayNY, weekdayNY } from "./time";
import type { DraftVersion, Project, Visit } from "./types";
import { structured, type ContentBlock } from "./ai/client";
import { AnalysisOutput, ChecklistOutput, CorrectionOutput, ManualRulesOutput, PdfBatchOutput } from "./ai/schemas";
import { CHECKLIST_SYSTEM, CORRECTION_SYSTEM, MANUAL_SYSTEM, PDF_SYSTEM, visitSystem } from "./ai/prompts";

export class UserError extends Error {}

// =====================================================================
// PDF ingestion & batch processing
// =====================================================================

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export async function ingestPdf(projectId: string, file: { name: string; bytes: Uint8Array }) {
  repo.getProject(projectId);
  if (!isPdf(file.bytes)) throw new UserError("That file is not a PDF.");
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw new UserError("PDF is larger than 200 MB.");
  const id = newId("doc");
  const dir = path.join(UPLOAD_DIR, projectId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const storedPath = path.join(dir, `${id}.pdf`);
  writeFileSync(storedPath, file.bytes, { mode: 0o600 });

  let pages: string[] = [];
  let extractError: string | null = null;
  try {
    pages = await extractPageTexts(file.bytes);
  } catch {
    extractError = "Selectable text could not be read; pages will be read visually.";
  }
  let pageCount = pages.length;
  if (!pageCount) {
    const { PDFDocument } = await import("pdf-lib");
    pageCount = (await PDFDocument.load(file.bytes, { ignoreEncryption: true })).getPageCount();
    pages = Array(pageCount).fill("");
  }
  const doc = repo.createDocument(projectId, { id, filename: file.name.slice(0, 200), storedPath, size: file.bytes.length, pageCount });
  repo.savePages(id, pages);
  repo.createBatches(projectId, id, planBatches(pageCount));
  repo.setDocumentStatus(projectId, id, "processing", extractError);
  const scanned = pages.filter((t) => t.replace(/\s/g, "").length < SCANNED_THRESHOLD).length;
  return { ...doc, scannedPages: scanned };
}

/**
 * Processes one batch of pages. The client calls this repeatedly (with progress
 * shown) until nothing is left; failures are retried up to MAX_BATCH_ATTEMPTS and
 * interrupted batches are picked up again automatically.
 */
export async function processNextBatch(projectId: string, documentId: string, retryFailed = false) {
  const doc = repo.getDocument(projectId, documentId);
  const batch = repo.claimNextBatch(projectId, documentId, retryFailed);
  if (!batch) {
    const p = repo.batchProgress(projectId, documentId);
    repo.setDocumentStatus(projectId, documentId, p.failed ? "partial" : "done", p.failed ? `${p.failed} batch(es) failed` : null);
    return { done: true, progress: p };
  }
  try {
    const source = new Uint8Array(readFileSync(doc.storedPath));
    const chunk = await buildChunk(source, batch.startPage, batch.endPage);
    if (chunk.length > MAX_CHUNK_BYTES) {
      if (batch.endPage > batch.startPage) {
        // split oversized batch into single pages
        repo.finishBatch(batch.id, true, "split into single pages", batch.attempts);
        repo.createBatches(
          projectId,
          documentId,
          Array.from({ length: batch.endPage - batch.startPage + 1 }, (_, i) => [batch.startPage + i, batch.startPage + i] as [number, number]),
        );
        return { done: false, progress: repo.batchProgress(projectId, documentId) };
      }
      throw new UserError("Page is too large to analyze (over 18 MB).");
    }
    const pages = repo.getPages(projectId, documentId, batch.startPage, batch.endPage);
    const locations = repo.listLocations(projectId);
    const pageText = pages
      .map((p) =>
        p.charCount < SCANNED_THRESHOLD
          ? `<pdf_text page="${p.page}">[no selectable text — scanned page; read it from the image]</pdf_text>`
          : `<pdf_text page="${p.page}">\n${p.text.slice(0, 20000)}\n</pdf_text>`,
      )
      .join("\n");
    const content: ContentBlock[] = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(chunk).toString("base64") } },
      {
        type: "text",
        text: `This PDF chunk contains ORIGINAL pages ${batch.startPage}–${batch.endPage} of "${doc.filename}". Chunk page 1 = original page ${batch.startPage}. Report original page numbers.

Known rooms in this project (reuse these names when they match):
${locations.map((l) => `- ${fullLabel(l)}`).join("\n") || "- none yet"}

Selectable text extracted from these pages:
<pdf_evidence>
${pageText}
</pdf_evidence>`,
      },
    ];
    const out = await structured({ schema: PdfBatchOutput, system: PDF_SYSTEM, content, effort: "medium", maxTokens: 32000 });
    saveBatchEvidence(projectId, documentId, batch, out);
    repo.finishBatch(batch.id, true, null, batch.attempts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const retryable = !(e instanceof UserError) && (e as { retryable?: boolean }).retryable !== false;
    repo.finishBatch(batch.id, false, msg.slice(0, 300), retryable ? batch.attempts : 99);
    return { done: false, progress: repo.batchProgress(projectId, documentId), error: msg };
  }
  return { done: false, progress: repo.batchProgress(projectId, documentId) };
}

export function saveBatchEvidence(projectId: string, documentId: string, batch: repo.Batch, out: PdfBatchOutput) {
  const locations = repo.listLocations(projectId);
  const rows: Parameters<typeof repo.replaceBatchEvidence>[3] = [];
  for (const page of out.pages) {
    if (page.page < batch.startPage || page.page > batch.endPage) continue; // ignore out-of-range claims
    if (!page.readable || !page.photos.length) {
      if (!page.readable)
        rows.push({
          page: page.page, photoIndex: 0, caption: null, captionSource: "none", locationId: null, locationText: null,
          locationConfidence: "low", locationBasis: "none", materials: [], conditions: [], captionStatements: [],
          flags: [`Unreadable page${page.issue ? `: ${page.issue}` : ""}`], readable: false,
        });
      continue;
    }
    for (const ph of page.photos) {
      const flags = [...ph.flags];
      let locationId: string | null = null;
      const label = [ph.floor, ph.unit, ph.room].filter(Boolean).join(" / ") || null;
      if (ph.room && ph.locationConfidence !== "low") {
        const r = resolveLocation({ floor: ph.floor, unit: ph.unit, room: ph.room }, locations);
        if (r.kind === "existing") locationId = r.location.id;
        else if (r.kind === "new") {
          const loc = repo.insertLocation(projectId, { floor: r.floor, unit: r.unit, room: r.room });
          locations.push(loc);
          locationId = loc.id;
        } else if (r.kind === "ambiguous") flags.push(`Room unclear: ${r.candidates.map(fullLabel).join(" or ")}`);
      } else if (ph.room) flags.push("Uncertain room assignment");
      else flags.push("No room label");
      rows.push({
        page: page.page,
        photoIndex: ph.index,
        caption: ph.caption,
        captionSource: ph.captionSource,
        locationId,
        locationText: label,
        locationConfidence: ph.locationConfidence,
        locationBasis: ph.locationBasis,
        materials: ph.materials,
        conditions: ph.visibleConditions,
        captionStatements: ph.captionStatements,
        flags,
        readable: true,
      });
    }
  }
  repo.replaceBatchEvidence(projectId, documentId, batch.id, rows);
}

// =====================================================================
// Visit context (strictly scoped to one project)
// =====================================================================

export interface VisitContext {
  project: Project;
  visit: Visit;
  locations: Location[];
  evidence: repo.Evidence[];
  prior: Visit[];
  pmText: string;
  corpusText: string;
  rules: { manual: string; topic: string; rule: string }[];
  conflicts: string[];
}

export function correctionInputs(projectId: string, visitId: string): string[] {
  return repo
    .listDrafts(projectId, visitId)
    .filter((d) => d.trigger === "correction" && d.input)
    .reverse()
    .map((d) => d.input as string);
}

export function buildContext(projectId: string, visitId: string): VisitContext {
  const project = repo.getProject(projectId);
  const visit = repo.getVisit(projectId, visitId);
  const all = repo.listVisits(projectId);
  const idx = all.findIndex((v) => v.id === visitId);
  const prior = all.slice(0, idx).filter((v) => v.visitDate <= visit.visitDate);
  const locations = repo.listLocations(projectId);
  const evidence = repo.listEvidence(projectId);
  const answers = visit.facts.questions.filter((q) => q.status === "answered").map((q) => `${q.text} — ${q.answer}`);
  const pmText = [visit.fieldNotes, ...correctionInputs(projectId, visitId), ...answers].filter(Boolean).join("\n");
  const corpusText = [
    pmText,
    JSON.stringify(project),
    ...locations.map(fullLabel),
    ...evidence.flatMap((e) => [e.caption ?? "", ...e.captionStatements]),
    ...prior.flatMap((v) => [v.fieldNotes, ...v.facts.items.map((i) => `${i.text} ${i.quantity ?? ""}`), ...v.facts.equipment.map((e) => String(e.quantity ?? ""))]),
  ].join("\n");
  const rules = repo
    .listManuals()
    .flatMap((m) => m.rules.map((r) => ({ manual: m.name, topic: r.topic, rule: r.rule, id: r.id })));
  const conflicts = repo.listConflicts().map((c) => c.description);
  return { project, visit, locations, evidence, prior, pmText, corpusText, rules, conflicts };
}

function compactFacts(f: VisitFacts, locations: Location[]) {
  const lbl = (id: string | null) => (id ? (locations.find((l) => l.id === id) ? fullLabel(locations.find((l) => l.id === id)!) : "?") : "project-wide");
  return {
    jobInfo: f.jobInfo,
    directives: f.directives,
    items: f.items.map((i) => ({ id: i.id, room: lbl(i.locationId), roomId: i.locationId, category: i.category, text: i.text, status: i.status, source: i.source, quantity: i.quantity, carriedForward: i.carriedForward })),
    equipment: f.equipment.map((e) => ({ id: e.id, room: lbl(e.locationId), roomId: e.locationId, type: e.type, label: e.label, quantity: e.quantity, status: e.status, statusDate: e.statusDate, source: e.source })),
    questions: f.questions.map((q) => ({ id: q.id, text: q.text, status: q.status, answer: q.answer })),
    recommendations: f.recommendations.map((r) => ({ text: r.text, status: r.status })),
  };
}

function contextBlock(ctx: VisitContext, opts: { evidence: boolean }): string {
  const p = ctx.project;
  const v = ctx.visit;
  const project = Object.fromEntries(
    Object.entries(p).filter(([k, val]) => val != null && val !== "" && !["id", "createdAt", "updatedAt", "isDemo"].includes(k)),
  );
  const parts: string[] = [];
  parts.push(`Today: ${weekdayNY()} ${todayNY()} (America/New_York).`);
  parts.push(`<project_record>\n${JSON.stringify(project, null, 1)}\n</project_record>`);
  parts.push(
    `<rooms>\n${ctx.locations.map((l) => `${l.id}: ${fullLabel(l)}`).join("\n") || "(none yet)"}\n</rooms>`,
  );
  if (opts.evidence && ctx.evidence.length) {
    const lines = ctx.evidence.map((e) =>
      JSON.stringify({
        id: e.id,
        page: e.page,
        photo: e.photoIndex,
        roomId: e.locationId,
        label: e.locationText,
        caption: e.caption,
        visible: e.conditions,
        materials: e.materials,
        captionSays: e.captionStatements,
        flags: e.flags,
      }),
    );
    parts.push(`<photo_evidence>\n${lines.join("\n")}\n</photo_evidence>`);
  }
  if (ctx.prior.length) {
    const recent = ctx.prior.slice(-8);
    parts.push(
      `<prior_visits>\n${recent
        .map((pv) => JSON.stringify({ visitId: pv.id, date: pv.visitDate, type: VISIT_TYPE_LABELS[pv.type], accessOutcome: pv.accessOutcome, notes: pv.fieldNotes, facts: compactFacts(pv.facts, ctx.locations) }))
        .join("\n")}\n</prior_visits>`,
    );
  }
  if (ctx.rules.length) {
    parts.push(
      `<company_rules>\n${ctx.rules.map((r) => `- [${r.manual} / ${r.topic}] ${r.rule}`).join("\n")}\n</company_rules>` +
        (ctx.conflicts.length
          ? `\n<rule_conflicts>\nThese company rules conflict; do not apply either side silently — raise a question if it matters:\n${ctx.conflicts.map((c) => `- ${c}`).join("\n")}\n</rule_conflicts>`
          : ""),
    );
  }
  parts.push(
    `<current_visit>\n${JSON.stringify({
      type: VISIT_TYPE_LABELS[v.type],
      date: v.visitDate,
      appointmentTime: v.appointmentTime,
      arrivalTime: v.arrivalTime,
      departureTime: v.departureTime,
      accessOutcome: v.accessOutcome,
    })}\n</current_visit>`,
  );
  parts.push(`<current_record>\n${JSON.stringify(compactFacts(v.facts, ctx.locations))}\n</current_record>`);
  return parts.join("\n\n");
}

// =====================================================================
// Commit / render
// =====================================================================

export function renderVisit(projectId: string, visit: Visit, facts: VisitFacts): ScopeDoc {
  const project = repo.getProject(projectId);
  const all = repo.listVisits(projectId);
  const idx = all.findIndex((v) => v.id === visit.id);
  const history = all
    .slice(0, idx < 0 ? all.length : idx)
    .filter((v) => v.visitDate <= visit.visitDate)
    .map((v) => ({ visitDate: v.visitDate, type: v.type, facts: v.facts }));
  return renderDoc({ project, visit, facts, locations: repo.listLocations(projectId), history });
}

export function commit(
  projectId: string,
  visitId: string,
  facts: VisitFacts,
  version: { trigger: DraftVersion["trigger"]; input: string | null; changes: string[] },
  manualText: string | null = null,
) {
  const visit = repo.getVisit(projectId, visitId);
  const doc = renderVisit(projectId, visit, facts);
  const text = manualText ?? docToText(doc);
  const changes = [...version.changes];
  if (visit.manualText && manualText == null && version.trigger !== "manual_edit")
    changes.push("Your free-text edits were replaced by the updated scope (restore the previous version to get them back).");
  return repo.saveVisitState(projectId, visitId, { facts, doc, manualText, text }, { ...version, changes });
}

// =====================================================================
// Visit analysis
// =====================================================================

export async function generateVisit(projectId: string, visitId: string) {
  const ctx = buildContext(projectId, visitId);
  if (!ctx.visit.fieldNotes.trim() && !ctx.evidence.length)
    throw new UserError("Add field notes or upload a CompanyCam PDF first.");
  const content: ContentBlock[] = [
    {
      type: "text",
      text: `${contextBlock(ctx, { evidence: true })}

<pm_field_notes>
${ctx.visit.fieldNotes || "(no notes for this visit)"}
</pm_field_notes>
${correctionInputs(projectId, visitId).length ? `\n<pm_corrections_so_far>\n${correctionInputs(projectId, visitId).join("\n")}\n</pm_corrections_so_far>` : ""}

Produce the structured facts for this visit.`,
    },
  ];
  const out = await structured({ schema: AnalysisOutput, system: visitSystem(ctx.visit.type), content, effort: "high", maxTokens: 48000 });
  const facts = analysisToFacts(projectId, ctx, out);
  const prev = ctx.prior.at(-1)?.facts ?? null;
  const { facts: guarded } = applyGuards(facts, { pmText: ctx.pmText, corpusText: ctx.corpusText, previousFacts: prev, priorFacts: ctx.prior.map((v) => v.facts) });
  syncProjectFromJob(projectId, guarded);
  const draft = commit(projectId, visitId, guarded, { trigger: "generate", input: null, changes: ["Draft generated from notes and evidence."] });
  return { draft };
}

export function analysisToFacts(projectId: string, ctx: Pick<VisitContext, "locations" | "visit" | "evidence">, out: AnalysisOutput): VisitFacts {
  const existing = ctx.visit.facts;
  const locations = [...ctx.locations];
  const validEvidence = new Set(ctx.evidence.map((e) => e.id)); // project-scoped
  const questions = existing.questions.filter((q) => q.status !== "open");
  const addQuestion = (text: string, reason: string | null, locationId: string | null) => {
    if (questions.some((q) => norm(q.text) === norm(text))) return;
    questions.push({ id: newId("q"), text, reason, locationId, status: "open", answer: null });
  };

  const place = (ref: { locationId: string | null; floor: string | null; unit: string | null; room: string | null }) => {
    if (!ref.room && !ref.locationId) return { locationId: null, needsLocation: false };
    const r = resolveLocation(ref, locations);
    if (r.kind === "existing") return { locationId: r.location.id, needsLocation: false };
    if (r.kind === "new") {
      const loc = repo.insertLocation(projectId, { floor: r.floor, unit: r.unit, room: r.room });
      locations.push(loc);
      return { locationId: loc.id, needsLocation: false };
    }
    if (r.kind === "ambiguous") {
      addQuestion(`Which ${ref.room}? ${r.candidates.map(fullLabel).join(" or ")}`, "Same room name exists in more than one unit.", null);
      return { locationId: null, needsLocation: true };
    }
    return { locationId: null, needsLocation: !!ref.room };
  };

  const items: VisitFacts["items"] = out.items.map((i) => {
    const prior = i.existingItemId ? existing.items.find((x) => x.id === i.existingItemId) : undefined;
    const { locationId, needsLocation } = place(i);
    return {
      id: prior?.id ?? newId("it"),
      locationId,
      needsLocation,
      category: i.category,
      text: i.text,
      status: i.status,
      source: i.source,
      evidenceIds: i.evidenceIds.filter((id) => validEvidence.has(id)),
      carriedForward: i.carriedForward,
      carriedFromVisitId: i.carriedFromVisitId,
      quantity: i.quantity,
      flags: [],
    };
  });
  // Explicit PM decisions (direct edits, accepted recommendations) are never dropped by a regenerate.
  for (const keep of existing.items.filter((x) => x.source === "manual_edit" || x.source === "pm_accepted"))
    if (!items.some((x) => x.id === keep.id)) items.push(keep);

  const equipment = out.equipment.map((e) => {
    const prior = e.existingEquipmentId ? existing.equipment.find((x) => x.id === e.existingEquipmentId) : undefined;
    return {
      id: prior?.id ?? newId("eq"),
      locationId: place(e).locationId,
      type: e.type,
      label: e.label,
      quantity: e.quantity,
      status: e.status,
      statusDate: e.statusDate,
      source: e.source,
      carriedForward: e.carriedForward,
      flags: [],
    };
  });

  for (const q of out.questions.slice(0, 5))
    addQuestion(q.text, q.reason, q.locationId && locations.some((l) => l.id === q.locationId) ? q.locationId : null);

  const decided = existing.recommendations.filter((r) => r.status !== "pending");
  const recommendations = [
    ...decided,
    ...out.recommendations
      .filter((r) => !decided.some((d) => norm(d.text) === norm(r.text)))
      .map((r) => ({ id: newId("rec"), locationId: place(r).locationId, category: r.category, text: r.text, rationale: r.rationale, status: "pending" as const })),
  ];

  return {
    jobInfo: { ...existing.jobInfo, ...Object.fromEntries(Object.entries(out.jobInfo).filter(([, v]) => v != null)) },
    directives: { dryingOnly: out.dryingOnly || existing.directives.dryingOnly, carryForwardConfirmed: out.carryForwardConfirmed },
    items,
    equipment,
    questions,
    recommendations,
    checklist: existing.checklist,
    reviewFlags: [],
  };
}

/** The PM's latest explicit job facts update the project record. */
function syncProjectFromJob(projectId: string, f: VisitFacts) {
  const j = f.jobInfo;
  const patch: Record<string, unknown> = {};
  for (const k of ["causeOfLoss", "sourceStatus", "lossType", "category", "waterClass", "productionDays", "equipmentDays", "accessRestrictions"] as const)
    if (j[k]) patch[k] = j[k];
  if (j.crewRaw) patch.crewRequirements = j.crewRaw;
  if (Object.keys(patch).length) repo.updateProject(projectId, patch);
}

// =====================================================================
// Corrections
// =====================================================================

export async function correctVisit(projectId: string, visitId: string, text: string) {
  const input = text.trim();
  if (!input) throw new UserError("Type or dictate a correction.");
  const ctx = buildContext(projectId, visitId);
  const out = await structured({
    schema: CorrectionOutput,
    system: CORRECTION_SYSTEM,
    content: [{ type: "text", text: `${contextBlock(ctx, { evidence: false })}\n\n<pm_correction>\n${input}\n</pm_correction>` }],
    effort: "medium",
    maxTokens: 16000,
  });
  if (out.intent === "show_full") return { kind: "show_full" as const };
  if (out.intent === "clarify") return { kind: "clarify" as const, clarification: out.clarification ?? "Which room do you mean?" };

  const r = applyOps(ctx.visit.facts, out.ops, ctx.locations, projectId);
  if (r.clarification) return { kind: "clarify" as const, clarification: r.clarification };
  for (const l of r.createdLocations) repo.insertLocation(projectId, l);
  for (const l of r.renamedLocations) repo.updateLocation(projectId, l.id, l);
  if (Object.keys(r.visitFieldUpdates).length) repo.updateVisitFields(projectId, visitId, r.visitFieldUpdates);
  const prev = ctx.prior.at(-1)?.facts ?? null;
  const { facts } = applyGuards(r.facts, { pmText: `${ctx.pmText}\n${input}`, corpusText: ctx.corpusText, previousFacts: prev, priorFacts: ctx.prior.map((v) => v.facts) });
  syncProjectFromJob(projectId, facts);
  const draft = commit(projectId, visitId, facts, {
    trigger: "correction",
    input,
    changes: r.changes.length ? r.changes : ["No changes were needed."],
  });
  return { kind: "applied" as const, draft, changes: r.changes, rejected: r.rejected };
}

// =====================================================================
// Checklist
// =====================================================================

export async function runChecklist(projectId: string, visitId: string, templateId: string) {
  const tpl = repo.getTemplate(templateId);
  const ctx = buildContext(projectId, visitId);
  const out = await structured({
    schema: ChecklistOutput,
    system: CHECKLIST_SYSTEM,
    content: [
      {
        type: "text",
        text: `${contextBlock(ctx, { evidence: false })}\n\n<pm_field_notes>\n${ctx.pmText}\n</pm_field_notes>\n\n<checklist name="${tpl.name}">\n${tpl.items.map((i) => `${i.id}: ${i.label}`).join("\n")}\n</checklist>`,
      },
    ],
    effort: "medium",
    maxTokens: 8000,
  });
  const entries = guardChecklist(tpl.items, out.entries, ctx.pmText);
  const facts = { ...ctx.visit.facts, checklist: { templateId, entries } };
  const draft = commit(projectId, visitId, facts, { trigger: "checklist", input: tpl.name, changes: ["Checklist information updated."] });
  return { draft };
}

/** "Completed" requires the PM's own words; anything else is downgraded. */
export function guardChecklist(
  template: { id: string; label: string }[],
  entries: { itemId: string; status: ChecklistStatus; note: string | null; evidenceQuote: string | null }[],
  pmText: string,
) {
  const hay = norm(pmText);
  return template.map((t) => {
    const e = entries.find((x) => x.itemId === t.id);
    if (!e) return { itemId: t.id, label: t.label, status: "not_documented" as const, note: null, evidenceQuote: null };
    if (e.status === "completed" && !(e.evidenceQuote && norm(e.evidenceQuote).length > 2 && hay.includes(norm(e.evidenceQuote))))
      return { itemId: t.id, label: t.label, status: "not_documented" as const, note: "Completion not documented in your notes.", evidenceQuote: null };
    return { itemId: t.id, label: t.label, status: e.status, note: e.note, evidenceQuote: e.evidenceQuote };
  });
}

/** Checklist view for any visit type (rendered separately from the main scope). */
export function checklistDoc(projectId: string, visit: Visit): { doc: ScopeDoc; text: string } | null {
  if (!visit.facts.checklist || visit.type === "checklist") return null;
  const project = repo.getProject(projectId);
  const doc = renderDoc({ project, visit: { ...visit, type: "checklist" }, facts: visit.facts, locations: repo.listLocations(projectId) }, visit.type);
  return { doc, text: docToText(doc) };
}

// =====================================================================
// Direct edits (no AI)
// =====================================================================

export function decideRecommendation(projectId: string, visitId: string, recId: string, action: "accept" | "reject", text?: string) {
  const v = repo.getVisit(projectId, visitId);
  const facts = structuredClone(v.facts);
  const rec = facts.recommendations.find((r) => r.id === recId);
  if (!rec) throw new repo.NotFound("Recommendation not found");
  rec.status = action === "accept" ? "accepted" : "rejected";
  if (action === "accept")
    facts.items.push({
      id: newId("it"),
      locationId: rec.locationId,
      needsLocation: false,
      category: rec.category,
      text: text?.trim() || rec.text,
      status: "proposed",
      source: "pm_accepted",
      evidenceIds: [],
      carriedForward: false,
      carriedFromVisitId: null,
      quantity: null,
      flags: [],
    });
  return commit(projectId, visitId, facts, { trigger: "recommendation", input: null, changes: [`${action === "accept" ? "Accepted" : "Rejected"}: ${text?.trim() || rec.text}`] });
}

export function editItem(
  projectId: string,
  visitId: string,
  itemId: string,
  patch: { text?: string; status?: string; category?: string; locationId?: string | null; remove?: boolean },
) {
  const v = repo.getVisit(projectId, visitId);
  const facts = structuredClone(v.facts);
  const idx = facts.items.findIndex((i) => i.id === itemId);
  if (idx < 0) throw new repo.NotFound("Item not found");
  const item = facts.items[idx];
  let change: string;
  if (patch.remove) {
    facts.items.splice(idx, 1);
    change = `Removed "${item.text}"`;
  } else {
    if (patch.text?.trim()) item.text = patch.text.trim();
    if (patch.status && (ITEM_STATUSES as readonly string[]).includes(patch.status)) item.status = patch.status as ItemStatus;
    if (patch.category && (CATEGORIES as readonly string[]).includes(patch.category)) item.category = patch.category as Category;
    if (patch.locationId !== undefined) {
      if (patch.locationId && !repo.listLocations(projectId).some((l) => l.id === patch.locationId)) throw new repo.NotFound("Room not found");
      item.locationId = patch.locationId;
      item.needsLocation = false;
    }
    item.source = "manual_edit";
    item.carriedForward = false;
    item.flags = [];
    change = `Edited: "${item.text}" (${item.status})`;
  }
  return commit(projectId, visitId, facts, { trigger: "manual_edit", input: null, changes: [change] });
}

export function addItem(projectId: string, visitId: string, input: { locationId: string | null; category: string; text: string; status: string }) {
  const v = repo.getVisit(projectId, visitId);
  if (!input.text?.trim()) throw new UserError("Bullet text is required.");
  if (input.locationId && !repo.listLocations(projectId).some((l) => l.id === input.locationId)) throw new repo.NotFound("Room not found");
  const facts = structuredClone(v.facts);
  facts.items.push({
    id: newId("it"),
    locationId: input.locationId,
    needsLocation: false,
    category: (CATEGORIES as readonly string[]).includes(input.category) ? (input.category as Category) : "note",
    text: input.text.trim(),
    status: (ITEM_STATUSES as readonly string[]).includes(input.status) ? (input.status as ItemStatus) : "reported",
    source: "manual_edit",
    evidenceIds: [],
    carriedForward: false,
    carriedFromVisitId: null,
    quantity: null,
    flags: [],
  });
  return commit(projectId, visitId, facts, { trigger: "manual_edit", input: null, changes: [`Added "${input.text.trim()}"`] });
}

export function editEquipment(projectId: string, visitId: string, eqId: string, patch: { quantity?: number | null; status?: string; remove?: boolean }) {
  const v = repo.getVisit(projectId, visitId);
  const facts = structuredClone(v.facts);
  const idx = facts.equipment.findIndex((e) => e.id === eqId);
  if (idx < 0) throw new repo.NotFound("Equipment not found");
  const e = facts.equipment[idx];
  if (patch.remove) facts.equipment.splice(idx, 1);
  else {
    if (patch.quantity !== undefined) e.quantity = patch.quantity == null || Number.isNaN(patch.quantity) ? null : Math.max(0, Math.round(patch.quantity));
    if (patch.status) e.status = patch.status as typeof e.status;
    e.source = "manual_edit";
    e.carriedForward = false;
    e.flags = [];
  }
  return commit(projectId, visitId, facts, { trigger: "manual_edit", input: null, changes: [patch.remove ? "Removed equipment entry" : "Edited equipment"] });
}

export function setManualText(projectId: string, visitId: string, text: string | null) {
  const v = repo.getVisit(projectId, visitId);
  return commit(projectId, visitId, v.facts, { trigger: "manual_edit", input: null, changes: [text ? "Edited scope text directly." : "Cleared text edits."] }, text?.trim() ? text : null);
}

export function restoreDraft(projectId: string, visitId: string, draftId: string) {
  const s = repo.getDraftState(projectId, visitId, draftId);
  return commit(projectId, visitId, s.facts, { trigger: "restore", input: `Restored version ${s.version}`, changes: [`Restored version ${s.version}.`] }, s.manualText);
}

export function rerender(projectId: string, visitId: string) {
  const v = repo.getVisit(projectId, visitId);
  return commit(projectId, visitId, v.facts, { trigger: "manual_edit", input: null, changes: ["Re-rendered after room changes."] }, v.manualText);
}

// =====================================================================
// Company manuals
// =====================================================================

const MAX_MANUAL_CHARS = 600_000;

export async function ingestManual(file: { name: string; bytes: Uint8Array }) {
  const id = newId("man");
  const dir = path.join(UPLOAD_DIR, "_manuals");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pdf = isPdf(file.bytes);
  const storedPath = path.join(dir, `${id}${pdf ? ".pdf" : ".txt"}`);
  writeFileSync(storedPath, file.bytes, { mode: 0o600 });
  const text = pdf ? (await extractPageTexts(file.bytes)).join("\n\n") : Buffer.from(file.bytes).toString("utf8");
  if (!text.trim()) throw new UserError("No readable text in that manual (scanned manuals are not supported yet).");
  if (text.length > MAX_MANUAL_CHARS) throw new UserError("Manual is too long to process in one pass (over 600,000 characters). Split it into sections.");
  repo.createManual({ id, name: file.name.replace(/\.[a-z]+$/i, "").slice(0, 120), filename: file.name.slice(0, 200), storedPath, text });
  await extractManualRules(id);
  return id;
}

export async function extractManualRules(id: string) {
  const { manual, text } = repo.getManualText(id);
  const existing = repo.listManuals().filter((m) => m.id !== id).flatMap((m) => m.rules.map((r) => ({ ...r, manualId: m.id, manual: m.name })));
  try {
    const out = await structured({
      schema: ManualRulesOutput,
      system: MANUAL_SYSTEM,
      content: [
        {
          type: "text",
          text: `<existing_rules>\n${existing.map((r) => `${r.id} [${r.manual} / ${r.topic}] ${r.rule}`).join("\n") || "(none)"}\n</existing_rules>\n\n<manual_text name="${manual.name}">\n${text}\n</manual_text>`,
        },
      ],
      effort: "medium",
      maxTokens: 32000,
    });
    const rules = out.rules.map((r, i) => ({ id: `${id}_r${i + 1}`, topic: r.topic, rule: r.rule }));
    repo.setManualRules(id, rules, "ready");
    repo.addConflicts(
      out.conflicts.map((c) => ({
        description: `${manual.name}: ${c.description}`,
        manualIds: [id, ...new Set(existing.filter((r) => c.conflictingRuleIds.includes(r.id)).map((r) => r.manualId))],
      })),
    );
  } catch (e) {
    repo.setManualRules(id, [], "failed", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// =====================================================================
// Demo data (clearly labeled, fictional)
// =====================================================================

export function createDemoProject() {
  const p = repo.createProject(
    {
      name: "DEMO — 120 Sample Avenue (fictional)",
      address: "120 Sample Avenue, New York, NY (DEMO — not a real job)",
      customer: "Demo Building Management",
      pm: "Demo PM",
      causeOfLoss: "Pipe burst above Unit 19C",
      sourceStatus: "repaired",
      lossType: "Water",
      category: "Cat 2",
      payer: "insurance",
      claimNumber: "DEMO-0000",
    },
    true,
  );
  const L = (floor: string | null, unit: string | null, room: string) => repo.insertLocation(p.id, { floor, unit, room });
  const living = L("19", "19C", "Living Room");
  const closet19 = L("19", "19C", "Closet");
  const closet20 = L("20", "20A", "Closet");
  const hall = L("20", null, "Common Hallway");
  const it = (locationId: string | null, category: Category, text: string, status: ItemStatus = "reported", extra: Partial<VisitFacts["items"][number]> = {}) => ({
    id: newId("it"), locationId, needsLocation: false, category, text, status, source: "pm" as const, evidenceIds: [],
    carriedForward: false, carriedFromVisitId: null, quantity: null, flags: [], ...extra,
  });
  const eq = (locationId: string, type: VisitFacts["equipment"][number]["type"], quantity: number, status: VisitFacts["equipment"][number]["status"]) => ({
    id: newId("eq"), locationId, type, label: null, quantity, status, statusDate: null, source: "pm" as const, carriedForward: false, flags: [],
  });
  const d = new Date();
  const ymd = (offset: number) => todayNY(new Date(d.getTime() + offset * 86400000));

  const v1 = repo.createVisit(p.id, { type: "initial_mitigation", visitDate: ymd(-1) });
  repo.updateVisitFields(p.id, v1.id, {
    fieldNotes:
      "DEMO NOTES. Pipe burst above 19C, source repaired, Cat 2. Living room hardwood and walls wet. Closet carpet and wall wet in 19C. 20A closet wall wet. 20th floor hallway carpet wet along the wall. Drying only. CC+2. 2 air movers in 19C living room, 1 in each closet, 1 dehumidifier in 19C living room. 2 air movers in the 20th floor hallway.",
  });
  const f1: VisitFacts = {
    ...repo.getVisit(p.id, v1.id).facts,
    jobInfo: { ...repo.getVisit(p.id, v1.id).facts.jobInfo, crewRaw: "CC+2", crewChiefs: 1, subcontractors: 2, category: "Cat 2", sourceStatus: "repaired" },
    directives: { dryingOnly: true, carryForwardConfirmed: false },
    items: [
      it(living.id, "condition", "Hardwood flooring and walls are wet"),
      it(living.id, "drying", "Set drying equipment on affected flooring and walls", "approved"),
      it(closet19.id, "condition", "Carpet and wall are wet"),
      it(closet19.id, "drying", "Dry carpet in place and dry affected wall", "approved"),
      it(closet20.id, "condition", "Wall is wet"),
      it(closet20.id, "drying", "Dry affected wall", "approved"),
      it(hall.id, "condition", "Carpet wet along the wall"),
      it(hall.id, "drying", "Dry carpet in place along the affected wall", "approved"),
    ],
    equipment: [eq(living.id, "air_mover", 2, "installed"), eq(living.id, "dehumidifier", 1, "installed"), eq(closet19.id, "air_mover", 1, "installed"), eq(closet20.id, "air_mover", 1, "installed"), eq(hall.id, "air_mover", 2, "installed")],
  };
  commit(p.id, v1.id, f1, { trigger: "generate", input: null, changes: ["Demo data (fictional)."] });

  const v2 = repo.createVisit(p.id, { type: "daily_monitoring", visitDate: ymd(0) });
  repo.updateVisitFields(p.id, v2.id, { fieldNotes: "DEMO NOTES. Same as yesterday except the 20th floor hallway is dry. 19C closet carpet is dry, wall still elevated." });
  const f2: VisitFacts = {
    ...f1,
    directives: { dryingOnly: true, carryForwardConfirmed: true },
    items: [
      it(living.id, "drying", "Equipment continues drying the affected flooring and walls", "in_progress", { carriedForward: true, source: "prior_visit" }),
      it(living.id, "moisture_elevated", "Flooring and wall readings remain elevated", "reported", { carriedForward: true, source: "prior_visit" }),
      it(closet19.id, "drying", "Equipment continues drying the affected wall", "in_progress"),
      it(closet19.id, "moisture_elevated", "Wall readings remain elevated"),
      it(closet19.id, "moisture_dry", "Carpet is dry"),
      it(closet20.id, "moisture_elevated", "Wall readings remain elevated", "reported", { carriedForward: true, source: "prior_visit" }),
      it(hall.id, "moisture_dry", "Previously affected areas are now dry"),
      it(hall.id, "change", "Elevated moisture noted during the previous visit has resolved"),
    ],
    equipment: f1.equipment.map((e) => ({ ...e, id: newId("eq"), status: "operating" as const, carriedForward: true, source: "prior_visit" as const })),
  };
  commit(p.id, v2.id, f2, { trigger: "generate", input: null, changes: ["Demo data (fictional)."] });
  return p;
}
