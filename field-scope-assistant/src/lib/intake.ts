import { query, queryOne } from "./db";
import { DEFAULT_RULES, mergeRules, validateSection, type Rules, type RulesSection } from "./defaults";
import { addressKey, outputTypeFor, SERVICE_LINES, VISIT_STAGES, type FnolParse, type ServiceLine, type VisitStage } from "./fnol";
import { newId } from "./ids";
import * as repo from "./repo";
import { nowIso, todayNY } from "./time";

/**
 * Properties (one per address + unit) with many assignments over time. An
 * assignment is the kind of work (service lines) plus the visit stage it was
 * received for, a special-assignment flag, the program, and its own history.
 * Assignments link to a project, where visits and scopes live. Project data
 * stays isolated: a property only lists its assignments/projects.
 */

export class IntakeError extends Error {}

// ---------------- rules (defaults + in-app overrides) ----------------

export async function getRules(): Promise<Rules> {
  const rows = await query<{ key: string; value: string }>`SELECT key, value FROM app_settings WHERE key LIKE 'rules.%'`;
  const overrides: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      overrides[r.key.slice("rules.".length)] = JSON.parse(r.value);
    } catch {
      /* ignore a corrupt row; defaults apply */
    }
  }
  return mergeRules(overrides as Partial<Record<RulesSection, unknown>>);
}

export async function getRulesState(): Promise<{ rules: Rules; overridden: RulesSection[] }> {
  const rows = await query<{ key: string }>`SELECT key FROM app_settings WHERE key LIKE 'rules.%'`;
  return { rules: await getRules(), overridden: rows.map((r) => r.key.slice(6) as RulesSection) };
}

export async function saveRulesSection(section: RulesSection, value: unknown): Promise<void> {
  if (!(section in DEFAULT_RULES)) throw new IntakeError("Unknown rules section.");
  const v = validateSection(section, value);
  if (!v.success) throw new IntakeError(`Invalid ${section}: ${v.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 300)}`);
  const key = `rules.${section}`;
  await query`INSERT INTO app_settings (key, value, updated_at) VALUES (${key}, ${JSON.stringify(v.data)}, ${nowIso()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
}

export async function resetRulesSection(section: RulesSection): Promise<void> {
  await query`DELETE FROM app_settings WHERE key = ${`rules.${section}`}`;
}

// ---------------- properties ----------------

export interface Property {
  id: string;
  addressKey: string;
  address: string;
  unit: string | null;
  yearBuilt: number | null;
  multiUnit: boolean;
  adjacentChecks: Record<string, string>; // above / below / beside → "checked — dry" etc.
  notes: string;
  createdAt: string;
  updatedAt: string;
}
type PropertyRow = {
  id: string; address_key: string; address: string; unit: string | null; year_built: number | null;
  multi_unit: number; adjacent_checks: string; notes: string; created_at: string; updated_at: string;
};
const toProperty = (r: PropertyRow): Property => ({
  id: r.id,
  addressKey: r.address_key,
  address: r.address,
  unit: r.unit,
  yearBuilt: r.year_built == null ? null : Number(r.year_built),
  multiUnit: !!Number(r.multi_unit),
  adjacentChecks: safeJson(r.adjacent_checks, {}),
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function listProperties(search?: string): Promise<(Property & { assignmentCount: number; lastReceived: string | null })[]> {
  const rows = await query<PropertyRow & { n: string; last: string | null }>`
    SELECT p.*, (SELECT COUNT(*) FROM assignments a WHERE a.property_id = p.id) AS n,
           (SELECT MAX(received_at) FROM assignments a WHERE a.property_id = p.id) AS last
    FROM properties p ORDER BY p.updated_at DESC`;
  const q = search?.trim().toLowerCase();
  return rows
    .filter((r) => !q || `${r.address} ${r.unit ?? ""}`.toLowerCase().includes(q))
    .map((r) => ({ ...toProperty(r), assignmentCount: Number(r.n), lastReceived: r.last }));
}

export async function getProperty(id: string): Promise<Property> {
  const r = await queryOne<PropertyRow>`SELECT * FROM properties WHERE id = ${id}`;
  if (!r) throw new repo.NotFound("Property not found.");
  return toProperty(r);
}

export async function findPropertyByAddress(address: string, unit: string | null): Promise<Property | null> {
  const r = await queryOne<PropertyRow>`SELECT * FROM properties WHERE address_key = ${addressKey(address, unit)}`;
  return r ? toProperty(r) : null;
}

export async function upsertProperty(input: { address: string; unit: string | null }): Promise<{ property: Property; created: boolean }> {
  const address = input.address.trim();
  if (!address) throw new IntakeError("A property address is required.");
  const existing = await findPropertyByAddress(address, input.unit);
  if (existing) return { property: existing, created: false };
  const id = newId("prp");
  const now = nowIso();
  await query`INSERT INTO properties (id, address_key, address, unit, created_at, updated_at)
    VALUES (${id}, ${addressKey(address, input.unit)}, ${address}, ${input.unit?.trim() || null}, ${now}, ${now})
    ON CONFLICT (address_key) DO NOTHING`;
  const p = await findPropertyByAddress(address, input.unit);
  if (!p) throw new IntakeError("Could not create the property.");
  return { property: p, created: p.id === id };
}

export async function updateProperty(
  id: string,
  patch: { yearBuilt?: number | null; multiUnit?: boolean; adjacentChecks?: Record<string, string>; notes?: string },
): Promise<Property> {
  const p = await getProperty(id);
  const year = patch.yearBuilt === undefined ? p.yearBuilt : patch.yearBuilt == null || Number.isNaN(patch.yearBuilt) ? null : Math.round(patch.yearBuilt);
  if (year != null && (year < 1700 || year > 2100)) throw new IntakeError("Year built looks wrong.");
  await query`UPDATE properties SET year_built = ${year},
      multi_unit = ${patch.multiUnit === undefined ? (p.multiUnit ? 1 : 0) : patch.multiUnit ? 1 : 0},
      adjacent_checks = ${JSON.stringify(patch.adjacentChecks ?? p.adjacentChecks)},
      notes = ${patch.notes ?? p.notes}, updated_at = ${nowIso()}
    WHERE id = ${id}`;
  return getProperty(id);
}

// ---------------- assignments ----------------

export interface AssignmentEvent {
  at: string;
  kind: "fnol" | "update" | "status" | "linked" | "visit_created" | "edited";
  text: string;
}

export interface Assignment {
  id: string;
  propertyId: string;
  projectId: string | null;
  serviceLines: ServiceLine[];
  contentsOnly: boolean;
  stage: VisitStage;
  special: boolean;
  specialReason: string | null;
  program: string | null;
  claimNumber: string | null;
  assignmentNumber: string | null;
  policyNumber: string | null;
  carrier: string | null;
  insured: string | null;
  contactPhone: string | null;
  email: string | null;
  lossDate: string | null;
  lossType: string | null;
  causeOfLoss: string | null;
  receivedAt: string;
  rawText: string;
  status: "new" | "accepted" | "linked" | "closed";
  history: AssignmentEvent[];
  createdAt: string;
  updatedAt: string;
}
type AssignmentRow = {
  id: string; property_id: string; project_id: string | null; service_lines: string; contents_only: number; stage: string;
  special: number; special_reason: string | null; program: string | null; claim_number: string | null;
  assignment_number: string | null; policy_number: string | null; carrier: string | null; insured: string | null;
  contact_phone: string | null; email: string | null; loss_date: string | null; loss_type: string | null;
  cause_of_loss: string | null; received_at: string; raw_text: string; status: string; history: string;
  created_at: string; updated_at: string;
};
const toAssignment = (r: AssignmentRow): Assignment => ({
  id: r.id,
  propertyId: r.property_id,
  projectId: r.project_id,
  serviceLines: safeJson<ServiceLine[]>(r.service_lines, []),
  contentsOnly: !!Number(r.contents_only),
  stage: r.stage as VisitStage,
  special: !!Number(r.special),
  specialReason: r.special_reason,
  program: r.program,
  claimNumber: r.claim_number,
  assignmentNumber: r.assignment_number,
  policyNumber: r.policy_number,
  carrier: r.carrier,
  insured: r.insured,
  contactPhone: r.contact_phone,
  email: r.email,
  lossDate: r.loss_date,
  lossType: r.loss_type,
  causeOfLoss: r.cause_of_loss,
  receivedAt: r.received_at,
  rawText: r.raw_text,
  status: r.status as Assignment["status"],
  history: safeJson<AssignmentEvent[]>(r.history, []),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The editable fields of an assignment, as reviewed by the PM before saving. */
export interface AssignmentInput {
  serviceLines: ServiceLine[];
  contentsOnly: boolean;
  stage: VisitStage;
  special: boolean;
  specialReason: string | null;
  program: string | null;
  claimNumber: string | null;
  assignmentNumber: string | null;
  policyNumber: string | null;
  carrier: string | null;
  insured: string | null;
  contactPhone: string | null;
  email: string | null;
  address: string;
  unit: string | null;
  lossDate: string | null;
  lossType: string | null;
  causeOfLoss: string | null;
  receivedAt: string | null;
}

/** Parser output → editable form values (PM reviews before saving). */
export function parseToInput(p: FnolParse): AssignmentInput {
  return {
    serviceLines: p.serviceLines.map((l) => l.value),
    contentsOnly: p.contentsOnly,
    stage: p.stage?.value ?? "initial_walkthrough",
    special: !!p.special?.value,
    specialReason: p.specialReason,
    program: p.program?.value ?? null,
    claimNumber: p.claimNumber?.value ?? null,
    assignmentNumber: p.assignmentNumber?.value ?? null,
    policyNumber: p.policyNumber?.value ?? null,
    carrier: p.carrier?.value ?? null,
    insured: p.insured?.value ?? null,
    contactPhone: p.contactPhone?.value ?? null,
    email: p.email?.value ?? null,
    address: p.address?.value ?? "",
    unit: p.unit?.value ?? null,
    lossDate: p.lossDate?.value ?? null,
    lossType: p.lossType?.value ?? null,
    causeOfLoss: p.causeOfLoss?.value ?? null,
    receivedAt: p.receivedAt?.value ?? null,
  };
}

function clean(input: AssignmentInput): AssignmentInput {
  const s = (v: unknown, max = 300) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, max));
  const lines = (Array.isArray(input.serviceLines) ? input.serviceLines : []).filter((l): l is ServiceLine =>
    (SERVICE_LINES as readonly string[]).includes(l),
  );
  const stage = (VISIT_STAGES as readonly string[]).includes(input.stage) ? input.stage : "initial_walkthrough";
  const lossDate = s(input.lossDate, 10);
  if (lossDate && !/^\d{4}-\d{2}-\d{2}$/.test(lossDate)) throw new IntakeError("Loss date must be YYYY-MM-DD.");
  return {
    serviceLines: [...new Set(lines)],
    contentsOnly: !!input.contentsOnly,
    stage,
    special: !!input.special,
    specialReason: s(input.specialReason, 1000),
    program: s(input.program),
    claimNumber: s(input.claimNumber, 60),
    assignmentNumber: s(input.assignmentNumber, 60),
    policyNumber: s(input.policyNumber, 60),
    carrier: s(input.carrier),
    insured: s(input.insured),
    contactPhone: s(input.contactPhone, 40),
    email: s(input.email, 120),
    address: String(input.address ?? "").trim().slice(0, 300),
    unit: s(input.unit, 20),
    lossDate,
    lossType: s(input.lossType, 40),
    causeOfLoss: s(input.causeOfLoss, 2000),
    receivedAt: s(input.receivedAt, 30),
  };
}

const describe = (a: AssignmentInput) =>
  `${a.serviceLines.join(" + ") || "service line not set"} · ${a.stage.replace(/_/g, " ")}${a.special ? " · SPECIAL" : ""}`;

/**
 * Saves a reviewed FNOL: finds or creates the property (by address + unit) and
 * adds a new assignment to it. Each FNOL is its own assignment, so one property
 * keeps its full history (EMS, then reconstruction, then a final walk-through…).
 */
export async function createAssignmentFromFnol(rawText: string, inputIn: AssignmentInput): Promise<{ assignment: Assignment; property: Property; propertyCreated: boolean }> {
  const input = clean(inputIn);
  if (!input.address) throw new IntakeError("A property address is required.");
  if (!input.serviceLines.length) throw new IntakeError("Choose at least one service line (EMS, mitigation, reconstruction or contents).");
  const { property, created } = await upsertProperty({ address: input.address, unit: input.unit });
  const id = newId("asg");
  const now = nowIso();
  const received = input.receivedAt ? new Date(input.receivedAt).toISOString() : now;
  const history: AssignmentEvent[] = [{ at: now, kind: "fnol", text: `FNOL received: ${describe(input)}` }];
  await query`INSERT INTO assignments (id, property_id, project_id, service_lines, contents_only, stage, special, special_reason, program,
      claim_number, assignment_number, policy_number, carrier, insured, contact_phone, email, loss_date, loss_type, cause_of_loss,
      received_at, raw_text, parsed, status, history, created_at, updated_at)
    VALUES (${id}, ${property.id}, NULL, ${JSON.stringify(input.serviceLines)}, ${input.contentsOnly ? 1 : 0}, ${input.stage},
      ${input.special ? 1 : 0}, ${input.specialReason}, ${input.program}, ${input.claimNumber}, ${input.assignmentNumber},
      ${input.policyNumber}, ${input.carrier}, ${input.insured}, ${input.contactPhone}, ${input.email}, ${input.lossDate},
      ${input.lossType}, ${input.causeOfLoss}, ${received}, ${rawText.slice(0, 20000)}, '{}', 'new', ${JSON.stringify(history)}, ${now}, ${now})`;
  await query`UPDATE properties SET updated_at = ${now} WHERE id = ${property.id}`;
  return { assignment: await getAssignment(id), property, propertyCreated: created };
}

export async function getAssignment(id: string): Promise<Assignment> {
  const r = await queryOne<AssignmentRow>`SELECT * FROM assignments WHERE id = ${id}`;
  if (!r) throw new repo.NotFound("Assignment not found.");
  return toAssignment(r);
}

export async function listAssignments(filter: { propertyId?: string; status?: string } = {}): Promise<Assignment[]> {
  const rows = filter.propertyId
    ? await query<AssignmentRow>`SELECT * FROM assignments WHERE property_id = ${filter.propertyId} ORDER BY received_at DESC`
    : await query<AssignmentRow>`SELECT * FROM assignments ORDER BY received_at DESC LIMIT 200`;
  return rows.map(toAssignment).filter((a) => !filter.status || a.status === filter.status);
}

/** Other assignments with the same claim number (e.g. the final walk-through for an earlier EMS). */
export async function relatedByClaim(a: Assignment): Promise<Assignment[]> {
  if (!a.claimNumber) return [];
  const rows = await query<AssignmentRow>`SELECT * FROM assignments WHERE claim_number = ${a.claimNumber} AND id <> ${a.id} ORDER BY received_at ASC`;
  return rows.map(toAssignment);
}

async function pushHistory(id: string, ev: Omit<AssignmentEvent, "at">, extra?: { status?: Assignment["status"]; projectId?: string | null }) {
  const a = await getAssignment(id);
  const history = [...a.history, { ...ev, at: nowIso() }];
  await query`UPDATE assignments SET history = ${JSON.stringify(history)},
      status = ${extra?.status ?? a.status}, project_id = ${extra?.projectId !== undefined ? extra.projectId : a.projectId},
      updated_at = ${nowIso()}
    WHERE id = ${id}`;
}

export async function addAssignmentNote(id: string, text: string) {
  if (!text.trim()) throw new IntakeError("Write the update first.");
  await pushHistory(id, { kind: "update", text: text.trim().slice(0, 2000) });
  return getAssignment(id);
}

export async function setAssignmentStatus(id: string, status: Assignment["status"]) {
  if (!["new", "accepted", "linked", "closed"].includes(status)) throw new IntakeError("Unknown status.");
  await pushHistory(id, { kind: "status", text: `Status → ${status}` }, { status });
  return getAssignment(id);
}

/** Edits after saving (wrong stage, add a service line…) are recorded in history. */
export async function editAssignment(id: string, patch: Partial<AssignmentInput>) {
  const a = await getAssignment(id);
  const merged = clean({
    ...a,
    address: "(unchanged)",
    unit: null,
    ...patch,
  } as AssignmentInput);
  const changed: string[] = [];
  for (const k of ["serviceLines", "contentsOnly", "stage", "special", "specialReason", "program", "claimNumber", "assignmentNumber", "carrier", "insured", "contactPhone", "lossDate", "lossType", "causeOfLoss"] as const)
    if (k in patch && JSON.stringify((a as unknown as Record<string, unknown>)[k]) !== JSON.stringify(merged[k])) changed.push(k);
  if (!changed.length) return a;
  await query`UPDATE assignments SET service_lines = ${JSON.stringify(merged.serviceLines)}, contents_only = ${merged.contentsOnly ? 1 : 0},
      stage = ${merged.stage}, special = ${merged.special ? 1 : 0}, special_reason = ${merged.specialReason}, program = ${merged.program},
      claim_number = ${merged.claimNumber}, assignment_number = ${merged.assignmentNumber}, carrier = ${merged.carrier},
      insured = ${merged.insured}, contact_phone = ${merged.contactPhone}, loss_date = ${merged.lossDate}, loss_type = ${merged.lossType},
      cause_of_loss = ${merged.causeOfLoss}, updated_at = ${nowIso()}
    WHERE id = ${id}`;
  await pushHistory(id, { kind: "edited", text: `Edited: ${changed.join(", ")}` });
  return getAssignment(id);
}

/**
 * Opens (or reuses) the project for an assignment and starts the first visit
 * with the right output type for service line + stage. Times are never copied.
 */
export async function openProjectForAssignment(id: string, opts: { projectId?: string | null } = {}) {
  const a = await getAssignment(id);
  const property = await getProperty(a.propertyId);
  let projectId = opts.projectId ?? a.projectId;
  if (projectId) await repo.getProject(projectId);
  else {
    const p = await repo.createProject({
      name: [property.address, property.unit ? `Unit ${property.unit}` : null].filter(Boolean).join(", "),
      address: [property.address, property.unit && !property.address.includes(property.unit) ? `Unit ${property.unit}` : null].filter(Boolean).join(", "),
      customer: a.insured,
      contact: a.contactPhone,
      lossDate: a.lossDate,
      causeOfLoss: a.causeOfLoss,
      lossType: a.lossType,
      carrier: a.carrier,
      claimNumber: a.claimNumber,
      payer: a.carrier ? "insurance" : null,
    });
    projectId = p.id;
  }
  const type = outputTypeFor(a.serviceLines, a.stage, a.contentsOnly);
  const visit = await repo.createVisit(projectId, {
    type,
    visitDate: todayNY(),
    stage: a.stage,
    serviceLine: a.serviceLines[0] ?? null,
  });
  await pushHistory(id, { kind: a.projectId ? "visit_created" : "linked", text: `${a.projectId ? "Visit started" : "Project opened"}: ${type.replace(/_/g, " ")}` }, {
    status: "linked",
    projectId,
  });
  return { projectId, visitId: visit.id };
}

export async function assignmentsForProject(projectId: string): Promise<Assignment[]> {
  const rows = await query<AssignmentRow>`SELECT * FROM assignments WHERE project_id = ${projectId} ORDER BY received_at ASC`;
  return rows.map(toAssignment);
}

// ---------------- program deadlines ----------------

export interface Deadline {
  label: string;
  due: string; // ISO
  hours: number;
}
/** Deadlines start at FNOL receipt; the program is matched by name, else the default program. */
export function deadlinesFor(a: Pick<Assignment, "receivedAt" | "program">, rules: Rules): { program: string; deadlines: Deadline[] } {
  const prog =
    rules.programs.find((p) => a.program && (p.name.toLowerCase() === a.program.toLowerCase() || p.keywords.some((k) => a.program!.toLowerCase().includes(k.toLowerCase())))) ??
    rules.programs.find((p) => p.name === "Default program") ??
    rules.programs[0];
  if (!prog) return { program: "none", deadlines: [] };
  const t0 = new Date(a.receivedAt).getTime();
  const at = (h: number) => new Date(t0 + h * 3600_000).toISOString();
  return {
    program: prog.name,
    deadlines: [
      { label: "Customer contact", hours: prog.contactWithinHours, due: at(prog.contactWithinHours) },
      { label: "On site", hours: prog.onSiteWithinHours, due: at(prog.onSiteWithinHours) },
      { label: "Estimate upload", hours: prog.estimateUploadWithinHours, due: at(prog.estimateUploadWithinHours) },
    ],
  };
}
