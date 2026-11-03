import { body, route } from "@/lib/http";
import { editEquipment } from "@/lib/service";
import { visitPayload } from "@/lib/payload";

type P = { pid: string; vid: string; eid: string };
export const PATCH = route<P>(async (req, { pid, vid, eid }) => {
  await editEquipment(pid, vid, eid, await body(req));
  return visitPayload(pid, vid);
});
