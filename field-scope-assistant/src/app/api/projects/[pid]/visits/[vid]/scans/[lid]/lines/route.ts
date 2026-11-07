import { body, route } from "@/lib/http";
import { decideLines } from "@/lib/scans";
import { UserError } from "@/lib/service";

type P = { pid: string; vid: string; lid: string };
// Accept / reject / reset proposed lines. Accepted lines join the scope.
export const POST = route<P>(async (req, { pid, vid, lid }) => {
  const b = await body<{ lineIds?: string[]; action?: string }>(req);
  if (!Array.isArray(b.lineIds) || !b.lineIds.length) throw new UserError("Choose at least one line.");
  if (!["accept", "reject", "reset"].includes(String(b.action))) throw new UserError("Unknown action.");
  return decideLines(pid, vid, lid, b.lineIds.map(String), b.action as "accept" | "reject" | "reset");
});
