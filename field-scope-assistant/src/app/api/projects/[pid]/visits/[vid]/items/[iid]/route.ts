import { body, route } from "@/lib/http";
import { editItem } from "@/lib/service";
import { visitPayload } from "@/lib/payload";

type P = { pid: string; vid: string; iid: string };
export const PATCH = route<P>(async (req, { pid, vid, iid }) => {
  editItem(pid, vid, iid, await body(req));
  return visitPayload(pid, vid);
});
