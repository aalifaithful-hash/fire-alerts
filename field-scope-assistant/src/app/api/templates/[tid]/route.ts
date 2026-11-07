import { route } from "@/lib/http";
import * as repo from "@/lib/repo";

export const DELETE = route<{ tid: string }>(async (_req, { tid }) => {
  await repo.deleteTemplate(tid);
  return { ok: true };
});
