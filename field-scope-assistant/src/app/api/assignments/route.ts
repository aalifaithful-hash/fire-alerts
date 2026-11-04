import { body, route } from "@/lib/http";
import { createAssignmentFromFnol, listAssignments, listProperties, openProjectForAssignment, type AssignmentInput } from "@/lib/intake";

export const GET = route(async () => {
  const [assignments, properties] = await Promise.all([listAssignments(), listProperties()]);
  const byId = new Map(properties.map((p) => [p.id, p]));
  return { assignments: assignments.map((a) => ({ ...a, rawText: undefined, property: byId.get(a.propertyId) ?? null })) };
});

export const POST = route(async (req) => {
  // Save = property (found or created) + assignment + its first visit, in one step.
  // openVisit:false keeps the older two-step behavior (assignment only).
  const b = await body<{ rawText?: string; input: AssignmentInput; openVisit?: boolean }>(req);
  const saved = await createAssignmentFromFnol(String(b.rawText ?? ""), b.input);
  if (b.openVisit === false) return { ...saved, projectId: null, visitId: null };
  const opened = await openProjectForAssignment(saved.assignment.id);
  return { ...saved, assignment: { ...saved.assignment, status: "linked" as const, projectId: opened.projectId }, ...opened };
});
