import * as repo from "./repo";
import { checklistDoc } from "./service";
import { docToSlack, docToText } from "./render";

/** Everything the scope screen needs for one visit. */
export async function visitPayload(projectId: string, visitId: string) {
  const visit = await repo.getVisit(projectId, visitId);
  const drafts = await repo.listDrafts(projectId, visitId);
  const text = visit.manualText ?? (visit.doc ? docToText(visit.doc) : "");
  const slack = visit.manualText ?? (visit.doc ? docToSlack(visit.doc) : "");
  return { visit, drafts, text, slack, checklist: await checklistDoc(projectId, visit), lastChanges: drafts[0]?.changes ?? [], lastTrigger: drafts[0]?.trigger ?? null };
}

export async function workspacePayload(projectId: string) {
  const project = await repo.getProject(projectId);
  const locations = await repo.listLocations(projectId);
  const documents = await repo.listDocuments(projectId);
  const evidence = await repo.listEvidence(projectId);
  const visits = await repo.listVisits(projectId);
  const templates = await repo.listTemplates();
  return {
    project,
    locations,
    documents,
    evidence,
    visits: visits.map((v) => ({
      id: v.id,
      type: v.type,
      visitDate: v.visitDate,
      appointmentTime: v.appointmentTime,
      accessOutcome: v.accessOutcome,
      hasDraft: !!v.doc,
      updatedAt: v.updatedAt,
    })),
    templates,
  };
}
