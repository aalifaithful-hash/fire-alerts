import { body, route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { rerender, UserError } from "@/lib/service";

type P = { pid: string; lid: string };
function rerenderAll(pid: string) {
  for (const v of repo.listVisits(pid)) if (v.doc) rerender(pid, v.id);
}
export const PATCH = route<P>(async (req, { pid, lid }) => {
  const b = await body<{ floor?: string; unit?: string; room?: string }>(req);
  if (!b.room?.trim()) throw new UserError("Room name is required.");
  repo.updateLocation(pid, lid, { floor: b.floor || null, unit: b.unit || null, room: b.room });
  rerenderAll(pid);
  return { ok: true };
});
export const DELETE = route<P>(async (_req, { pid, lid }) => {
  repo.deleteLocation(pid, lid);
  rerenderAll(pid);
  return { ok: true };
});
