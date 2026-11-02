import { body, route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { rerender, UserError } from "@/lib/service";

type P = { pid: string; lid: string };
async function rerenderAll(pid: string) {
  for (const v of await repo.listVisits(pid)) if (v.doc) await rerender(pid, v.id);
}
export const PATCH = route<P>(async (req, { pid, lid }) => {
  const b = await body<{ floor?: string; unit?: string; room?: string }>(req);
  if (!b.room?.trim()) throw new UserError("Room name is required.");
  await repo.updateLocation(pid, lid, { floor: b.floor || null, unit: b.unit || null, room: b.room });
  await rerenderAll(pid);
  return { ok: true };
});
export const DELETE = route<P>(async (_req, { pid, lid }) => {
  await repo.deleteLocation(pid, lid);
  await rerenderAll(pid);
  return { ok: true };
});
