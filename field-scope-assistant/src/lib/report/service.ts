import { newId } from "../ids";
import { getProperty, updateProperty, assignmentsForProject } from "../intake";
import { fullLabel } from "../locations";
import { extractPageTexts, isPdf } from "../pdf";
import * as repo from "../repo";
import { emptyScan, type RoomScanData, type ScopeLine } from "../scan";
import { getVisitScans, previewRoom, saveRoomScan } from "../scans";
import { MAX_UPLOAD_BYTES, UserError, galleryAddressCheck } from "../service";
import { blobStoredPath, projectKey, putFile } from "../storage";
import { streetKey } from "../fnol";
import { aiReportStatus, analyzeReport } from "./analyzer";
import { applyChanges, proposeChanges, stillMissing, type ReportChange, type RoomTarget } from "./match";
import { FINDING_LABELS, findingText, type Finding, type ReportFindings } from "./types";

/**
 * Mold report upload → rules analysis → scope proposal. Reports are stored as documents of kind
 * "mold_report" (PDF, or a photo of the report). A report whose address or name doesn't match the
 * project is held as "Wrong report?" until the PM confirms it is theirs or cancels it.
 */

export const WRONG_REPORT = "Wrong report?";

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

const lastName = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z ]/g, " ").trim().split(/\s+/).filter((w) => w.length > 1).pop() ?? "";

/** Does the report's address / unit / name match this project? Returns a warning or null. */
export function reportIdentityCheck(project: { address: string; name: string; customer: string | null }, f: ReportFindings): string | null {
  const projAddr = project.address || project.name;
  const issues: string[] = [];
  if (f.address) {
    const check = galleryAddressCheck(projAddr, [f.address.value]);
    if (check.mismatch || (streetKey(f.address.value) && streetKey(projAddr) && streetKey(f.address.value) !== streetKey(projAddr))) issues.push(`address "${f.address.value}"`);
  }
  const projUnit = projAddr.match(/(?:apt\.?|apartment|unit|suite|#)\s*([0-9A-Z-]{1,8})\b/i)?.[1];
  if (f.unit && projUnit && f.unit.value.toLowerCase() !== projUnit.toLowerCase() && !issues.length) issues.push(`unit ${f.unit.value}`);
  if (f.customer && project.customer && lastName(f.customer.value) && lastName(f.customer.value) !== lastName(project.customer)) issues.push(`name "${f.customer.value}"`);
  if (!issues.length) return null;
  return `${WRONG_REPORT} This report states ${issues.join(" and ")}, but this project is ${projAddr}${project.customer ? ` (${project.customer})` : ""}. Confirm it is still this job's report, or cancel it.`;
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
  const wrong = findings.readable ? reportIdentityCheck(project, findings) : null;
  const status = !findings.readable ? "unreadable" : wrong ? "needs_confirmation" : "ready";
  await repo.setDocumentReport(projectId, id, { kind: "mold_report", contentType, findings });
  await repo.setDocumentStatus(projectId, id, status, wrong);
  return { ...doc, kind: "mold_report" as const, status, contentType, wrongReport: wrong, readable: findings.readable };
}

export async function confirmReport(projectId: string, documentId: string) {
  const d = await repo.getDocument(projectId, documentId);
  if (d.kind !== "mold_report") throw new UserError("That file is not a mold report.");
  await repo.setDocumentReport(projectId, documentId, { confirmed: true });
  await repo.setDocumentStatus(projectId, documentId, "ready", d.error ? `Confirmed by the PM despite: ${d.error.replace(`${WRONG_REPORT} `, "")}` : null);
  return repo.getDocument(projectId, documentId);
}

async function yearBuiltOf(projectId: string) {
  const a = (await assignmentsForProject(projectId))[0];
  return a ? { propertyId: a.propertyId, yearBuilt: (await getProperty(a.propertyId)).yearBuilt } : { propertyId: null, yearBuilt: null };
}

/** The room the report applies to: same room name, else the only room, else the "room TBD" room. */
async function targetRoom(projectId: string, visitId: string, f: ReportFindings) {
  const view = await getVisitScans(projectId, visitId);
  const locations = await repo.listLocations(projectId);
  const loc = (id: string) => locations.find((l) => l.id === id)!;
  const byName = f.room ? view.rooms.find((r) => loc(r.locationId).room.toLowerCase().includes(f.room!.value.toLowerCase())) : undefined;
  const room = byName ?? (view.rooms.length === 1 ? view.rooms[0] : view.rooms.find((r) => /room TBD/i.test(loc(r.locationId).room)));
  if (!room) return null;
  const { lines: _l, decisions: _d, ...data } = room.data;
  void _l;
  void _d;
  return { locationId: room.locationId, label: room.label, roomName: loc(room.locationId).room, data: data as RoomScanData, lines: room.data.lines, decisions: room.data.decisions };
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
  return FINDING_LABELS.map(([key, label]) => {
    const x = f[key] as Finding<unknown> | null;
    const open = f.unanswered.find((u) => u.key === key);
    return {
      key,
      label,
      value: findingText(key, f),
      quote: x?.quote ?? open?.quote ?? null,
      page: x?.page ?? null,
      stated: x ? "found" : open?.quote ? "open" : "missing",
    };
  });
}

export async function reportView(projectId: string, visitId: string) {
  const docs = (await repo.listDocuments(projectId)).filter((d) => d.kind === "mold_report");
  const ai = aiReportStatus();
  const reports = docs.map((d) => ({ id: d.id, filename: d.filename, status: d.status, warning: d.error, contentType: d.contentType, createdAt: d.createdAt, confirmed: d.confirmed }));
  const active = docs.find((d) => d.status === "ready" && d.findings) ?? null;
  if (!active) return { reports, ai, active: null };
  const f = active.findings as ReportFindings;
  const yb = await yearBuiltOf(projectId);
  const target = await targetRoom(projectId, visitId, f);
  let changes: ReportChange[] = [];
  let mismatches: string[] = [];
  let preview: ScopeLine[] = [];
  let applied = false;
  if (target) {
    const t: RoomTarget = { roomLabel: target.label, roomName: target.roomName, scan: { ...target.data, lines: [], decisions: {} } as RoomScanData, yearBuilt: yb.yearBuilt };
    ({ changes, mismatches } = proposeChanges(f, t));
    applied = target.data.reportDocumentId === active.id;
    const next = applyChanges(f, t, changes.filter((c) => !c.conflict).map((c) => c.key), active.id);
    preview = (await previewRoom(projectId, visitId, target.locationId, { ...next.scan, decisions: target.decisions }, next.roomName, next.yearBuilt ?? yb.yearBuilt, f)).lines;
  }
  return {
    reports,
    ai,
    active: {
      id: active.id,
      filename: active.filename,
      findings: panelRows(f),
      room: target ? { locationId: target.locationId, label: target.label } : null,
      applied,
      changes,
      mismatches,
      preview,
      stillMissing: stillMissing(f, { yearBuiltKnown: yb.yearBuilt != null, runKnown: !!(target?.data.materials.flooring.continuousRun || target?.data.materials.flooring.breakNote) }),
    },
  };
}

/** Applies the report to the scan (the chosen changes only); lines come back as suggested, for the PM to accept. */
export async function applyReport(projectId: string, visitId: string, documentId: string, keys: string[]) {
  const d = await repo.getDocument(projectId, documentId);
  if (d.kind !== "mold_report" || !d.findings) throw new UserError("That report has nothing to apply.");
  if (d.status !== "ready") throw new UserError(d.status === "needs_confirmation" ? "Confirm the report is this job's first (Wrong report?)." : "This report could not be read by the rules analyzer.");
  const f = d.findings as ReportFindings;
  const yb = await yearBuiltOf(projectId);
  let target = await targetRoom(projectId, visitId, f);
  if (!target) {
    const visit = await repo.getVisit(projectId, visitId);
    const loc = await repo.insertLocation(projectId, { room: f.room?.value ?? "Affected area (room TBD)" });
    const scan = emptyScan();
    scan.loss.type = "mold";
    void visit;
    await saveRoomScan(projectId, visitId, loc.id, strip(scan));
    target = await targetRoom(projectId, visitId, f);
    if (!target) throw new UserError("Add a room first.");
  }
  const t: RoomTarget = { roomLabel: target.label, roomName: target.roomName, scan: { ...target.data, lines: [], decisions: {} } as RoomScanData, yearBuilt: yb.yearBuilt };
  const next = applyChanges(f, t, keys, documentId);
  if (next.roomName) await repo.updateLocation(projectId, target.locationId, { room: next.roomName });
  if (next.yearBuilt != null && yb.propertyId) await updateProperty(yb.propertyId, { yearBuilt: next.yearBuilt });
  await saveRoomScan(projectId, visitId, target.locationId, strip(next.scan));
  return reportView(projectId, visitId);
}

function strip(s: RoomScanData) {
  const { lines: _l, decisions: _d, ...rest } = s;
  void _l;
  void _d;
  return rest;
}

export { fullLabel };
