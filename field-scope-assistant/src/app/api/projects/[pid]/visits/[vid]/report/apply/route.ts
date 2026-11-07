import { body, route } from "@/lib/http";
import { applyReport } from "@/lib/report/service";

type P = { pid: string; vid: string };
// Applies the chosen report findings to the room scan; the lines come back as suggested for the PM to accept.
export const POST = route<P>(async (req, { pid, vid }) => {
  const b = await body<{ documentId?: string; keys?: string[] }>(req);
  return applyReport(pid, vid, String(b.documentId ?? ""), Array.isArray(b.keys) ? b.keys.map(String) : []);
});
