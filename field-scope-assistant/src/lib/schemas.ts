import { z } from "zod";
import { Exclusion } from "./scan";

/**
 * Core domain model. "Facts" are the structured, validated source of truth for a
 * visit. Scope documents are always rendered from facts — never the reverse —
 * so prose can be regenerated without losing confirmed information.
 */

export const VISIT_TYPES = [
  "initial_assessment",
  "initial_mitigation",
  "kickoff",
  "daily_monitoring",
  "final_walkthrough",
  "reconstruction",
  "contents_cleaning",
  "checklist",
] as const;
export type VisitType = (typeof VISIT_TYPES)[number];

export const VISIT_TYPE_LABELS: Record<VisitType, string> = {
  initial_assessment: "Initial assessment",
  initial_mitigation: "Initial mitigation scope",
  kickoff: "Kickoff / crew work update",
  daily_monitoring: "Daily monitoring",
  final_walkthrough: "Final walk-through / completed mitigation",
  reconstruction: "Reconstruction scope",
  contents_cleaning: "Contents cleaning scope",
  checklist: "Checklist information",
};

/** Item lifecycle. "Applicable"/"proposed" never implies "completed". */
export const ITEM_STATUSES = [
  "reported", // PM reported a condition
  "observed", // visible in a photo / stated in a caption
  "proposed", // planned/recommended work, not yet approved
  "approved",
  "scheduled",
  "in_progress",
  "completed",
  "not_performed",
  "unknown",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Where a fact came from. Only PM-originated sources can confirm completion. */
export const SOURCES = [
  "pm", // PM field notes or correction for this visit
  "pm_accepted", // AI recommendation explicitly accepted by the PM
  "manual_edit", // PM edited the bullet directly
  "photo", // visible in a photograph
  "caption", // CompanyCam caption / description text
  "prior_visit", // carried from an earlier visit record
] as const;
export type Source = (typeof SOURCES)[number];
export const PM_SOURCES: Source[] = ["pm", "pm_accepted", "manual_edit"];

export const CATEGORIES = [
  // observations
  "condition",
  "moisture_elevated",
  "moisture_dry",
  "reading",
  "change",
  // mitigation work, in required output order
  "extraction",
  "removal",
  "detach_reset",
  "cavity_access",
  "cleaning",
  "antimicrobial",
  "contents",
  "floor_protection",
  "containment",
  "drying",
  "monitoring",
  // reconstruction
  "repair",
  "replacement",
  "finish",
  "painting",
  "sequencing",
  "access",
  // admin
  "forms",
  "schedule",
  "note",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const EQUIPMENT_TYPES = [
  "air_mover",
  "dehumidifier",
  "air_scrubber",
  "negative_air_machine",
  "heater",
  "drying_mat",
  "other",
] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export const EQUIPMENT_STATUSES = [
  "planned",
  "installed",
  "operating",
  "pickup_scheduled",
  "removed",
  "unknown",
] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export const SOURCE_STATUSES = ["repaired", "stopped", "active", "unknown"] as const;

export const ScopeItem = z.object({
  id: z.string(),
  locationId: z.string().nullable(), // null = project-wide / unassigned
  needsLocation: z.boolean().default(false), // AI could not place it confidently
  category: z.enum(CATEGORIES),
  text: z.string(),
  status: z.enum(ITEM_STATUSES),
  source: z.enum(SOURCES),
  evidenceIds: z.array(z.string()).default([]),
  carriedForward: z.boolean().default(false),
  carriedFromVisitId: z.string().nullable().default(null),
  quantity: z.string().nullable().default(null), // only when supplied
  flags: z.array(z.string()).default([]),
});
export type ScopeItem = z.infer<typeof ScopeItem>;

export const Equipment = z.object({
  id: z.string(),
  locationId: z.string().nullable(),
  type: z.enum(EQUIPMENT_TYPES),
  label: z.string().nullable().default(null),
  quantity: z.number().int().nullable(), // null = not supplied; never invented
  status: z.enum(EQUIPMENT_STATUSES),
  statusDate: z.string().nullable().default(null),
  source: z.enum(SOURCES),
  carriedForward: z.boolean().default(false),
  flags: z.array(z.string()).default([]),
});
export type Equipment = z.infer<typeof Equipment>;

export const Question = z.object({
  id: z.string(),
  text: z.string(),
  reason: z.string().nullable().default(null),
  locationId: z.string().nullable().default(null),
  status: z.enum(["open", "answered", "dismissed"]).default("open"),
  answer: z.string().nullable().default(null),
});
export type Question = z.infer<typeof Question>;

export const Recommendation = z.object({
  id: z.string(),
  locationId: z.string().nullable(),
  category: z.enum(CATEGORIES),
  text: z.string(),
  rationale: z.string().nullable().default(null),
  status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
});
export type Recommendation = z.infer<typeof Recommendation>;

export const CHECKLIST_STATUSES = [
  "applicable",
  "completed",
  "pending",
  "not_applicable",
  "not_documented",
] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

export const ChecklistEntry = z.object({
  itemId: z.string(),
  label: z.string(),
  status: z.enum(CHECKLIST_STATUSES),
  note: z.string().nullable().default(null),
  evidenceQuote: z.string().nullable().default(null),
});
export type ChecklistEntry = z.infer<typeof ChecklistEntry>;

export const JobInfo = z.object({
  causeOfLoss: z.string().nullable().default(null),
  sourceStatus: z.enum(SOURCE_STATUSES).nullable().default(null),
  lossType: z.string().nullable().default(null),
  category: z.string().nullable().default(null), // water category, only if confirmed
  waterClass: z.string().nullable().default(null),
  crewRaw: z.string().nullable().default(null), // e.g. "CC+4"
  crewChiefs: z.number().int().nullable().default(null),
  subcontractors: z.number().int().nullable().default(null),
  productionDays: z.string().nullable().default(null),
  equipmentDays: z.string().nullable().default(null),
  accessRestrictions: z.string().nullable().default(null),
});
export type JobInfo = z.infer<typeof JobInfo>;

export const VisitFacts = z.object({
  jobInfo: JobInfo.default(JobInfo.parse({})),
  directives: z
    .object({
      dryingOnly: z.boolean().default(false),
      carryForwardConfirmed: z.boolean().default(false),
    })
    .default({ dryingOnly: false, carryForwardConfirmed: false }),
  items: z.array(ScopeItem).default([]),
  equipment: z.array(Equipment).default([]),
  questions: z.array(Question).default([]),
  recommendations: z.array(Recommendation).default([]),
  checklist: z
    .object({ templateId: z.string().nullable(), entries: z.array(ChecklistEntry) })
    .nullable()
    .default(null),
  reviewFlags: z.array(z.string()).default([]),
  /** Customer-preference / scope exclusions — recorded explicitly, never silent. */
  exclusions: z.array(Exclusion).default([]),
  /** Reconstruction estimate is written only when this is on. */
  reconstructionRequested: z.boolean().default(false),
});
export type VisitFacts = z.infer<typeof VisitFacts>;

export function emptyFacts(): VisitFacts {
  return VisitFacts.parse({});
}

export interface Location {
  id: string;
  projectId: string;
  floor: string | null;
  unit: string | null;
  room: string;
  sort: number;
}

/** A rendered document: deterministic output of facts + visit + project. */
export interface ScopeDoc {
  title: string;
  header: { label: string; value: string }[];
  sections: ScopeSection[];
  footer: string[];
}
export interface ScopeSection {
  level: 1 | 2 | 3; // 1 floor, 2 room heading, 3 sub-heading
  heading: string;
  locationId?: string | null;
  bullets: ScopeBullet[];
}
export interface ScopeBullet {
  text: string;
  itemId?: string;
  equipmentId?: string;
}

export interface ChangeSummary {
  changes: string[];
  rejected: string[];
}
