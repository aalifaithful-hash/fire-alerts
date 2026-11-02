import { route } from "@/lib/http";
import * as repo from "@/lib/repo";

type P = { pid: string; did: string };
export const DELETE = route<P>(async (_req, { pid, did }) => {
  repo.deleteDocument(pid, did);
  return { ok: true };
});
