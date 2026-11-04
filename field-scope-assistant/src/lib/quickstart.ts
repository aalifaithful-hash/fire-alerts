import type { ServiceLine } from "./fnol";
import { QUICK_JOBS, type QuickJob } from "./quickJobs";
export { QUICK_JOBS, QUICK_JOB_LABELS, type QuickJob } from "./quickJobs";
import { createAssignmentFromFnol, IntakeError, openProjectForAssignment, type AssignmentInput } from "./intake";
import * as repo from "./repo";
import { findRoomName } from "./rooms";
import { saveRoomScan } from "./scans";
import { RoomScanData } from "./scan";

/**
 * Quick start (no FNOL, no AI): address + customer + kind of job + notes → property,
 * assignment, project, visit and a first room scan seeded from the notes, so the
 * PM lands on proposed scope lines in one tap. Notes are read by simple rules;
 * anything not stated stays blank and becomes a question — nothing is invented.
 */

const LINES: Record<QuickJob, ServiceLine[]> = {
  water: ["mitigation"],
  mold: ["mold"],
  fire: ["mitigation"],
  smoke: ["mitigation"],
  sewage: ["mitigation"],
  contents: ["contents"],
  reconstruction: ["reconstruction"],
};

export interface QuickStartInput {
  address: string;
  unit?: string | null;
  customer?: string | null;
  phone?: string | null;
  job: QuickJob;
  appointmentTime?: string | null; // HH:MM 24h
  notes?: string | null;
}


/** Reads the PM's notes into a first room scan. Returns what it understood so the PM can check it. */
export function seedFromNotes(job: QuickJob, notesIn: string | null | undefined) {
  const notes = notesIn ?? "";
  const understood: string[] = [];
  const lossType = job === "contents" || job === "reconstruction" ? null : job === "smoke" ? "smoke" : job;
  if (lossType) understood.push(`Loss: ${lossType}`);
  const room = findRoomName(notes);
  understood.push(room ? `Room: ${room}` : "Room: not stated (named “Affected area (room TBD)”)");

  const floorWord = /\bfloor(ing|s)?\b/i.test(notes);
  const ftype = /\bengineered\b/i.test(notes)
    ? "engineered wood"
    : /\bhard ?wood\b/i.test(notes)
      ? "hardwood"
      : /\bwood\b/i.test(notes) && floorWord
        ? "wood"
        : /\blaminate\b/i.test(notes)
          ? "laminate"
          : /\bcarpet\b/i.test(notes)
            ? "carpet"
            : /\b(lvp|vinyl plank|vinyl)\b/i.test(notes)
              ? "LVP"
              : /\btile\b/i.test(notes) && floorWord
                ? "tile"
                : null;
  const flooringAffected = floorWord || ftype != null;
  if (flooringAffected) understood.push(`Flooring affected${ftype ? `: ${ftype}` : ""}${/\bunder\b/i.test(notes) ? " (growth/damage underneath)" : ""}`);
  const ceiling = /\bceiling\b/i.test(notes);
  if (ceiling) understood.push("Ceiling affected");
  const baseboard = /\bbase ?board/i.test(notes);
  if (baseboard) understood.push("Baseboard affected");
  const cabinets = /\b(cabinet|vanity)/i.test(notes);
  if (cabinets) understood.push("Cabinets affected");
  const drywall = /\b(drywall|sheetrock|wall)s?\b/i.test(notes);
  if (drywall) understood.push("Walls mentioned — mark which walls in the scan");

  let assessmentReport: "pending" | "received" | null = null;
  if (/\b(mold|mould|assessment|ieq|iep)\b[^.]*\b(report|protocol|assessment)\b|\b(report|protocol)\b[^.]*\bmold\b/i.test(notes)) {
    assessmentReport = /\b(will send|send (it )?over|sending|to follow|coming|pending|waiting|will email|will forward)\b/i.test(notes)
      ? "pending"
      : /\b(received|attached|on file|have it|got it)\b/i.test(notes)
        ? "received"
        : "pending";
    understood.push(`Mold assessment report: ${assessmentReport === "pending" ? "pending (customer will send)" : "received"}`);
  }

  const scan = RoomScanData.parse({
    loss: { type: lossType, assessmentReport },
    materials: {
      flooring: { type: ftype, affected: flooringAffected },
      baseboard: { affected: baseboard },
      ceiling: { affected: ceiling },
      cabinets: { affected: cabinets },
    },
  });
  return { room, scan, understood };
}

export async function quickStart(input: QuickStartInput) {
  const address = String(input.address ?? "").trim();
  if (!address) throw new IntakeError("Enter the property address.");
  if (!(QUICK_JOBS as readonly string[]).includes(input.job)) throw new IntakeError("Choose the kind of job.");
  const time = input.appointmentTime?.trim() || null;
  if (time && !/^\d{1,2}:\d{2}$/.test(time)) throw new IntakeError("Visit time must be HH:MM.");
  const notes = (input.notes ?? "").trim();
  const unit = input.unit?.trim() || null;

  const a: AssignmentInput = {
    serviceLines: LINES[input.job],
    contentsOnly: input.job === "contents",
    stage: "initial_walkthrough",
    special: false,
    specialReason: null,
    program: null,
    claimNumber: null,
    assignmentNumber: null,
    policyNumber: null,
    carrier: null,
    insured: input.customer?.trim() || null,
    contactPhone: input.phone?.trim() || null,
    email: null,
    address,
    unit,
    lossDate: null,
    lossType: input.job === "contents" || input.job === "reconstruction" ? null : input.job,
    causeOfLoss: null,
    receivedAt: null,
  };
  const saved = await createAssignmentFromFnol(`Manual entry (no FNOL).${notes ? `\nNotes: ${notes}` : ""}`, a);
  const { projectId, visitId } = await openProjectForAssignment(saved.assignment.id);
  await repo.updateVisitFields(projectId, visitId, { appointmentTime: time ? time.padStart(5, "0") : null, fieldNotes: notes });

  const seed = seedFromNotes(input.job, notes);
  const loc = await repo.insertLocation(projectId, { unit, room: seed.room ?? "Affected area (room TBD)" });
  const { lines: _l, decisions: _d, ...editable } = seed.scan;
  void _l;
  void _d;
  await saveRoomScan(projectId, visitId, loc.id, editable);
  return { projectId, visitId, locationId: loc.id, propertyId: saved.property.id, propertyCreated: saved.propertyCreated, understood: seed.understood };
}
