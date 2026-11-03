import { body, route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { VISIT_TYPES, type VisitType } from "@/lib/schemas";
import { UserError } from "@/lib/service";

export const GET = route(async () => ({ templates: await repo.listTemplates() }));
export const POST = route(async (req) => {
  const b = await body<{ id?: string; name: string; visitTypes: string[]; items: string[] }>(req);
  if (!b.name?.trim()) throw new UserError("Template name is required.");
  const items = (b.items ?? []).map(String).filter((s) => s.trim());
  if (!items.length) throw new UserError("Add at least one checklist item.");
  return {
    template: await repo.saveTemplate({
      id: b.id || undefined,
      name: b.name,
      visitTypes: (b.visitTypes ?? []).filter((t): t is VisitType => VISIT_TYPES.includes(t as VisitType)),
      items,
    }),
  };
});
