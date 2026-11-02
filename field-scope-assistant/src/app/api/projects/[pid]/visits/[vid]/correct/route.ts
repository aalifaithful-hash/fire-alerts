import { body, route } from "@/lib/http";
import { correctVisit } from "@/lib/service";
import { visitPayload } from "@/lib/payload";

type P = { pid: string; vid: string };
export const maxDuration = 300;
export const POST = route<P>(async (req, { pid, vid }) => {
  const { text } = await body<{ text: string }>(req);
  const r = await correctVisit(pid, vid, String(text ?? "").slice(0, 8000));
  return { result: r.kind === "applied" ? { kind: r.kind, changes: r.changes, rejected: r.rejected } : r, ...visitPayload(pid, vid) };
});
