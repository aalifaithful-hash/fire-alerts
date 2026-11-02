import { body, route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { visitPayload } from "@/lib/payload";
import { rerender } from "@/lib/service";
import { VISIT_TYPES, type VisitType } from "@/lib/schemas";

type P = { pid: string; vid: string };
export const GET = route<P>(async (_req, { pid, vid }) => visitPayload(pid, vid));
export const PATCH = route<P>(async (req, { pid, vid }) => {
  const b = await body<Record<string, string | null>>(req);
  const patch: Record<string, string | null> = {};
  for (const k of Object.keys(repo.VISIT_EDITABLE)) if (k in b) patch[k] = b[k];
  if (patch.type && !VISIT_TYPES.includes(patch.type as VisitType)) delete patch.type;
  const before = repo.getVisit(pid, vid);
  repo.updateVisitFields(pid, vid, patch);
  // header fields and type affect the rendered document
  const affectsDoc = Object.keys(patch).some((k) => k !== "fieldNotes");
  if (affectsDoc && before.doc) rerender(pid, vid);
  return visitPayload(pid, vid);
});
export const DELETE = route<P>(async (_req, { pid, vid }) => {
  repo.deleteVisit(pid, vid);
  return { ok: true };
});
