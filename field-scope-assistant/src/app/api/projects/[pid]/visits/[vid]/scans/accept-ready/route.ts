import { body, route } from "@/lib/http";
import { acceptReadyLines } from "@/lib/scans";

type P = { pid: string; vid: string };
// One tap: accept every suggested line that has a quantity, a justification and a source.
export const POST = route<P>(async (req, { pid, vid }) => {
  const b = await body<{ locationIds?: string[] }>(req);
  return acceptReadyLines(pid, vid, Array.isArray(b.locationIds) ? b.locationIds.map(String) : undefined);
});
