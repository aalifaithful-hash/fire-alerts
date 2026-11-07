import { body, route } from "@/lib/http";
import { deadlinesFor, editAssignment, getAssignment, getProperty, getRules, listAssignments, relatedByClaim, type AssignmentInput } from "@/lib/intake";

type P = { aid: string };
export const GET = route<P>(async (_req, { aid }) => {
  const assignment = await getAssignment(aid);
  const [property, sameClaim, rules] = await Promise.all([getProperty(assignment.propertyId), relatedByClaim(assignment), getRules()]);
  const propertyHistory = await listAssignments({ propertyId: property.id });
  return { assignment, property, sameClaim, propertyHistory, deadlines: deadlinesFor(assignment, rules) };
});
export const PATCH = route<P>(async (req, { aid }) => ({ assignment: await editAssignment(aid, await body<Partial<AssignmentInput>>(req)) }));
