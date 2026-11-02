import { emptyFacts, type Equipment, type Location, type ScopeItem, type VisitFacts } from "@/lib/schemas";
import type { Project } from "@/lib/types";

let n = 0;
export const loc = (room: string, unit: string | null = null, floor: string | null = null, id?: string): Location => ({
  id: id ?? `loc_${++n}`,
  projectId: "p1",
  floor,
  unit,
  room,
  sort: n,
});

export const item = (over: Partial<ScopeItem> & Pick<ScopeItem, "text" | "category">): ScopeItem => ({
  id: `it_${++n}`,
  locationId: null,
  needsLocation: false,
  status: "reported",
  source: "pm",
  evidenceIds: [],
  carriedForward: false,
  carriedFromVisitId: null,
  quantity: null,
  flags: [],
  ...over,
});

export const equip = (over: Partial<Equipment> & Pick<Equipment, "type">): Equipment => ({
  id: `eq_${++n}`,
  locationId: null,
  label: null,
  quantity: null,
  status: "planned",
  statusDate: null,
  source: "pm",
  carriedForward: false,
  flags: [],
  ...over,
});

export const facts = (over: Partial<VisitFacts> = {}): VisitFacts => ({ ...emptyFacts(), ...over });

export const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "Test",
  address: "100 Main St, New York, NY",
  customer: null,
  contact: null,
  pm: null,
  jfcPma: null,
  lossDate: null,
  causeOfLoss: null,
  sourceStatus: null,
  lossType: null,
  category: null,
  waterClass: null,
  payer: null,
  carrier: null,
  claimNumber: null,
  crewRequirements: null,
  productionDays: null,
  equipmentDays: null,
  accessRestrictions: null,
  isDemo: false,
  createdAt: "",
  updatedAt: "",
  ...over,
});

export const visit = (type: import("@/lib/schemas").VisitType, visitDate = "2026-11-02") => ({
  type,
  visitDate,
  appointmentTime: null,
  arrivalTime: null,
  departureTime: null,
  accessOutcome: null,
});
