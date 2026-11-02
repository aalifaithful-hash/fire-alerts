import { route } from "@/lib/http";
import * as repo from "@/lib/repo";

export const POST = route<{ cid: string }>(async (_req, { cid }) => {
  repo.resolveConflict(cid);
  return { conflicts: repo.listConflicts() };
});
