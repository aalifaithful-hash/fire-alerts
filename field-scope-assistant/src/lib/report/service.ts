import { newId } from "../ids";
import { getProperty, updateProperty, assignmentsForProject } from "../intake";
import { extractPageTexts, isPdf } from "../pdf";
import * as repo from "../repo";
import { CASEWORK_ACTION_LABELS, CASEWORK_LABELS, type RoomScanData, type ScopeLine } from "../scan";
import { getVisitScans, previewVisit, saveRoomScan, setLineReview } from "../scans";
import { MAX_UPLOAD_BYTES, UserError } from "../service";
import { blobStoredPath, projectKey, putFile } from "../storage";
import { sameStreet } from "../fnol";
import { aiReportStatus, analyzeReport } from "./analyzer";
import { applyVisit, proposeVisit, removeHintText, stillMissing, type ReportChange, type VisitRoom } from "./match";
import { FINDING_LABELS, findingText, type Finding, type ReportFindings } from "./types";

/**
 * Mold report upload → rules analysis → scope proposal. Reports are stored as documents of kind
 * "mold_report" (PDF, or a photo of the report). Statuses:
 *  - ready: readable mold report, matches the project (or the PM confirmed it)
 *  - needs_confirmation: address / unit / name doesn't match — "Wrong report?" until confirmed or cancelled
 *  - wrong_type: readable, but not a mold report (e.g. a water-damage report) — never applied
 *  - unreadable: no selectable text (photo or scan) — stored; needs AI, which is not enabled
 *  - superseded: an earlier report replaced by a newer one
 */

export const WRONG_REPORT = "Wrong report?";
export const WRONG_TYPE = "Not a mold report?";

function sniffType(bytes: Uint8Array, name: string): string | null {
  if (isPdf(bytes)) return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  const head = new TextDecoder().decode(bytes.slice(4, 12));
  if (head.startsWith("ftyp") && /heic|heix|mif1|heif/.test(head + new TextDecoder().decode(bytes.slice(8, 24)))) return "image/heic";
  if (new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (/\.(heic|heif)$/i.test(name)) return "image/heic";
  return null;
}

const nameWords = (s: string | null | undefined) =>
  new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !["mr", "mrs", "ms", "dr", "the", "and", "family", "llc", "inc"].includes(w)),
  );
const unitKey = (u: string) => u.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Does the report's address / unit / name match this project? Returns a warning or null. */
export function reportIdentityCheck(project: { address: string; name: string; customer: string | null }, f: ReportFindings): string | null {
  const projAddr = project.address || project.name;
  const issues: string[] = [];
  if (f.address && sameStreet(f.address.value, projAddr) === false) issues.push(`address "${f.address.value}"`);
  const projUnit = projAddr.match(/(?:apt\.?|apartment|unit|suite|#)\s*([0-9A-Z-]{1,8})\b/i)?.[1];
  if (f.unit && projUnit && unitKey(f.unit.value) !== unitKey(projUnit) && !issues.length) issues.push(`unit ${f.unit.value}`);
  if (f.customer && project.customer) {
    const a = nameWords(f.customer.value);
    const b = nameWords(project.customer);
    if (a.size && b.size && ![...a].some((w) => b.has(w))) issues.push(`name "${f.customer.value}"`);
  }
  if (!issues.length) return null;
  return `${WRONG_REPORT} This report states ${issues.join(" and ")}, but this project is ${projAddr}${project.customer ? ` (${project.customer})` : ""}. Confirm it is still this job's report, or cancel it.`;
}

async function supersedeOthers(projectId: string, keepId: string, filename: string) {
  for (const d of await repo.listDocuments(projectId))
    if (d.kind === "mold_report" && d.id !== keepId && d.status === "ready") await repo.setDocumentStatus(projectId, d.id, "superseded", `Replaced by the newer report ${filename}.`);
}

export async function ingestReport(projectId: string, file: { name: string; bytes: Uint8Array; blobUrl?: string }) {
  const project = await repo.getProject(projectId);
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw new UserError("File is larger than 200 MB.");
  const contentType = sniffType(file.bytes, file.name);
  if (!contentType) throw new UserError("Upload the mold report as a PDF or a photo (JPG, PNG, HEIC).");
  const id = newId("doc");
  const ext = contentType === "application/pdf" ? "pdf" : contentType.split("/")[1].replace("jpeg", "jpg");
  const storedPath = file.blobUrl ? blobStoredPath(file.blobUrl) : await putFile(projectKey(projectId, `${id}.${ext}`), file.bytes, contentType);
  let pages: string[] = [];
  if (contentType === "application/pdf") {
    try {
      pages = await extractPageTexts(file.bytes);
    } catch {
      pages = [];
    }
  }
  const doc = await repo.createDocument(projectId, { id, filename: file.name.slice(0, 200), storedPath, size: file.bytes.length, pageCount: pages.length || (contentType === "application/pdf" ? 0 : 1) });
  if (pages.length) await repo.savePages(id, pages.map((text, i) => ({ page: i + 1, text })));
  const findings = await analyzeReport({ pages, contentType });
  const wrongType = findings.readable && findings.reportType !== "mold" ? `${WRONG_TYPE} This file reads like a ${findings.reportType === "water" ? "water-damage report" : "document"} with no mold growth described. Nothing from it is used for the mold scope.` : null;
  const wrong = findings.readable && !wrongType ? reportIdentityCheck(project, findings) : null;
  const status = !findings.readable ? "unreadable" : wrongType ? "wrong_type" : wrong ? "needs_confirmation" : "ready";
  await repo.setDocumentReport(projectId, id, { kind: "mold_report", contentType, findings });
  await repo.setDocumentStatus(projectId, id, status, wrongType ?? wrong);
  if (status === "ready") await supersedeOthers(projectId, id, file.name);
  return { ...doc, kind: "mold_report" as const, status, contentType, wrongReport: wrong, wrongType, readable: findings.readable };
}

export async function confirmReport(projectId: string, documentId: string) {
  const d = await repo.getDocument(projectId, documentId);
  if (d.kind !== "mold_report") throw new UserError("That file is not a mold report.");
  if (d.status !== "needs_confirmation") throw new UserError(d.status === "wrong_type" ? "This file isn't a mold report — it can't be used. Remove it." : "Nothing to confirm on this report.");
  await repo.setDocumentReport(projectId, documentId, { confirmed: true });
  await repo.setDocumentStatus(projectId, documentId, "ready", d.error ? `Confirmed by the PM despite: ${d.error.replace(`${WRONG_REPORT} `, "")}` : null);
  await supersedeOthers(projectId, documentId, d.filename);
  return repo.getDocument(projectId, documentId);
}

async function yearBuiltOf(projectId: string) {
  const a = (await assignmentsForProject(projectId))[0];
  return a ? { propertyId: a.propertyId, yearBuilt: (await getProperty(a.propertyId)).yearBuilt } : { propertyId: null, yearBuilt: null };
}

async function visitRooms(projectId: string, visitId: string): Promise<VisitRoom[]> {
  const view = await getVisitScans(projectId, visitId);
  const locations = await repo.listLocations(projectId);
  return view.rooms.map((r) => ({ locationId: r.locationId, label: r.label, roomName: locations.find((l) => l.id === r.locationId)?.room ?? r.label, scan: r.data as RoomScanData }));
}

export interface ReportPanelRow {
  key: string;
  label: string;
  value: string | null;
  quote: string | null;
  page: number | null;
  stated: "found" | "open" | "missing";
}

function panelRows(f: ReportFindings): ReportPanelRow[] {
  const rows: ReportPanelRow[] = FINDING_LABELS.map(([key, label]) => {
    const x = f[key] as Finding<unknown> | null;
    const open = f.unanswered.find((u) => u.key === key);
    return { key, label, value: findingText(key, f), quote: x?.quote ?? open?.quote ?? null, page: x?.page ?? null, stated: x ? "found" : open?.quote ? "open" : "missing" };
  });
  // multi-room reports: one row per further room
  for (const r of f.rooms.slice(1)) {
    const v = r.value;
    const parts = [v.lengthFt != null ? `${v.lengthFt} × ${v.widthFt} ft${v.heightFt ? `, ${v.heightFt} ft ceiling` : ""}` : "no measurements", v.areaSF != null ? `${v.areaSF} SF` : null, v.coverage ? (v.coverage.whole ? "whole floor" : `part of the floor${v.coverage.pct != null ? ` (${v.coverage.pct}%)` : ""}`) : v.vague ? `extent only “${v.vague}”` : null, v.growth ? null : "no growth"].filter(Boolean);
    rows.push({ key: `room:${v.name}`, label: `Room — ${v.name}`, value: parts.join(", "), quote: r.quote, page: r.page, stated: "found" });
  }
  // cabinets / countertops / vanity / backsplash the report names
  for (const m of f.caseworkMentions ?? []) {
    const v = m.value;
    rows.push({ key: `casework:${v.room ?? ""}:${v.kind}`, label: `${v.room ? `${v.room} — ` : ""}${CASEWORK_LABELS[v.kind]}`, value: `${v.growth ? "Affected" : "Named"} — ${v.action ? CASEWORK_ACTION_LABELS[v.action].toLowerCase() : v.removeOnly ? `says remove, not how: detach & reset, remove & replace, or remove & dispose? (not picked${removeHintText(v.removeHint)})` : "action not stated"}`, quote: m.quote, page: m.page, stated: v.removeOnly ? "open" : "found" });
  }
  for (const [i, u] of (f.caseworkUnspecified ?? []).entries())
    rows.push({ key: `casework:unspecified:${i}`, label: "Cabinets (which not stated)", value: "Not assumed — say which (upper / lower / vanity)", quote: u.quote, page: u.page, stated: "open" });
  return rows;
}

const qtyOf = (l: ScopeLine) => (l.quantity == null ? "no quantity" : `${l.quantity} ${l.unit}`);

export async function reportView(projectId: string, visitId: string) {
  const docs = (await repo.listDocuments(projectId)).filter((d) => d.kind === "mold_report");
  const ai = aiReportStatus();
  const reports = docs.map((d) => ({ id: d.id, filename: d.filename, status: d.status, warning: d.error, contentType: d.contentType, createdAt: d.createdAt, confirmed: d.confirmed }));
  const active = docs.find((d) => d.status === "ready" && d.findings) ?? null;
  if (!active) return { reports, ai, active: null };
  const f = active.findings as ReportFindings;
  const yb = await yearBuiltOf(projectId);
  const rooms = await visitRooms(projectId, visitId);
  const { plans, changes, mismatches, replaced } = proposeVisit(f, rooms, yb.yearBuilt);
  const applied = plans.every((p) => !p.target || p.target.scan.reportDocumentId === active.id) && plans.some((p) => p.target);
  const next = applyVisit(f, plans, changes, changes.filter((c) => !c.conflict && !c.optional).map((c) => c.id), active.id);
  const pv = await previewVisit(
    projectId,
    visitId,
    next.rooms.map((x) => ({ locationId: x.plan.target?.locationId ?? null, roomName: x.roomName ?? x.plan.target?.roomName ?? x.plan.name, data: { ...x.scan, decisions: x.plan.target?.scan.decisions ?? {} } })),
    next.yearBuilt ?? yb.yearBuilt,
  );
  const planned = new Set(next.rooms.map((x) => x.plan.target?.locationId ?? `new:${x.roomName}`));
  const previewRooms = pv.filter((r) => planned.has(r.locationId)).map((r) => ({ locationId: r.locationId, label: r.label, lines: r.lines }));
  const prim = next.rooms.find((x) => x.plan.primary);
  const primaryId = prim ? (prim.plan.target?.locationId ?? `new:${prim.roomName}`) : previewRooms[0]?.locationId;
  const runKnown = rooms.some((r) => r.scan.materials.flooring.continuousRun || r.scan.materials.flooring.breakNote);
  return {
    reports,
    ai,
    active: {
      id: active.id,
      filename: active.filename,
      findings: panelRows(f),
      room: plans[0]?.target ? { locationId: plans[0].target.locationId, label: plans[0].target.label } : null,
      rooms: plans.map((p) => ({ name: p.name, target: p.target?.label ?? null, isNew: !p.target, primary: p.primary, runOnly: p.runOnly })),
      applied,
      changes,
      mismatches,
      replaced,
      preview: previewRooms.find((r) => r.locationId === primaryId)?.lines ?? [],
      previewRooms,
      stillMissing: stillMissing(f, { yearBuiltKnown: yb.yearBuilt != null, runKnown }),
    },
  };
}

/**
 * Applies the chosen report changes to the visit's rooms (adding rooms the report names), then marks
 * every line the report changed — new quantity, new item, or gone — for the PM to accept or reject again.
 */
export async function applyReport(projectId: string, visitId: string, documentId: string, ids: string[]) {
  const d = await repo.getDocument(projectId, documentId);
  if (d.kind !== "mold_report" || !d.findings) throw new UserError("That report has nothing to apply.");
  if (d.status !== "ready")
    throw new UserError(
      d.status === "needs_confirmation" ? "Confirm the report is this job's first (Wrong report?)." : d.status === "wrong_type" ? "This file isn't a mold report — nothing from it can be applied." : d.status === "superseded" ? "A newer report replaced this one." : "This report could not be read by the rules analyzer.",
    );
  const f = d.findings as ReportFindings;
  const yb = await yearBuiltOf(projectId);
  const before = await visitRooms(projectId, visitId);
  const { plans, changes } = proposeVisit(f, before, yb.yearBuilt);
  const next = applyVisit(f, plans, changes, ids, documentId);
  const unit = (await repo.listLocations(projectId)).find((l) => l.unit)?.unit ?? null;
  const touched: { locationId: string; prev: VisitRoom | null; replaced: string[] }[] = [];
  for (const x of next.rooms) {
    let locationId = x.plan.target?.locationId ?? null;
    if (x.create || !locationId) locationId = (await repo.insertLocation(projectId, { unit, room: x.roomName ?? "Affected area (room TBD)" })).id;
    else if (x.roomName) await repo.updateLocation(projectId, locationId, { room: x.roomName });
    await saveRoomScan(projectId, visitId, locationId, strip(x.scan));
    touched.push({ locationId, prev: x.plan.target, replaced: changes.filter((c) => c.room === x.plan.name && c.previousReport && ids.some((i) => i === c.id || i === c.key)).map((c) => `${c.label}: was "${c.previousReport}" (earlier report), now "${c.proposed}"`) });
  }
  if (next.yearBuilt != null && yb.propertyId) await updateProperty(yb.propertyId, { yearBuilt: next.yearBuilt });
  // re-flag what the report changed in lines the PM had already decided
  const after = await getVisitScans(projectId, visitId);
  for (const t of touched) {
    const now = after.rooms.find((r) => r.locationId === t.locationId);
    if (!now || !t.prev) continue;
    const prevLines = t.prev.scan.lines;
    const decided = (id: string) => t.prev!.scan.decisions[id];
    const reset: string[] = [];
    const notes: Record<string, string> = {};
    const summary: string[] = [...t.replaced];
    for (const l of now.data.lines) {
      const old = prevLines.find((p) => p.id === l.id);
      if (old && (old.quantity !== l.quantity || old.item !== l.item) && decided(l.id)) {
        reset.push(l.id);
        notes[l.id] = `Changed by the mold report: was ${qtyOf(old)}${old.item !== l.item ? ` (${old.item})` : ""} — accept or reject again.`;
      } else if (!old && Object.keys(t.prev.scan.decisions).length) notes[l.id] = "New from the mold report — accept or reject.";
    }
    for (const old of prevLines) if (!now.data.lines.some((l) => l.id === old.id) && decided(old.id) === "accepted") summary.push(`"${old.activity} ${old.item}" (${qtyOf(old)}, accepted before) is no longer proposed`);
    if (reset.length || Object.keys(notes).length || summary.length) await setLineReview(projectId, visitId, t.locationId, { reset, notes, changes: summary });
  }
  return reportView(projectId, visitId);
}

function strip(s: RoomScanData) {
  const { lines: _l, decisions: _d, ...rest } = s;
  void _l;
  void _d;
  return rest;
}

export type { ReportChange };
