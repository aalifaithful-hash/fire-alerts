import * as repo from "./repo";
import { assignmentsForProject } from "./intake";
import { ADDRESS_MISMATCH, checklistDoc, galleryAddressCheck } from "./service";
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
  // Galleries stored before the address check existed get checked (once) when the project opens.
  for (const d of documents) {
    if (d.kind === "mold_report" || d.error?.includes(ADDRESS_MISMATCH)) continue; // reports have their own "Wrong report?" check
    const pages = (await repo.getPages(d.id, 1, 3)).map((p) => p.text);
    const check = galleryAddressCheck(project.address || project.name, [d.filename.replace(/[_-]+/g, " "), ...pages]);
    if (!check.mismatch) continue;
    d.error = [check.mismatch, d.error].filter(Boolean).join(" ");
    await repo.setDocumentStatus(projectId, d.id, d.status, d.error);
  }
  const evidence = await repo.listEvidence(projectId);
  const visits = await repo.listVisits(projectId);
  const templates = await repo.listTemplates();
  const assignments = (await assignmentsForProject(projectId)).map((a) => ({ ...a, rawText: undefined }));
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
      stage: v.stage,
      serviceLine: v.serviceLine,
      updatedAt: v.updatedAt,
    })),
    templates,
    assignments,
  };
}
