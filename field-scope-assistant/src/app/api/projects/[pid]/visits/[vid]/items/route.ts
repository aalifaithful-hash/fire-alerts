import { body, route } from "@/lib/http";
import { addItem } from "@/lib/service";
import { visitPayload } from "@/lib/payload";

type P = { pid: string; vid: string };
export const POST = route<P>(async (req, { pid, vid }) => {
  const b = await body<{ locationId: string | null; category: string; text: string; status: string }>(req);
  await addItem(pid, vid, b);
  return visitPayload(pid, vid);
});
