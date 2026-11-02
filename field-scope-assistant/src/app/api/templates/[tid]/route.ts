import { route } from "@/lib/http";
import * as repo from "@/lib/repo";

export const DELETE = route<{ tid: string }>(async (_req, { tid }) => {
  repo.deleteTemplate(tid);
  return { ok: true };
});
