import { body, route } from "@/lib/http";
import * as repo from "@/lib/repo";

type P = { pid: string; eid: string };
export const PATCH = route<P>(async (req, { pid, eid }) => {
  const b = await body<{ locationId: string | null }>(req);
  repo.setEvidenceLocation(pid, eid, b.locationId || null);
  return { ok: true };
});
