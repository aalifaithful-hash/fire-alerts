import type { Location, ScopeDoc, VisitType } from "@/lib/schemas";
import type { DraftVersion, Project, Visit } from "@/lib/types";
import type { ChecklistTemplate, Document, Evidence } from "@/lib/repo";

export interface WorkspaceData {
  project: Project;
  locations: Location[];
  documents: (Document & { progress: { total: number; done: number; failed: number; pending: number; errors: string[] }; textPages: number; extractedPages: number })[];
  evidence: Evidence[];
  visits: { id: string; type: VisitType; visitDate: string; appointmentTime: string | null; accessOutcome: string | null; hasDraft: boolean; updatedAt: string }[];
  templates: ChecklistTemplate[];
}

export interface VisitData {
  visit: Visit;
  drafts: DraftVersion[];
  text: string;
  slack: string;
  checklist: { doc: ScopeDoc; text: string } | null;
  lastChanges: string[];
  lastTrigger: string | null;
  result?: { kind: "applied"; changes: string[]; rejected: string[] } | { kind: "clarify"; clarification: string } | { kind: "show_full" };
}
