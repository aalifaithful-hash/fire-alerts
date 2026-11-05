import { body, route } from "@/lib/http";
import { setLineQuantity } from "@/lib/scans";

type P = { pid: string; vid: string; lid: string };
// The PM enters (or clears) a line's quantity — shown as "entered by the PM".
export const POST = route<P>(async (req, { pid, vid, lid }) => {
  const b = await body<{ lineId?: string; quantity?: number | null }>(req);
  return setLineQuantity(pid, vid, lid, String(b.lineId ?? ""), b.quantity == null || (b.quantity as unknown) === "" ? null : Number(b.quantity));
});
