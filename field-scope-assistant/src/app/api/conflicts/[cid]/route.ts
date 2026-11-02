import { route } from "@/lib/http";
import * as repo from "@/lib/repo";

export const POST = route<{ cid: string }>(async (_req, { cid }) => {
  await repo.resolveConflict(cid);
  return { conflicts: await repo.listConflicts() };
});
