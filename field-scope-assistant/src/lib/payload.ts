import * as repo from "./repo";
import { checklistDoc } from "./service";
import { docToSlack, docToText } from "./render";

/** Everything the scope screen needs for one visit. */
export function visitPayload(projectId: string, visitId: string) {
  const visit = repo.getVisit(projectId, visitId);
  const drafts = repo.listDrafts(projectId, visitId);
  const text = visit.manualText ?? (visit.doc ? docToText(visit.doc) : "");
  const slack = visit.manualText ?? (visit.doc ? docToSlack(visit.doc) : "");
  return { visit, drafts, text, slack, checklist: checklistDoc(projectId, visit), lastChanges: drafts[0]?.changes ?? [], lastTrigger: drafts[0]?.trigger ?? null };
}

export function workspacePayload(projectId: string) {
  return {
    project: repo.getProject(projectId),
    locations: repo.listLocations(projectId),
    documents: repo.listDocuments(projectId),
    evidence: repo.listEvidence(projectId),
    visits: repo.listVisits(projectId).map((v) => ({
      id: v.id,
      type: v.type,
      visitDate: v.visitDate,
      appointmentTime: v.appointmentTime,
      accessOutcome: v.accessOutcome,
      hasDraft: !!v.doc,
      updatedAt: v.updatedAt,
    })),
    templates: repo.listTemplates(),
  };
}
