import type { VisitFacts, VisitType } from "./schemas";

export interface Project {
  id: string;
  name: string;
  address: string;
  customer: string | null;
  contact: string | null;
  pm: string | null;
  jfcPma: string | null;
  lossDate: string | null;
  causeOfLoss: string | null;
  sourceStatus: string | null;
  lossType: string | null;
  category: string | null;
  waterClass: string | null;
  payer: string | null; // insurance | self_pay
  carrier: string | null;
  claimNumber: string | null;
  crewRequirements: string | null;
  productionDays: string | null;
  equipmentDays: string | null;
  accessRestrictions: string | null;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export const PROJECT_TEXT_FIELDS = [
  "name",
  "address",
  "customer",
  "contact",
  "pm",
  "jfcPma",
  "lossDate",
  "causeOfLoss",
  "sourceStatus",
  "lossType",
  "category",
  "waterClass",
  "payer",
  "carrier",
  "claimNumber",
  "crewRequirements",
  "productionDays",
  "equipmentDays",
  "accessRestrictions",
] as const;

export interface Visit {
  id: string;
  projectId: string;
  type: VisitType;
  visitDate: string; // YYYY-MM-DD, America/New_York
  appointmentTime: string | null; // scheduled time — separate from actual
  arrivalTime: string | null;
  departureTime: string | null;
  accessOutcome: string | null;
  fieldNotes: string;
  facts: VisitFacts;
  doc: import("./schemas").ScopeDoc | null;
  manualText: string | null; // PM free-text override of the rendered scope
  createdAt: string;
  updatedAt: string;
}

export interface DraftVersion {
  id: string;
  visitId: string;
  version: number;
  trigger: "generate" | "correction" | "manual_edit" | "restore" | "recommendation" | "checklist";
  input: string | null;
  changes: string[];
  text: string;
  createdAt: string;
}
