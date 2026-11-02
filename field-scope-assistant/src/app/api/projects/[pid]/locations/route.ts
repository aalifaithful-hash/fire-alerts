import { body, route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { resolveLocation } from "@/lib/locations";
import { UserError } from "@/lib/service";

type P = { pid: string };
export const POST = route<P>(async (req, { pid }) => {
  repo.getProject(pid);
  const b = await body<{ floor?: string; unit?: string; room?: string }>(req);
  if (!b.room?.trim()) throw new UserError("Room name is required.");
  const r = resolveLocation({ floor: b.floor || null, unit: b.unit || null, room: b.room }, repo.listLocations(pid));
  if (r.kind === "existing" && (r.location.unit ?? "") === (b.unit ?? "") && (r.location.floor ?? "") === (b.floor ?? ""))
    throw new UserError("That room already exists.");
  return { location: repo.insertLocation(pid, { floor: b.floor || null, unit: b.unit || null, room: b.room }) };
});
