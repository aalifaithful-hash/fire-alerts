import { body, route } from "@/lib/http";
import { parseFnol } from "@/lib/fnol";
import { deadlinesFor, findPropertyByAddress, getRules, listAssignments, parseToInput } from "@/lib/intake";
import { UserError } from "@/lib/service";

// Rules-based parse of a pasted FNOL (no AI). Nothing is saved here.
export const POST = route(async (req) => {
  const { text } = await body<{ text?: string }>(req);
  const t = String(text ?? "").slice(0, 20000);
  if (!t.trim()) throw new UserError("Paste the FNOL text first.");
  const rules = await getRules();
  const parse = parseFnol(t, rules);
  const input = parseToInput(parse);
  const property = input.address ? await findPropertyByAddress(input.address, input.unit) : null;
  const history = property ? await listAssignments({ propertyId: property.id }) : [];
  return {
    parse,
    input,
    matchedProperty: property,
    propertyHistory: history.map((a) => ({ id: a.id, serviceLines: a.serviceLines, stage: a.stage, receivedAt: a.receivedAt, status: a.status, claimNumber: a.claimNumber })),
    deadlines: deadlinesFor({ receivedAt: input.receivedAt ? new Date(input.receivedAt).toISOString() : new Date().toISOString(), program: input.program }, rules),
  };
});
