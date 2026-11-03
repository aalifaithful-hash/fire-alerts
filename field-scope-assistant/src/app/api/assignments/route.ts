import { body, route } from "@/lib/http";
import { createAssignmentFromFnol, listAssignments, listProperties, type AssignmentInput } from "@/lib/intake";

export const GET = route(async () => {
  const [assignments, properties] = await Promise.all([listAssignments(), listProperties()]);
  const byId = new Map(properties.map((p) => [p.id, p]));
  return { assignments: assignments.map((a) => ({ ...a, rawText: undefined, property: byId.get(a.propertyId) ?? null })) };
});

export const POST = route(async (req) => {
  const b = await body<{ rawText?: string; input: AssignmentInput }>(req);
  return createAssignmentFromFnol(String(b.rawText ?? ""), b.input);
});
