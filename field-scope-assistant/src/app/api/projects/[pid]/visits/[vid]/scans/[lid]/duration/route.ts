import { body, route } from "@/lib/http";
import { setLineDuration } from "@/lib/scans";

type P = { pid: string; vid: string; lid: string };
// The PM enters (or clears) an equipment line's run time in hours — shown as "entered by the PM".
export const POST = route<P>(async (req, { pid, vid, lid }) => {
  const b = await body<{ lineId?: string; hours?: number | null }>(req);
  return setLineDuration(pid, vid, lid, String(b.lineId ?? ""), b.hours == null || (b.hours as unknown) === "" ? null : Number(b.hours));
});
